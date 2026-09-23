#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createInterface } from 'node:readline'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startOrigin } from './test-origin.mjs'
import { launchApp, makeChecker, sleep } from './app-harness.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const temp = mkdtempSync(join(tmpdir(), 'monitor-extensions-'))
const origin = await startOrigin(0)
const { check, assert, report } = makeChecker()
let app, mcp
async function endpoint() {
  for (let i = 0; i < 100; i += 1) {
    const path = join(temp, 'control.json')
    if (existsSync(path)) { try { const value = JSON.parse(readFileSync(path, 'utf8')); if (value.port && value.token) return value } catch {} }
    await sleep(100)
  }
  throw new Error('control endpoint unavailable')
}
async function api(method, path, body) {
  const info = await endpoint()
  const response = await fetch(`http://127.0.0.1:${info.port}${path}`, { method,
    headers: { authorization: `Bearer ${info.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, body: await response.json() }
}
function mcpClient() {
  const child = spawn(process.execPath, [join(root, 'mcp', 'server.mjs'), `--data-dir=${temp}`], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
  let next = 1; const pending = new Map()
  createInterface({ input: child.stdout }).on('line', line => { let msg; try { msg = JSON.parse(line) } catch { return }; const done = pending.get(msg.id); if (done) { pending.delete(msg.id); done(msg) } })
  return { child, send(method, params) { const id = next++; const response = new Promise(resolve => pending.set(id, resolve)); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); return response },
    async call(name, args) { const result = await this.send('tools/call', { name, arguments: args }); if (result.result?.isError) throw new Error(JSON.stringify(result.result.content)); return JSON.parse(result.result.content[0].text) } }
}
async function waitReport(version) {
  for (let i = 0; i < 70; i += 1) {
    const found = origin.extensionReports.find(row => row.version === version)
    if (found) return found
    await sleep(200)
  }
  throw new Error(`extension ${version} did not report`)
}
try {
  for (const [profile, version] of [['L', '1.0.0'], ['H', '2.0.0']]) {
    const dir = join(temp, `fixture-${profile}`)
    cpSync(join(root, 'fixtures', 'extensions', 'state-probe'), dir, { recursive: true })
    const manifestPath = join(dir, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.version = version
    if (profile === 'H') manifest.permissions = ['management', 'storage', 'tabs']
    writeFileSync(manifestPath, JSON.stringify(manifest))
    writeFileSync(join(dir, 'config.js'), `self.MONITOR_REPORT_URL = ${JSON.stringify(`http://127.0.0.1:${origin.port}/extension-report`)}\n`)
  }
  app = await launchApp({ url: `http://127.0.0.1:${origin.port}/dom-probe.html`, dataDir: temp, port: 9553,
    extraEnv: { CHROME_PATH: process.env['EXTENSION_BROWSER_PATH'] ?? '', MONITOR_MAX_ACTIVE_WORKSPACES: '2',
      MONITOR_TEST_EXTENSION_DIR_L: join(temp, 'fixture-L'), MONITOR_TEST_EXTENSION_DIR_H: join(temp, 'fixture-H') } })
  await app.waitConnected(1)
  const aReport = await waitReport('1.0.0')
  const a = await api('GET', '/workspaces/default/extensions')
  check('A profile observes controlled extension with version and permissions', () => {
    const item = a.body.output?.items?.find(row => row.extensionId === aReport.extensionId)
    assert(item?.observed?.version === '1.0.0' && item.observed.permissions.includes('management'), JSON.stringify(a.body))
    assert(a.body.output.scan.complete === 0 && a.body.output.scan.observed_at > 0)
  })
  const desiredA = await api('POST', '/workspaces/default/extensions/desired', { extensionId: aReport.extensionId, version: '9.0.0', permissions: ['management'] })
  check('version/permission mismatch produces drift without changing extension', () => {
    const item = desiredA.body.output?.items?.find(row => row.extensionId === aReport.extensionId)
    assert(item?.state === 'drift' && item.reasons.includes('version_mismatch') && item.reasons.includes('permissions_mismatch'), JSON.stringify(item))
  })
  const missingId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const missing = await api('POST', '/workspaces/default/extensions/desired', { extensionId: missingId, version: '1.0.0' })
  check('partial profile scan treats missing expected extension as unknown', () => assert(missing.body.output?.items?.find(row => row.extensionId === missingId)?.state === 'unknown'))
  const created = await app.evaluate("window.monitor.createWorkspace({name:'Extension B',profile:'H'})")
  const bId = created.output?.id
  assert(bId, JSON.stringify(created))
  await app.evaluate(`window.monitor.openWorkspace(${JSON.stringify(bId)})`)
  const bReport = await waitReport('2.0.0')
  const b = await api('GET', `/workspaces/${encodeURIComponent(bId)}/extensions`)
  check('A/B profiles retain distinct extension state', () => {
    assert(b.body.output?.items?.some(row => row.extensionId === bReport.extensionId && row.observed.version === '2.0.0'), JSON.stringify(b.body))
    assert(!b.body.output?.items?.some(row => row.extensionId === aReport.extensionId))
    assert(aReport.extensionId !== bReport.extensionId)
  })
  const cross = await api('GET', '/workspaces/not-a-workspace/extensions')
  check('unknown workspace is rejected', () => assert(!cross.body.output))
  mcp = mcpClient()
  await mcp.send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'extension-test', version: '1' } })
  const fromMcp = await mcp.call('monitor_extensions', { workspaceId: bId })
  check('MCP and HTTP return same scoped summary', () => {
    const shape = rows => rows?.map(row => ({ id: row.extensionId, version: row.observed?.version, state: row.state })).sort((a, b) => a.id.localeCompare(b.id))
    assert(JSON.stringify(shape(fromMcp.output?.items)) === JSON.stringify(shape(b.body.output?.items)))
  })
  await sleep(2500)
  const ui = await app.evaluate('document.body.innerText')
  check('UI renders observed B extension', () => assert(ui.includes('2.0.0'), ui.slice(0, 700)))
  await api('POST', `/workspaces/${encodeURIComponent(bId)}/suspend`)
  await api('POST', `/workspaces/${encodeURIComponent(bId)}/open`)
  const after = await api('GET', `/workspaces/${encodeURIComponent(bId)}/extensions`)
  check('restart re-observes extension and preserves scoped state', () => assert(after.body.output?.items?.some(row => row.extensionId === bReport.extensionId && row.observed.version === '2.0.0')))
  const db = new DatabaseSync(join(temp, 'workspaces', bId, 'monitor.db'))
  check('schema migration records v11 and scoped rows', () => {
    assert(db.prepare('SELECT v FROM meta WHERE k=?').get('schema_version')?.v === '11')
    assert(db.prepare('SELECT COUNT(*) AS n FROM extension_observed WHERE workspace_id=?').get(bId)?.n >= 1)
  })
  db.close()
} catch (error) { check('extension integration flow', () => { throw error }) }
finally {
  mcp?.child?.kill()
  if (app) await app.close()
  await origin.close()
  if (resolve(temp).startsWith(resolve(tmpdir()) + sep)) rmSync(temp, { recursive: true, force: true })
}
process.exit(report() ? 0 : 1)
