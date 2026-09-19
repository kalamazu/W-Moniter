#!/usr/bin/env node
/**
 * P6 交付截图：探针报告 / 控制台 / 拟人化输入。
 * 直接 CDP Page.captureScreenshot 控制窗口 —— 比 PrintWindow 干净，不会被桌面杂物干扰。
 *
 *   node work/shots-p6.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const OUT = 'C:/Users/22478/Documents/Codex/2026-09-19/i/outputs'
const ORIGIN_PORT = 8793
const CDP_PORT = 9461
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

mkdirSync(OUT, { recursive: true })
const dir = join(ROOT, '.userdata', `shots-${Date.now().toString(36)}`)
mkdirSync(dir, { recursive: true })

const origin = spawn(process.execPath, ['scripts/test-origin.mjs', String(ORIGIN_PORT)], { cwd: ROOT, stdio: 'ignore', windowsHide: true })
await sleep(1500)

const logFd = openSync(join(dir, 'app.log'), 'a')
const app = spawn(ELECTRON, ['out/main/index.js', '--no-sandbox', '--remote-debugging-port=' + CDP_PORT], {
  cwd: ROOT,
  stdio: ['ignore', logFd, logFd],
  env: {
    ...process.env,
    MONITOR_URL: 'http://127.0.0.1:' + ORIGIN_PORT + '/',
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
  const evaluate = async (expression) => {
    let last = null
    for (let i = 0; i < 6; i++) {
      try {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 180000 })
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? '求值异常')
        return r.result.value
      } catch (e) { last = e; if (!/destroyed|Cannot find context|Target closed/i.test(e.message)) throw e; await sleep(1000) }
    }
    throw last
  }
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64'))
    console.log('截图 ' + name)
  }
  const settle = (ms = 400) => sleep(ms)

  // 等应用连上、环境面板渲染出来
  await evaluate(`(async () => {
    for (let i = 0; i < 60; i++) {
      const b = document.querySelector('.probe-run')
      const s = await window.monitor.getStatus()
      if (b && s.state === 'connected') return true
      await new Promise((r) => setTimeout(r, 500))
    }
    return false
  })()`)

  /* ---------- 1. 探针报告 ---------- */
  const probe = await evaluate(`(async () => {
    const frame = () => new Promise((r) => setTimeout(r, 60))
    const click = (el) => el && el.click()
    click(document.querySelector('.probe-run'))
    const t0 = performance.now()
    while (performance.now() - t0 < 90000) {
      if (document.querySelector('.probe-report')) break
      await frame()
    }
    for (let round = 0; round < 8; round++) {
      const closed = [...document.querySelectorAll('.probe-group')].filter((g) => !g.querySelector('.probe-table'))
      if (!closed.length) break
      for (const g of closed) click(g.querySelector('.probe-group-head'))
      await frame(); await frame()
    }
    const det = document.querySelector('.probe-fingerprint')
    if (det && !det.open) click(det.querySelector('summary'))
    await frame(); await frame()
    const report = document.querySelector('.probe-report')
    if (!report) return { ok: false }
    report.scrollIntoView({ block: 'start' })
    await frame(); await frame()
    return { ok: true, groups: document.querySelectorAll('.probe-group').length, fp: det ? det.querySelectorAll('tr').length : 0 }
  })()`)
  console.log('探针报告 ' + JSON.stringify(probe))
  await settle(600)
  await shot('p6-probe.png')

  /* ---------- 2. 拟人化输入 ---------- */
  const input = await evaluate(`(async () => {
    const frame = () => new Promise((r) => setTimeout(r, 60))
    const btn = document.querySelector('.input-run-move')
    if (!btn) return { ok: false, reason: 'no-button' }
    // 默认目标是 640,360，而光标起手就在窗口正中 —— 那段只有十几像素，统计看不出东西。
    // 改成横跨窗口的一段，轨迹点/路程才说明得了问题。走原生 setter + input 事件才喂得进 React 状态。
    const setVal = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const labelInput = (text) => [...document.querySelectorAll('label')]
      .find((l) => (l.querySelector('span')?.textContent ?? '').trim() === text)?.querySelector('input')
    setVal(labelInput('x'), '1150')
    setVal(labelInput('y'), '700')
    await frame(); await frame()
    btn.click()
    const t0 = performance.now()
    while (performance.now() - t0 < 30000) {
      const rep = document.querySelector('.input-report')
      if (rep && rep.textContent.includes('轨迹点')) break
      await frame()
    }
    const rep = document.querySelector('.input-report')
    if (!rep) return { ok: false, reason: 'no-report' }
    rep.scrollIntoView({ block: 'center' })
    await frame(); await frame()
    return { ok: true, text: rep.textContent.replace(/\\s+/g, ' ').trim().slice(0, 140) }
  })()`)
  console.log('输入报告 ' + JSON.stringify(input))
  await settle(500)
  await shot('p6-input.png')

  /* ---------- 3. 控制台 ---------- */
  const cons = await evaluate(`(async () => {
    const frame = () => new Promise((r) => setTimeout(r, 80))
    const tab = [...document.querySelectorAll('.tab')].find((b) => b.textContent.trim() === '控制台')
    if (!tab) return { ok: false, reason: 'no-tab' }
    tab.click()
    await frame(); await frame()
    if (!document.querySelector('.console-panel')) return { ok: false, reason: 'no-panel' }

    // 探针那 400×3 次 console.debug 全在环形缓冲里，不清掉截出来就是一片刷屏
    const clear = [...document.querySelectorAll('.console-bar .btn')].find((b) => b.textContent.trim() === '清空')
    clear?.click()
    await frame(); await frame()

    // 让被监控页面自己往控制台写几条，验证 consoleAPICalled 回流
    await window.monitor.evaluate('console.log("页面侧日志回流：console.log 已连上")')
    await window.monitor.evaluate('console.warn("页面侧日志回流：warn 级别")')
    await window.monitor.evaluate('console.error("页面侧日志回流：error 级别")')

    // 再从面板执行一条表达式，把结果块也铺出来（走真实 UI 路径：填 textarea + Enter）
    const ta = document.querySelector('.console-textarea')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, 'JSON.stringify({ ua: navigator.userAgent.slice(0, 34), w: innerWidth, h: innerHeight })')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await frame()
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    const t0 = performance.now()
    while (performance.now() - t0 < 20000) {
      if (document.querySelector('.console-result')) break
      await frame()
    }
    await frame(); await frame()
    return {
      ok: true,
      lines: document.querySelectorAll('.console-line').length,
      result: Boolean(document.querySelector('.console-result'))
    }
  })()`)
  console.log('控制台 ' + JSON.stringify(cons))
  await settle(600)
  await shot('p6-console.png')
} catch (e) {
  console.error('截图跑挂: ' + e.message)
} finally {
  try { app.kill() } catch {}
  try { origin.kill() } catch {}
  await sleep(600)
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}
