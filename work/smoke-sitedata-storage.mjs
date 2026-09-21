// 存储层新算子的快速冒烟
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const ROOT = 'F:/code/chrome'
const child = spawn(process.execPath, [join(ROOT, 'storage', 'server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] })
let carry = ''
const pending = new Map()
let nextId = 1
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stderr.on('data', (c) => process.stderr.write('[srv] ' + c))
child.stdout.on('data', (chunk) => {
  const text = carry + chunk
  let start = 0, index = text.indexOf('\n', start)
  while (index !== -1) {
    const line = text.slice(start, index)
    if (line) { const msg = JSON.parse(line); if (msg.id != null) { const s = pending.get(msg.id); pending.delete(msg.id); if (s) s(msg) } }
    start = index + 1; index = text.indexOf('\n', start)
  }
  carry = text.slice(start)
})
const call = (op, args = {}) => new Promise((resolve, reject) => {
  const id = nextId++
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(op + ' 超时')) }, 15000)
  pending.set(id, (msg) => { clearTimeout(timer); msg.ok ? resolve(msg.result) : reject(new Error(op + ': ' + msg.error)) })
  child.stdin.write(JSON.stringify({ id, op, args }) + '\n')
})

const dir = mkdtempSync(join(tmpdir(), 'sitesmoke-'))
await call('open', { dbPath: join(dir, 't.db') })
const inst = (await call('beginInstance', { url: 'http://a.test/' })).instId
console.log('inst', inst)

// 灌几条请求，好让 siteOriginsSeen 有东西
const mk = (seq, url) => ({
  seq, key: 's' + seq, request_id: 'r' + seq, target_type: 'page', url,
  host: new URL(url).hostname, scheme: new URL(url).protocol.replace(':', ''), path: new URL(url).pathname,
  method: 'GET', resource_type: 'Document', status: 200, start_ts: Date.now()
})
await call('appendRequests', { inst, rows: [mk(0, 'http://a.test/x'), mk(1, 'https://b.test:8443/y')] })
console.log('seen', JSON.stringify(await call('siteOriginsSeen', { inst })))

const c1 = { name: 'sid', value: 'abc', domain: '.a.test', host: 'a.test', path: '/', session: true, secure: true, sameSite: 'Lax', size: 12 }
let r = await call('cookieSync', { inst, now: Date.now(), cookies: [c1] })
console.log('sync1', JSON.stringify(r))
r = await call('cookieSync', { inst, now: Date.now(), cookies: [{ ...c1, value: 'xyz' }], attribution: [{ url: 'http://a.test/x', names: ['sid'] }] })
console.log('sync2', JSON.stringify(r))
assert.equal(r.changed, 1)
assert.equal(r.changes[0].url, 'http://a.test/x')
r = await call('cookieSync', { inst, now: Date.now(), cookies: [] })
console.log('sync3', JSON.stringify(r))
assert.equal(r.removed, 1)

await call('cookieSync', { inst, now: Date.now(), cookies: [
  { name: 'sid', value: 'abc', domain: '.a.test', host: 'a.test', path: '/', session: true, secure: true, sameSite: 'Lax', size: 12 },
  { name: 'tid', value: 'zzz', domain: '.tracker.test', host: 'tracker.test', path: '/', expires: 1900000000, size: 30 },
  { name: '_ga', value: 'GA1.1', domain: '.a.test', host: 'a.test', path: '/', expires: 1900000000, size: 20 },
  { name: '_ga', value: 'GA2.2', domain: '.b.test', host: 'b.test', path: '/', expires: 1900000000, size: 22 }
] })
console.log('list', JSON.stringify(await call('cookieList', { query: { limit: 10 } })))
console.log('stats', JSON.stringify(await call('cookieStats', {})))
const sent = await call('cookieRememberSent', { items: [{ key: 'a.test|/|sid|', host: 'tracker.test' }, { key: 'a.test|/|sid|', host: 'a.test' }] })
console.log('sent', JSON.stringify(sent))
console.log('after sent', JSON.stringify((await call('cookieList', { query: { crossSite: true } })).rows.map((c) => c.name + '/' + c.sentCount)))

await call('siteUpsert', { inst, rows: [{ origin: 'http://a.test', localStorageCount: 2, localStorageBytes: 500, idbNames: ['db1'], idbStores: 1, cacheNames: ['c1'], cacheEntries: 3, swCount: 1, usageBytes: 1234, quotaBytes: 999999, usageBreakdown: [{ storageType: 'indexeddb', usage: 100 }], detail: { localStorage: [{ key: 'k1', value: 'v', bytes: 5 }, { key: 'k2', value: 'vv', bytes: 6 }], idb: [], caches: [], serviceWorkers: [], sessionStorage: [] } }] })
console.log('overview', JSON.stringify(await call('siteOverview', { inst })))
console.log('detail', JSON.stringify((await call('siteDetail', { origin: 'http://a.test' })).localStorage))
const snap = await call('siteSnapshot', { inst, label: 'base' })
console.log('snapshot', JSON.stringify(snap))
await call('siteUpsert', { inst, rows: [{ origin: 'http://c.test', localStorageCount: 1 }] })
console.log('diff', JSON.stringify(await call('siteSnapshotDiff', { baseId: snap.id })))
console.log('snapList', JSON.stringify(await call('siteSnapshotList', { limit: 5 })))
console.log('\n全部通过')
child.stdin.end()
process.exit(0)