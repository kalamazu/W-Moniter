#!/usr/bin/env node
/** Standalone CDP comparison: does Network.getResponseBody return bytes without Fetch interception? */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { startOrigin } from '../test-origin.mjs'
import { makeChecker, sleep } from '../app-harness.mjs'

const { check, assert, report } = makeChecker()
const candidates = [process.env['CHROME_PATH'], 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
const browser = candidates.find((path) => path && existsSync(path))
const profile = mkdtempSync(join(tmpdir(), 'monitor-cdp-alternative-'))
const origin = await startOrigin(0)
let child = null
let ws = null
try {
  if (!browser) throw new Error('找不到可运行的 Chrome；请设置 CHROME_PATH')
  const port = await new Promise((resolvePort, reject) => {
    const listener = createServer()
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => { const selected = listener.address().port; listener.close(() => resolvePort(selected)) })
  })
  child = spawn(browser, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank'
  ], { stdio: 'ignore', windowsHide: true })
  let target = null
  for (let retry = 0; retry < 100 && !target; retry += 1) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === 'page') } catch { await sleep(100) }
  }
  if (!target) throw new Error('Chrome 调试端点未启动')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolveOpen, reject) => { ws.onopen = resolveOpen; ws.onerror = reject })
  let nextId = 0
  const pending = new Map()
  const responses = new Map()
  const finished = new Set()
  ws.onmessage = ({ data }) => {
    const item = JSON.parse(data)
    if (item.id) {
      const wait = pending.get(item.id)
      if (wait) { pending.delete(item.id); item.error ? wait.reject(new Error(item.error.message)) : wait.resolve(item.result) }
    } else if (item.method === 'Network.responseReceived') {
      responses.set(item.params.response.url, item.params.requestId)
    } else if (item.method === 'Network.loadingFinished') finished.add(item.params.requestId)
  }
  const send = (method, params = {}) => new Promise((resolveResult, reject) => {
    const id = ++nextId
    pending.set(id, { resolve: resolveResult, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  await send('Network.enable')
  await send('Page.enable')
  await send('Page.navigate', { url: `http://127.0.0.1:${origin.port}/capture-matrix.html?skipUpload` })
  const base = `http://127.0.0.1:${origin.port}`
  const result = { browser, alternatives: {} }
  for (const [label, route, bytes] of [['binary', '/matrix-binary', Buffer.alloc(2 * 1024 * 1024, 37)], ['stream', '/matrix-stream', Buffer.concat([Buffer.alloc(256 * 1024, 1), Buffer.alloc(256 * 1024, 2), Buffer.alloc(256 * 1024, 3)])]]) {
    const url = base + route
    let requestId = null
    for (let retry = 0; retry < 200; retry += 1) {
      requestId = responses.get(url)
      if (requestId && finished.has(requestId)) break
      await sleep(100)
    }
    const expectedHash = createHash('sha256').update(bytes).digest('hex')
    try {
      if (!requestId || !finished.has(requestId)) throw new Error('未等到 Network.loadingFinished')
      const body = await send('Network.getResponseBody', { requestId })
      const raw = body.base64Encoded ? Buffer.from(body.body, 'base64') : Buffer.from(body.body, 'utf8')
      result.alternatives[label] = { available: true, bytes: raw.length, hash: createHash('sha256').update(raw).digest('hex'), matchesOrigin: raw.length === bytes.length && createHash('sha256').update(raw).digest('hex') === expectedHash }
    } catch (error) { result.alternatives[label] = { available: false, error: String(error) } }
  }
  check('CDP Network 正文备选路径返回真实响应字节', () => {
    assert(result.alternatives.binary.matchesOrigin && result.alternatives.stream.matchesOrigin, JSON.stringify(result.alternatives))
  })
  console.log('CDP_ALTERNATIVE ' + JSON.stringify(result))
} catch (error) {
  check('独立 CDP 路径探针', () => { throw error })
} finally {
  ws?.close()
  child?.kill()
  await origin.close()
  if (resolve(profile).startsWith(resolve(tmpdir()) + sep)) {
    try { rmSync(profile, { recursive: true, force: true }) } catch { /* Chrome 可能仍在退出 */ }
  }
}
process.exit(report() ? 0 : 1)
