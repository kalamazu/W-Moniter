#!/usr/bin/env node
/** 容器里 Runtime.enable 到底生效没有：往页面里 console.warn 一条，再问控制台面板有没有收到 */
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'F:/code/chrome'
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = 9461
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dir = join(ROOT, '.userdata', 'rt-check-' + Date.now().toString(36))
mkdirSync(dir, { recursive: true })
const origin = spawn(process.execPath, ['scripts/test-origin.mjs', '8799'], { cwd: ROOT, stdio: 'ignore', windowsHide: true })
await sleep(1200)
const logFd = openSync(join(dir, 'app.log'), 'a')
const app = spawn(ELECTRON, ['out/main/index.js', '--no-sandbox', `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  stdio: ['ignore', logFd, logFd],
  env: { ...process.env, MONITOR_URL: 'http://127.0.0.1:8799/', MONITOR_DATA_DIR: dir, MONITOR_PROFILE: 'L', MONITOR_CAPTURE_BODIES: '0', MONITOR_CAPTURE_SCRIPTS: '0', MONITOR_AUTO_QUIT_MS: '0' }
})

let list = null
for (let i = 0; i < 80 && !list; i++) {
  try {
    const rows = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    list = rows.find((t) => t.type === 'page' && String(t.url).includes('index.html')) ?? null
  } catch { /* 还没起来 */ }
  if (!list) await sleep(500)
}
if (!list) throw new Error('控制窗口没起来')
const ws = new WebSocket(list.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let nextId = 1
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (!msg.id) return
  const slot = pending.get(msg.id)
  if (!slot) return
  pending.delete(msg.id)
  msg.error ? slot.reject(new Error(msg.error.message)) : slot.resolve(msg.result)
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 60000 })
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 300))
  return res.result.value
}

// 等 page 会话就绪
await sleep(6000)
const status = await evaluate('window.monitor.getStatus().then((s) => JSON.stringify({ state: s.state, targets: s.targets.length, err: s.error ?? null }))')
console.log('状态:', status)

const probe = `window.monitor.evaluate('(async () => { console.warn("marker-xyz"); const o={a:1}; const N=2000; let s=0; const t0=performance.now(); for (let i=0;i<N;i++) s=(s+o.a)&0xffff; window.__s=s; const base=performance.now()-t0; const t1=performance.now(); for (let i=0;i<N;i++) console.debug(o); const dbg=performance.now()-t1; return JSON.stringify({ base, dbg, perCallUs: dbg*1000/N, outer:[outerWidth,outerHeight], vis:document.visibilityState }) })()')`
console.log('页面侧测量:', await evaluate(probe))

await sleep(800)
const consoleEntries = await evaluate('window.monitor.getConsole().then((rows) => JSON.stringify({ n: rows.length, tail: rows.slice(-3).map((r) => r.level + ":" + r.text) }))')
console.log('控制台缓冲:', consoleEntries)

const caps = await evaluate('window.monitor.getCapabilities().then((c) => JSON.stringify(c))')
console.log('能力:', caps)

ws.close()
app.kill()
origin.kill()
await sleep(500)
console.log('日志尾部:', readFileSync(join(dir, 'app.log'), 'utf8').split('\n').slice(-8).join('\n'))