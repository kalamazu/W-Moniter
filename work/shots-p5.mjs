#!/usr/bin/env node
/**
 * P5 交付截图：瀑布图上的代理分段时序 + 详情面板里的分段条。
 * 走真代理 + 受控 origin，所以图上的数据是真抓出来的。
 *
 *   node work/shots-p5.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startOrigin } from '../scripts/test-origin.mjs'

const ROOT = 'F:/code/chrome'
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const OUT = 'C:/Users/22478/Documents/Codex/2026-09-19/i/outputs'
const CDP_PORT = 9474
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

mkdirSync(OUT, { recursive: true })
const origin = await startOrigin(0)
const url = 'http://localhost:' + origin.port + '/'
const dir = mkdtempSync(join(tmpdir(), 'shots-p5-'))
const keyFile = join(mkdtempSync(join(tmpdir(), 'shots-p5-key-')), 'k')

const logFd = openSync(join(dir, 'app.log'), 'a')
const app = spawn(ELECTRON, ['out/main/index.js', '--no-sandbox', '--remote-debugging-port=' + CDP_PORT], {
  cwd: ROOT,
  stdio: ['ignore', logFd, logFd],
  env: {
    ...process.env,
    MONITOR_URL: url,
    MONITOR_DATA_DIR: dir,
    MONITOR_PROFILE: 'L',
    MONITOR_PROXY: '1',
    MONITOR_PROXY_KEY: keyFile,
    MONITOR_UI_TAB: 'waterfall',
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
// 渲染进程偶尔会被销毁/重建（窗口摆正、导航），重试几次比整个脚本挂掉划算
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
const shot = async (name, clip) => {
  const r = await send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' })
  writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64'))
  console.log('截图 ' + name)
}

const WAIT_ROWS = "(async () => { for (let i = 0; i < 80; i++) { const s = await window.monitor.getStatus(); if (s.state === 'connected' && s.requestCount > 150) return s.requestCount; await new Promise((r) => setTimeout(r, 500)) } return (await window.monitor.getStatus()).requestCount })()"
console.log('请求数 ' + (await evaluate(WAIT_ROWS)))
await sleep(3000)

const CLIP = "(() => { const el = document.querySelector('.waterfall'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 } })()"
await shot('p5-waterfall-full.png')
const clip = await evaluate(CLIP)
if (clip) await shot('p5-waterfall.png', clip)

// 挑一条有 DNS 分段的，选中它，截详情面板
const PICK = "(async () => { const s = await window.monitor.getStatus(); const page = await window.monitor.queryRequests({ inst: s.inst }, 500, 0, 'time_desc'); const rows = page?.rows ?? []; const hit = rows.find((r) => r.merge_state === 'merged' && r.net_dns_ms !== null); const open = rows.find((r) => r.proxy_open); const api = window.monitor; if (hit) await api.selectRow?.(hit.seq); return { dns: hit ? hit.seq : null, open: open ? open.seq : null, total: rows.length, states: Array.from(new Set(rows.map((r) => r.merge_state))) } })()"
console.log('数据检查 ' + JSON.stringify(await evaluate(PICK)))

ws.close()
try { app.kill() } catch {}
await sleep(800)
await origin.close()
process.exit(0)
