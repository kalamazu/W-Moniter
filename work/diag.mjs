import { spawn } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
const ROOT = 'F:/code/chrome'
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = 9462
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const dir = join(ROOT, '.userdata', 'diag-' + Date.now().toString(36))
mkdirSync(dir, { recursive: true })
const origin = spawn(process.execPath, ['scripts/test-origin.mjs', '8797'], { cwd: ROOT, stdio: 'ignore', windowsHide: true })
await sleep(1200)
const logFd = openSync(join(dir, 'app.log'), 'a')
const app = spawn(ELECTRON, ['out/main/index.js', '--no-sandbox', `--remote-debugging-port=${PORT}`], {
  cwd: ROOT, stdio: ['ignore', logFd, logFd],
  env: { ...process.env, MONITOR_URL: 'http://127.0.0.1:8797/input-probe.html', MONITOR_DATA_DIR: dir, MONITOR_PROFILE: 'L', MONITOR_CAPTURE_BODIES: '0', MONITOR_CAPTURE_SCRIPTS: '0', MONITOR_AUTO_QUIT_MS: '0' }
})
let list = null
for (let i = 0; i < 80 && !list; i++) {
  try { const rows = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); list = rows.find((t) => t.type === 'page' && String(t.url).includes('index.html')) ?? null } catch {}
  if (!list) await sleep(500)
}
const ws = new WebSocket(list.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let nextId = 1
const pending = new Map()
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (!m.id) return; const s = pending.get(m.id); if (!s) return; pending.delete(m.id); m.error ? s.reject(new Error(m.error.message)) : s.resolve(m.result) }
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 60000 })
  if (res.exceptionDetails) return { err: res.exceptionDetails.exception?.description ?? res.exceptionDetails.text }
  return res.result.value
}
await sleep(6000)
for (const expr of [
  'window.monitor.evaluate("location.href")',
  'window.monitor.evaluate("document.title")',
  'window.monitor.evaluate("typeof window.__rec")',
  'window.monitor.evaluate("typeof window.__resetRec")',
  'window.monitor.evaluate("JSON.stringify(Object.getOwnPropertyNames(window).filter(function(k){return k.indexOf(\'__\')===0}))")',
  'window.monitor.evaluate("document.readyState")',
  'window.monitor.getStatus().then((s) => JSON.stringify(s.targets.map((t) => t.type + \'|\' + t.url.slice(0, 60))))'
]) {
  console.log(expr.slice(0, 60), '=>', JSON.stringify(await evaluate(expr)))
}
ws.close(); app.kill(); origin.kill(); await sleep(400)