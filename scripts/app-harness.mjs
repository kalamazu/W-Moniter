#!/usr/bin/env node
/**
 * 面板验收的共用驱动。
 *
 * test-dom / test-sessions 都要「起控制窗口 → 连它的 CDP → 在窗口里求值」这一套，
 * 抽出来比抄两遍强。求值走的是渲染进程里的 window.monitor，也就是真实的
 * preload 桥 + IPC + 控制器，所以脚本过的就是用户点得到的那条路。
 *
 * 控制窗口刚起来时会重建一次执行上下文（/json/list 会在导航中途就把目标报出来），
 * 那一小段时间里 Runtime.evaluate 会回「Execution context was destroyed」，
 * 属于瞬时错误，只对这一小类重试（test-probe.mjs 踩过同一个坑）。
 */

import { spawn } from 'node:child_process'
import { openSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** check / assert / 汇总，和其它验收脚本一个口味 */
export function makeChecker() {
  const results = []
  const check = (name, fn) => {
    try {
      const out = fn()
      // 判据必须是同步给出的：async 回调里的断言失败会变成未捕获的 rejection，
      // 面板上一片绿其实是假的
      if (out && typeof out.then === 'function') {
        throw new Error('check 的回调不能是 async：先把异步结果取出来再判')
      }
      results.push({ name, ok: true })
      console.log(`  \u2713 ${name}`)
    } catch (err) {
      results.push({ name, ok: false, message: err.message })
      console.log(`  \u2717 ${name}\n      ${err.message}`)
    }
  }
  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const report = () => {
    const failed = results.filter((item) => !item.ok)
    console.log(`\n  ${results.length - failed.length}/${results.length} 通过`)
    for (const item of failed) console.log(`  \u2717 ${item.name}: ${item.message}`)
    return failed.length === 0
  }
  return { check, assert, results, report }
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      if (!msg.id) return
      const slot = this.pending.get(msg.id)
      if (!slot) return
      this.pending.delete(msg.id)
      if (msg.error) slot.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
      else slot.resolve(msg.result)
    }
    ws.onclose = () => this.failAll('调试目标已断开')
    ws.onerror = () => this.failAll('调试连接出错')
  }

  failAll(reason) {
    for (const slot of this.pending.values()) slot.reject(new Error(reason))
    this.pending.clear()
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* 已经断了 */
    }
  }
}

export async function openCdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 15000)
    ws.onopen = () => {
      clearTimeout(timer)
      resolve()
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error('CDP WebSocket 连接失败'))
    }
  })
  return new Cdp(ws)
}

export async function waitControlTarget(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const hit = list.find((t) => t.type === 'page' && String(t.url).includes('index.html'))
      if (hit?.webSocketDebuggerUrl) return hit
    } catch {
      /* 端口还没起来 */
    }
    await sleep(400)
  }
  return null
}

/**
 * 起一个带远程调试的控制窗口。
 *   url          被监控页面
 *   dataDir      应用的 MONITOR_DATA_DIR（库里也能看到东西）
 *   tab          开局停在哪个面板（DOM / 会话 / …）
 *   shotDir      给了就支持 shot(name) 截图
 */
export async function launchApp(options) {
  const {
    url,
    dataDir,
    port,
    profile = 'L',
    tab = 'list',
    shotDir = null,
    extraEnv = {}
  } = options

  const logFd = openSync(join(dataDir, 'app.log'), 'a')
  const app = spawn(
    ELECTRON,
    ['out/main/index.js', '--no-sandbox', `--remote-debugging-port=${port}`],
    {
      cwd: ROOT,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
      env: {
        ...process.env,
        MONITOR_URL: url,
        MONITOR_DATA_DIR: dataDir,
        MONITOR_PROFILE: profile,
        MONITOR_UI_TAB: tab,
        MONITOR_CAPTURE_BODIES: '0',
        MONITOR_CAPTURE_SCRIPTS: '0',
        MONITOR_AUTO_QUIT_MS: '0',
        ...extraEnv
      }
    }
  )

  const target = await waitControlTarget(port)
  if (!target) {
    try {
      app.kill()
    } catch {
      /* 已经退了 */
    }
    throw new Error('等不到控制窗口的调试目标')
  }
  const cdp = await openCdp(target.webSocketDebuggerUrl)

  const transient = /destroyed|Cannot find context|Target closed/i
  const evaluate = async (expression) => {
    let lastError = null
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await cdp.send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
          timeout: 180000
        })
        if (res.exceptionDetails) {
          throw new Error(res.exceptionDetails.exception?.description ?? '控制窗口求值异常')
        }
        return res.result.value
      } catch (err) {
        lastError = err
        if (!transient.test(err.message)) throw err
        await sleep(1000)
      }
    }
    throw lastError
  }

  /** 等控制器连上且至少有 minRequests 条采集 */
  const waitConnected = async (minRequests = 1, timeoutMs = 45000) => {
    const deadline = Date.now() + timeoutMs
    let status = null
    while (Date.now() < deadline) {
      status = await evaluate('window.monitor.getStatus()')
      if (status?.state === 'connected' && (status.requestCount ?? 0) >= minRequests) return status
      await sleep(500)
    }
    throw new Error('控制器没连上或没采到流量: ' + JSON.stringify(status))
  }

  const shot = async (name) => {
    if (!shotDir) return
    const res = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(shotDir, name), Buffer.from(res.data, 'base64'))
    console.log('  截图 ' + name)
  }

  const close = async () => {
    cdp.close()
    try {
      app.kill()
    } catch {
      /* 已经退了 */
    }
    await sleep(800)
  }

  return { app, cdp, evaluate, waitConnected, shot, close }
}