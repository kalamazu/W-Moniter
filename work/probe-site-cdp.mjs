// 一次性探针：验证 Storage / DOMStorage / IndexedDB / CacheStorage / ServiceWorker 在真 Chrome 上怎么调
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startOrigin } from '../scripts/test-origin.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9807
const dir = mkdtempSync(join(tmpdir(), 'siteprobe-'))
const origin = await startOrigin(0)
const base = `http://127.0.0.1:${origin.port}`
console.log('origin', base)

const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, `${base}/`], { stdio: 'ignore', windowsHide: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let wsUrl = null
for (let i = 0; i < 60; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; break } catch { await sleep(300) }
}
console.log('ws', wsUrl)

const ws = new WebSocket(wsUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let nextId = 1
const pending = new Map()
const events = []
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'))
  if (msg.id !== undefined) {
    const slot = pending.get(msg.id)
    if (slot) { pending.delete(msg.id); msg.error ? slot.reject(new Error(JSON.stringify(msg.error))) : slot.resolve(msg.result) }
  } else if (msg.method) events.push(msg)
})
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  setTimeout(() => { if (pending.delete(id)) reject(new Error('timeout ' + method)) }, 15000)
})

async function step(label, fn) {
  try { const out = await fn(); console.log(`OK   ${label} :: ${JSON.stringify(out)?.slice(0, 400)}`) }
  catch (e) { console.log(`FAIL ${label} :: ${e.message}`) }
}

await sleep(3000)

// 找一个 page target
const targets = await send('Target.getTargets')
const page = targets.targetInfos.find((t) => t.type === 'page' && t.url.startsWith(base))
console.log('page target', page?.targetId, page?.url)
const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })

await step('Storage.getCookies (browser)', () => send('Storage.getCookies'))
await step('Storage.setCookies (browser)', () => send('Storage.setCookies', { cookies: [{ name: 'probe-c', value: 'v1', domain: '127.0.0.1', path: '/' }] }))
await step('Storage.getCookies again', async () => (await send('Storage.getCookies')).cookies.map((c) => c.name + '=' + c.value))
await step('Storage.getUsageAndQuota', () => send('Storage.getUsageAndQuota', { origin: base }))
await step('DOMStorage.enable (session)', () => send('DOMStorage.enable', {}, sessionId))
await step('DOMStorage.getDOMStorageItems', () => send('DOMStorage.getDOMStorageItems', { storageId: { securityOrigin: base, isLocalStorage: true } }, sessionId))
await step('IndexedDB.enable (session)', () => send('IndexedDB.enable', {}, sessionId))
await step('IndexedDB.requestDatabaseNames', () => send('IndexedDB.requestDatabaseNames', { securityOrigin: base }, sessionId))
await step('CacheStorage.requestCacheNames', () => send('CacheStorage.requestCacheNames', { securityOrigin: base }, sessionId))
await step('Storage.trackCacheStorageForOrigin', () => send('Storage.trackCacheStorageForOrigin', { origin: base }))
await step('Storage.trackIndexedDBForOrigin', () => send('Storage.trackIndexedDBForOrigin', { origin: base }))
await step('ServiceWorker.enable (session)', () => send('ServiceWorker.enable', {}, sessionId))
await sleep(1500)
await step('Network.getCookies on session', () => send('Network.getCookies', {}, sessionId))
console.log('--- 收到的域事件 ---')
console.log(JSON.stringify([...new Set(events.map((e) => e.method))]))
console.log(JSON.stringify(events.filter((e) => /Cookie|Storage|IndexedDB|CacheStorage|workerRegistration/i.test(e.method)).map((e) => e.method).slice(0, 30)))

try { child.kill() } catch {}
try { origin.close() } catch {}
process.exit(0)