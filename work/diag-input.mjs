#!/usr/bin/env node
/** 一次性诊断：拟人化输入为什么 maxStep 过大 / 同 seed 点数不一致。 */
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const ORIGIN_PORT = 8791
const CDP_PORT = 9459
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dir = join(ROOT, '.userdata', 'diag-input')
mkdirSync(dir, { recursive: true })

const origin = spawn(process.execPath, ['scripts/test-origin.mjs', String(ORIGIN_PORT)], { cwd: ROOT, stdio: 'ignore', windowsHide: true })
await sleep(1500)
const logFd = openSync(join(dir, 'app.log'), 'a')
const app = spawn(ELECTRON, ['out/main/index.js', '--no-sandbox', '--remote-debugging-port=' + CDP_PORT], {
  cwd: ROOT,
  stdio: ['ignore', logFd, logFd],
  env: {
    ...process.env,
    MONITOR_URL: 'http://127.0.0.1:' + ORIGIN_PORT + '/input-probe.html',
    MONITOR_DATA_DIR: dir,
    MONITOR_PROFILE: 'L',
    MONITOR_UI_TAB: 'env',
    MONITOR_CAPTURE_BODIES: '0',
    MONITOR_CAPTURE_SCRIPTS: '0',
    MONITOR_AUTO_QUIT_MS: '0'
  }
})

try {
  let target = null
  const deadline = Date.now() + 60000
  while (Date.now() < deadline && !target) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json()
      target = list.find((t) => t.type === 'page' && String(t.url).includes('index.html')) ?? null
    } catch {}
    if (!target) await sleep(400)
  }
  if (!target) throw new Error('等不到控制窗口目标')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 失败')) })
  let nextId = 1
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (!m.id) return
    const s = pending.get(m.id)
    if (!s) return
    pending.delete(m.id)
    if (m.error) s.reject(new Error(m.error.message)); else s.resolve(m.result)
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  const raw = async (expr) => {
    let last = null
    for (let i = 0; i < 5; i++) {
      try {
        const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 120000 })
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 异常')
        return r.result.value
      } catch (e) { last = e; if (!/destroyed|Cannot find context|Target closed/i.test(e.message)) throw e; await sleep(1000) }
    }
    throw last
  }
  const pageEval = async (expr) => {
    const r = await raw('window.monitor.evaluate(' + JSON.stringify(expr) + ')')
    if (!r?.ok) throw new Error(r?.error ?? 'pageEval 失败')
    return r.value
  }

  let ok = false
  for (let i = 0; i < 40 && !ok; i++) {
    ok = await raw("(async () => { const s = await window.monitor.getStatus(); return s.state === 'connected' })()")
    if (!ok) await sleep(500)
  }
  const pr = await raw("(async () => { let o = null; for (let i = 0; i < 30 && !o?.ok; i++) { o = await window.monitor.evaluate('document.title'); if (o.value !== '输入验收页') { o = { ok: false }; await new Promise(r => setTimeout(r, 500)) } } return o })()")
  console.error('probeReady=' + JSON.stringify(pr))
  console.error('viewport=' + JSON.stringify(await pageEval('JSON.stringify({w:innerWidth,h:innerHeight,ow:outerWidth,oh:outerHeight,vis:document.visibilityState,sx:screenX,sy:screenY})')))

  const dump = async (label, report) => {
    const rec = JSON.parse(await pageEval('JSON.stringify(window.__rec)'))
    const mv = rec.moves
    const steps = []
    for (let i = 1; i < mv.length; i++) steps.push({ d: +Math.hypot(mv[i].x - mv[i-1].x, mv[i].y - mv[i-1].y).toFixed(2), from: mv[i-1].x + ',' + mv[i-1].y, to: mv[i].x + ',' + mv[i].y })
    steps.sort((a, b) => b.d - a.d)
    console.error('--- ' + label + ' ---')
    console.error('report=' + JSON.stringify(report))
    console.error('recorded=' + mv.length + ' first3=' + JSON.stringify(mv.slice(0, 3)) + ' last2=' + JSON.stringify(mv.slice(-2)))
    console.error('top3steps=' + JSON.stringify(steps.slice(0, 3)))
  }

  const run = (a) => raw('window.monitor.runInput(' + JSON.stringify(a) + ')')

  await pageEval('window.__resetRec()')
  const r1 = await run({ kind: 'move', x: 900, y: 600, seed: 20260919 })
  await dump('A: cursor(0,0)->(900,600)', r1)

  const r2 = await run({ kind: 'move', x: 300, y: 200, seed: 1 })
  await pageEval('window.__resetRec()')
  const r3 = await run({ kind: 'move', x: 900, y: 600, seed: 20260919 })
  await dump('B: cursor(300,200)->(900,600)', r3)

  await pageEval('window.__resetRec()')
  const r4 = await run({ kind: 'move', x: 300, y: 200, seed: 1 })
  await pageEval('window.__resetRec()')
  const r5 = await run({ kind: 'move', x: 900, y: 600, seed: 20260919 })
  await dump('C: repeat of B', r5)
  console.error('r2=' + JSON.stringify(r2) + ' r4=' + JSON.stringify(r4))
} catch (e) {
  console.error('诊断挂: ' + e.message)
} finally {
  try { app.kill() } catch {}
  try { origin.kill() } catch {}
  await sleep(500)
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}
