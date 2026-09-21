// 探针 2：session 作用域 + 真的写点东西进去再扫
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startOrigin } from '../scripts/test-origin.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9808
const dir = mkdtempSync(join(tmpdir(), 'siteprobe2-'))
const origin = await startOrigin(0)
const base = `http://127.0.0.1:${origin.port}`
const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, `${base}/realtime.html`], { stdio: 'ignore', windowsHide: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let wsUrl = null
for (let i = 0; i < 60; i++) { try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; break } catch { await sleep(300) } }
const ws = new WebSocket(wsUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let nextId = 1; const pending = new Map(); const events = []
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'))
  if (msg.id !== undefined) { const s = pending.get(msg.id); if (s) { pending.delete(msg.id); msg.error ? s.reject(new Error(JSON.stringify(msg.error))) : s.resolve(msg.result) } }
  else if (msg.method) events.push(msg)
})
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++; pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  setTimeout(() => { if (pending.delete(id)) reject(new Error('timeout ' + method)) }, 15000)
})
async function step(label, fn) { try { console.log(`OK   ${label} :: ${JSON.stringify(await fn())?.slice(0, 500)}`) } catch (e) { console.log(`FAIL ${label} :: ${e.message}`) } }

await sleep(3500)
const targets = await send('Target.getTargets')
const page = targets.targetInfos.find((t) => t.type === 'page' && t.url.startsWith(base))
const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })

// 先写点站点资源进去
await send('Runtime.enable', {}, sessionId)
await send('Runtime.evaluate', { expression: `
  localStorage.setItem('k1','v1'); localStorage.setItem('k2', 'x'.repeat(300));
  sessionStorage.setItem('s1','sv');
  document.cookie = 'fromjs=yes; path=/';
  new Promise((res) => { const r = indexedDB.open('probe-db', 1); r.onupgradeneeded = () => r.result.createObjectStore('items', { keyPath: 'id' }); r.onsuccess = () => { r.result.transaction('items','readwrite').objectStore('items').put({id:1,a:'b'}); res('idb-ok') } });
  caches.open('probe-cache').then((c) => c.add(new Request('/api/ping'))).then(() => 'cache-ok');
  'done'
`, awaitPromise: true, returnByValue: true }, sessionId)
await sleep(2000)

await step('Storage.getUsageAndQuota (browser)', () => send('Storage.getUsageAndQuota', { origin: base }))
await step('Storage.getUsageAndQuota (session)', () => send('Storage.getUsageAndQuota', { origin: base }, sessionId))
await step('Storage.trackCacheStorageForOrigin (session)', () => send('Storage.trackCacheStorageForOrigin', { origin: base }, sessionId))
await step('Storage.trackIndexedDBForOrigin (session)', () => send('Storage.trackIndexedDBForOrigin', { origin: base }, sessionId))
await step('DOMStorage.getDOMStorageItems local', () => send('DOMStorage.getDOMStorageItems', { storageId: { securityOrigin: base, isLocalStorage: true } }, sessionId))
await step('DOMStorage.getDOMStorageItems session', () => send('DOMStorage.getDOMStorageItems', { storageId: { securityOrigin: base, isLocalStorage: false } }, sessionId))
await step('IndexedDB.requestDatabaseNames', () => send('IndexedDB.requestDatabaseNames', { securityOrigin: base }, sessionId))
await step('IndexedDB.requestDatabase', () => send('IndexedDB.requestDatabase', { securityOrigin: base, databaseName: 'probe-db' }, sessionId))
await step('CacheStorage.requestCacheNames', () => send('CacheStorage.requestCacheNames', { securityOrigin: base }, sessionId))
await step('Storage.getCookies', async () => (await send('Storage.getCookies')).cookies.map((c) => c.name + '=' + c.value))
await step('Network.deleteCookies', () => send('Network.deleteCookies', { name: 'fromjs', domain: '127.0.0.1', path: '/' }, sessionId))
await sleep(800)
await step('Storage.getCookies after delete', async () => (await send('Storage.getCookies')).cookies.map((c) => c.name))
await step('Storage.clearDataForOrigin', () => send('Storage.clearDataForOrigin', { origin: base, storageTypes: 'cookies,local_storage,indexeddb,cache_storage' }, sessionId))
await sleep(800)
await step('after clear: cookies', async () => (await send('Storage.getCookies')).cookies.length)
await step('after clear: local', () => send('DOMStorage.getDOMStorageItems', { storageId: { securityOrigin: base, isLocalStorage: true } }, sessionId))
console.log('--- 相关事件 ---')
console.log(JSON.stringify([...new Set(events.map((e) => e.method).filter((m) => /Storage|IndexedDB|CacheStorage|Registration/i.test(m)))]))
const ids = events.filter((e) => /domStorageItem/i.test(e.method)).map((e) => e.method + ' ' + JSON.stringify(e.params).slice(0, 120))
console.log(JSON.stringify(ids.slice(0, 8), null, 1))
try { child.kill() } catch {}; try { origin.close() } catch {}; process.exit(0)