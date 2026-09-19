#!/usr/bin/env node
/** nodeId 生命周期检查：每一步之后拿同一个 id 去 describeNode，看它从哪一步开始废 */
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startOrigin } from '../scripts/test-origin.mjs'

const ROOT = 'F:/code/chrome'
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const OUT = 'C:/Users/22478/Documents/Codex/2026-09-19/i/work'
const CDP_PORT = Number(process.argv[2] ?? 9476)
const TAB = process.argv[3] ?? 'dom'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(OUT, { recursive: true })

const origin = await startOrigin(0)
const url = 'http://127.0.0.1:' + origin.port + '/dom-probe.html'
const dir = mkdtempSync(join(tmpdir(), 'probe-nodes-'))
const logFd = openSync(join(OUT, 'probe-nodes.log'), 'a')
const app = spawn(ELECTRON, ['out/main/index.js', '--no-sandbox', '--remote-debugging-port=' + CDP_PORT], {
  cwd: ROOT,
  stdio: ['ignore', logFd, logFd],
  env: {
    ...process.env,
    MONITOR_URL: url,
    MONITOR_DATA_DIR: dir,
    MONITOR_PROFILE: 'L',
    MONITOR_PROXY: '0',
    MONITOR_UI_TAB: TAB,
    MONITOR_CAPTURE_BODIES: '0',
    MONITOR_CAPTURE_SCRIPTS: '0',
    MONITOR_AUTO_QUIT_MS: '0'
  }
})

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
const evaluate = async (expression) => {
  let last = null
  for (let i = 0; i < 8; i++) {
    try {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 180000 })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? '求值异常')
      return r.result.value
    } catch (e) {
      last = e
      if (!/destroyed|Cannot find context|Target closed|Cannot find/i.test(e.message)) throw e
      await sleep(1200)
    }
  }
  throw last
}

const WAIT = `(async () => { for (let i = 0; i < 60; i++) { const s = await window.monitor.getStatus(); if (s.state === 'connected' && s.requestCount > 1) return s.state; await new Promise((r) => setTimeout(r, 500)) } return 'timeout' })()`
console.log('状态 ' + (await evaluate(WAIT)))
await sleep(2500)

const SEQ = `(async () => {
  const api = window.monitor
  const steps = []
  let bodyId = null
  let htmlId = null
  const check = async (tag) => {
    if (bodyId === null) { steps.push([tag, 'no-id']); return }
    const r = await api.domGetTree(bodyId, 0)
    steps.push([tag, r.ok ? 'ok:' + r.rows.map((x) => x.label).join(',') : 'ERR:' + r.error])
  }
  const tree = await api.domGetTree(undefined, 2)
  bodyId = (tree.rows.find((r) => r.label === 'body') || {}).nodeId ?? null
  htmlId = (tree.rows.find((r) => r.label === 'html') || {}).nodeId ?? null
  steps.push(['tree', tree.ok ? 'bodyId=' + bodyId + ' htmlId=' + htmlId : 'ERR:' + tree.error])
  await check('after-tree')
  const kids = await api.domGetTree(bodyId, 1)
  steps.push(['expand-body', kids.ok ? 'rows=' + kids.rows.length : 'ERR:' + kids.error])
  await check('after-expand')
  const style = await api.domInspect({ selector: '#probe-style' })
  steps.push(['inspect-selector', style.ok ? 'nodeId=' + style.node.nodeId : 'ERR:' + style.error])
  await check('after-inspect-selector')
  const byId = await api.domInspect({ nodeId: htmlId })
  steps.push(['inspect-by-nodeId', byId.ok ? byId.node.label : 'ERR:' + byId.error])
  await check('after-inspect-nodeId')
  const btn = await api.domInspect({ selector: '#probe-btn' })
  steps.push(['inspect-btn', btn.ok ? 'listeners=' + (btn.listeners || []).length : 'ERR:' + btn.error])
  await check('after-btn')
  const hl = await api.domHighlight(style.ok ? style.node.nodeId : 1, true)
  steps.push(['highlight', hl.ok ? 'ok' : 'ERR:' + hl.error])
  await check('after-highlight')
  const late = await api.domGetTree(bodyId, 1)
  steps.push(['late-expand', late.ok ? 'rows=' + late.rows.length : 'ERR:' + late.error])
  return JSON.stringify(steps)
})()`
const res = await evaluate(SEQ)
writeFileSync(join(OUT, 'probe-nodes.json'), res)
console.log(res)

ws.close()
try { app.kill() } catch {}
await sleep(800)
await origin.close()
process.exit(0)