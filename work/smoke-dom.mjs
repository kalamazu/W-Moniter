#!/usr/bin/env node
/** DOM 面板冒烟：直接调 preload 桥，把两个新面板的返回原样打出来看 */
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startOrigin } from '../scripts/test-origin.mjs'

const ROOT = 'F:/code/chrome'
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const OUT = 'C:/Users/22478/Documents/Codex/2026-09-19/i/work'
const CDP_PORT = 9475
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

mkdirSync(OUT, { recursive: true })
const origin = await startOrigin(0)
const url = 'http://127.0.0.1:' + origin.port + '/dom-probe.html'
const dir = mkdtempSync(join(tmpdir(), 'smoke-dom-'))
const logFd = openSync(join(OUT, 'smoke-dom.log'), 'a')
const app = spawn(ELECTRON, ['out/main/index.js', '--no-sandbox', '--remote-debugging-port=' + CDP_PORT], {
  cwd: ROOT,
  stdio: ['ignore', logFd, logFd],
  env: {
    ...process.env,
    MONITOR_URL: url,
    MONITOR_DATA_DIR: dir,
    MONITOR_PROFILE: 'L',
    MONITOR_PROXY: '0',
    MONITOR_UI_TAB: 'dom',
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
  for (let i = 0; i < 8; i++) {
    try {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 180000 })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? '求值异常')
      return r.result.value
    } catch (e) {
      if (!/destroyed|Cannot find context|Target closed|Cannot find/i.test(e.message)) throw e
      await sleep(1200)
    }
  }
  throw new Error('重试耗尽')
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64'))
  console.log('截图 ' + name)
}

const WAIT = `(async () => { for (let i = 0; i < 60; i++) { const s = await window.monitor.getStatus(); if (s.state === 'connected' && s.requestCount > 1) return s.state + ' ' + s.requestCount; await new Promise((r) => setTimeout(r, 500)) } return 'timeout ' + JSON.stringify(await window.monitor.getStatus()) })()`
console.log('状态 ' + (await evaluate(WAIT)))
await sleep(1500)

const PROBE = `(async () => {
  const api = window.monitor
  const out = {}
  const tree = await api.domGetTree(undefined, 2)
  out.tree = { ok: tree.ok, error: tree.error, rows: tree.rows.length, domains: tree.enabledDomains, rowsSample: tree.rows }
  const rootRow = tree.rows.find((r) => r.nodeId === 1) ?? tree.rows[0]
  const kids = await api.domGetTree(rootRow.nodeId, 2)
  out.kids = { ok: kids.ok, rows: kids.rows.length, domains: kids.enabledDomains, first: kids.rows.slice(0, 4) }
  const style = await api.domInspect({ selector: '#probe-style' })
  out.style = { styleError: style.styleError, listenerError: style.listenerError, ok: style.ok, domains: style.enabledDomains, node: style.node, html: style.outerHTML, box: style.box, matched: style.matched, listeners: style.listeners, listenerTotal: style.listenerTotal, ms: style.durationMs, computedCount: style.computed ? style.computed.length : 0 }
  const inline = await api.domInspect({ selector: '#probe-inline' })
  out.inlineMatched = inline.matched
  const btn = await api.domInspect({ selector: '#probe-btn' })
  out.btn = { ok: btn.ok, listeners: btn.listeners, listenerTotal: btn.listenerTotal }
  const miss = await api.domInspect({ selector: '#nope-nothing' })
  out.miss = { ok: miss.ok, error: miss.error, domains: miss.enabledDomains, ms: miss.durationMs }
  const bad = await api.domInspect({ selector: '(((' })
  out.bad = { ok: bad.ok, error: bad.error }
  const hl = await api.domHighlight(style.node ? style.node.nodeId : 1, true)
  out.highlight = { ok: hl.ok, error: hl.error, highlighted: hl.highlighted, domains: hl.enabledDomains }
  await api.domHighlight(style.node ? style.node.nodeId : 1, false)
  const bodyRow = tree.rows.find((r) => r.label === 'body')
  const steps = []
  const probeStep = async (tag) => {
    const r = await api.domGetTree(bodyRow ? bodyRow.nodeId : 1, 0)
    steps.push([tag, r.ok, r.error || r.rows.map((x) => x.label).join(',')])
  }
  await probeStep('after-tree')
  out.steps = steps
  const late = await api.domGetTree(bodyRow ? bodyRow.nodeId : 1, 1)
  out.lateExpand = { ok: late.ok, error: late.error, rows: late.rows.map((r) => r.label) }
  out.computedColor = (style.computed || []).find((p) => p[0] === 'color') || null
  out.matchedSelectors = (style.matched || []).map((r) => [r.selector, r.origin, r.overridden])
  out.sessions = await api.getSessions()
  return JSON.stringify(out)
})()`
const res = await evaluate(PROBE)
writeFileSync(join(OUT, 'smoke-dom.json'), res)
console.log(res)

await shot('smoke-dom-tab.png')
await evaluate("document.querySelectorAll('.tab')[8].click()")
await sleep(4000)
await shot('smoke-sessions-tab.png')
console.log('SESSIONS DOM = ' + (await evaluate("document.querySelector('.sessions') ? document.querySelector('.sessions').innerText.slice(0, 1500) : 'NO .sessions'")))

ws.close()
try { app.kill() } catch {}
await sleep(800)
await origin.close()
process.exit(0)