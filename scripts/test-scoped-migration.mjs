#!/usr/bin/env node
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, copyFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const server = join(root, 'storage', 'server.mjs')
const temp = mkdtempSync(join(tmpdir(), 'monitor-scope-'))
let passed = 0
function check(label, fn) { fn(); passed++; console.log(`  ✓ ${label}`) }

// Build a synthetic v8 file from the still-compatible legacy DDL, without importing
// the live server (which would start its stdin protocol loop).
const source = readFileSync(server, 'utf8')
const proxyText = source.match(/const PROXY_COLUMNS = (\[[\s\S]*?\n\])/)[1]
const ddlText = source.match(/const DDL = `([\s\S]*?)`\n\nconst REQUEST_COLUMNS/)[1]
const proxyColumns = Function(`return ${proxyText}`)()
const legacyDDL = Function('PROXY_COLUMNS', `return \`${ddlText}\``)(proxyColumns)

function client() {
  const child = spawn(process.execPath, ['--no-warnings', server], { stdio: ['pipe', 'pipe', 'pipe'] })
  let carry = '', next = 1
  const pending = new Map()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    carry += chunk
    let index
    while ((index = carry.indexOf('\n')) >= 0) {
      const line = carry.slice(0, index); carry = carry.slice(index + 1)
      if (!line) continue
      const msg = JSON.parse(line)
      const resolve = pending.get(msg.id)
      if (resolve) { pending.delete(msg.id); resolve(msg) }
    }
  })
  return {
    async send(op, args = {}) {
      const id = next++
      const result = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${op} timed out`)) }, 10000)
        pending.set(id, message => { clearTimeout(timer); resolve(message) })
      })
      child.stdin.write(JSON.stringify({ id, op, args }) + '\n')
      return result
    },
    async close() { child.stdin.end(); await new Promise(resolve => child.once('exit', resolve)) }
  }
}

try {
  const path = join(temp, 'legacy.db')
  const old = new DatabaseSync(path)
  old.exec(legacyDDL)
  old.prepare('INSERT INTO meta(k,v) VALUES (?,?)').run('schema_version', '8')
  old.prepare('INSERT INTO instances(started_at) VALUES (?)').run(1)
  old.prepare('INSERT INTO requests(inst,seq,key,request_id,url,method,start_ts,body_hash) VALUES (?,?,?,?,?,?,?,?)')
    .run(1, 7, 'old', 'req-7', 'https://example.test/', 'GET', 1, 'abc123')
  old.prepare('INSERT INTO cookies(key,name,domain,host,first_seen,last_seen) VALUES (?,?,?,?,?,?)')
    .run('session|example.test', 'session', 'example.test', 'example.test', 1, 1)
  old.prepare('INSERT INTO site_origins(origin,first_seen,updated_at) VALUES (?,?,?)')
    .run('https://example.test', 1, 1)
  old.close()

  const a = client()
  const opened = await a.send('open', { dbPath: path, config: { workspaceId: 'default', profileId: 'primary' } })
  check('v8→scoped schema open', () => { assert.equal(opened.ok, true); assert.ok(opened.result.schemaVersion >= 9) })
  const bad = await a.send('queryRequests', { workspaceId: 'other', inst: 1 })
  check('cross-workspace query rejected', () => { assert.equal(bad.ok, false); assert.match(bad.error, /scope mismatch/) })
  const good = await a.send('queryRequests', { workspaceId: 'default', inst: 1 })
  check('legacy request remains readable', () => assert.equal(good.ok, true))
  await a.close()

  const migrated = new DatabaseSync(path)
  check('core rows have explicit owner', () => {
    for (const table of ['requests', 'cookies', 'site_origins']) {
      const row = migrated.prepare(`SELECT workspace_id, profile_id FROM ${table} LIMIT 1`).get()
      assert.equal(row.workspace_id, 'default'); assert.equal(row.profile_id, 'primary')
    }
  })
  check('legacy body ref and inst/seq preserved', () => {
    const row = migrated.prepare('SELECT * FROM body_refs').get()
    assert.equal(row.inst, 1); assert.equal(row.seq, 7); assert.equal(row.hash, 'abc123')
  })
  check('foreign key valid', () => assert.equal(migrated.prepare('PRAGMA foreign_key_check').all().length, 0))
  check('migration checksum recorded', () => assert.match(migrated.prepare('SELECT checksum FROM schema_migrations WHERE version=9').get().checksum, /^[a-f0-9]{64}$/))
  migrated.close()

  const backup = readdirSync(temp).find(name => name.startsWith('legacy.db.pre-v9-') && name.endsWith('.bak'))
  check('consistent v8 backup made', () => assert.ok(backup))
  const backupDb = new DatabaseSync(join(temp, backup))
  check('backup contains recoverable legacy row', () => {
    assert.equal(backupDb.prepare("SELECT v FROM meta WHERE k='schema_version'").get().v, '8')
    assert.equal(backupDb.prepare('SELECT seq FROM requests').get().seq, 7)
  })
  backupDb.close()

  const again = client()
  const reopened = await again.send('open', { dbPath: path, config: { workspaceId: 'default', profileId: 'primary' } })
  check('repeat migration is idempotent', () => assert.equal(reopened.ok, true))
  await again.close()
  const wrongOwner = client()
  const refused = await wrongOwner.send('open', { dbPath: path, config: { workspaceId: 'other', profileId: 'primary' } })
  check('database cannot be opened as another workspace', () => { assert.equal(refused.ok, false); assert.match(refused.error, /scope mismatch/) })
  await wrongOwner.close()

  const restored = join(temp, 'restored.db')
  copyFileSync(join(temp, backup), restored)
  const recovery = client()
  const recovered = await recovery.send('open', { dbPath: restored, config: { workspaceId: 'default', profileId: 'primary' } })
  check('v8 backup can be migrated again', () => assert.equal(recovered.ok, true))
  await recovery.close()

  const v9path = join(temp, 'v9.db')
  const sourceDb = new DatabaseSync(path)
  sourceDb.exec(`VACUUM INTO '${v9path.replaceAll("'", "''")}'`)
  sourceDb.close()
  const v9 = new DatabaseSync(v9path)
  v9.exec('DROP TABLE extension_scans; DROP TABLE extension_observed; DROP TABLE extension_desired; DELETE FROM schema_migrations WHERE version=11; DROP TABLE auth_observations; DROP TABLE site_identities; DELETE FROM schema_migrations WHERE version=10; UPDATE meta SET v=\'9\' WHERE k=\'schema_version\'')
  v9.close()
  const upgrade = client()
  const upgraded = await upgrade.send('open', { dbPath: v9path, config: { workspaceId: 'default', profileId: 'primary' } })
  check('v9→v10 auth and v11 extension migrations are applied', () => assert.equal(upgraded.result?.schemaVersion, 11))
  await upgrade.close()
  check('v9 backup is created before auth migration', () => assert(readdirSync(temp).some(name => name.startsWith('v9.db.pre-v10-'))))
  const v10path = join(temp, 'v10.db')
  const latest = new DatabaseSync(path)
  latest.exec(`VACUUM INTO '${v10path.replaceAll("'", "''")}'`)
  latest.close()
  const v10 = new DatabaseSync(v10path)
  v10.exec("DROP TABLE extension_scans; DROP TABLE extension_observed; DROP TABLE extension_desired; DELETE FROM schema_migrations WHERE version=11; UPDATE meta SET v='10' WHERE k='schema_version'")
  v10.close()
  const extensionUpgrade = client()
  const extensionOpened = await extensionUpgrade.send('open', { dbPath: v10path, config: { workspaceId: 'default', profileId: 'primary' } })
  check('v10→v11 extension migration applied', () => assert.equal(extensionOpened.result?.schemaVersion, 11))
  await extensionUpgrade.close()
  check('v10 backup created before extension migration', () => assert(readdirSync(temp).some(name => name.startsWith('v10.db.pre-v11-'))))
  console.log(`\n${passed}/${passed} passed`)
} finally {
  if (!resolve(temp).startsWith(resolve(tmpdir()) + '\\')) throw new Error('unsafe temp cleanup')
  rmSync(temp, { recursive: true, force: true })
}
