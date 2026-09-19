#!/usr/bin/env node
/**
 * 一次性实验：Runtime.enable 到底在页面侧留下了什么可观测差异？
 * 同一会话内做 A/B —— 先不带 Runtime 测一遍，Runtime.enable 之后再测一遍。
 * 结论用来挑探针真正该用的检测项，而不是照抄别人的清单。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => existsSync(p))
if (!CHROME) throw new Error('找不到 Chrome')

const PORT = 9701
const profile = mkdtempSync(join(tmpdir(), 'ab-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const child = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-blink-features=AutomationControlled',
  '--window-size=1280,900',
  '--window-position=60,40',
  'about:blank'
], { stdio: 'ignore', windowsHide: false })

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      if (list.length) return list
    } catch { /* 还没起来 */ }
    await sleep(300)
  }
  throw new Error('调试端口没起来')
}

const list = await targets()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let nextId = 1
const pending = new Map()
const events = []
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id) {
    const slot = pending.get(msg.id)
    if (slot) { pending.delete(msg.id); msg.error ? slot.reject(new Error(msg.error.message)) : slot.resolve(msg.result) }
  } else {
    events.push(msg.method)
  }
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})

await send('Page.enable')
await send('Network.enable')

const CANDIDATES = `(async () => {
  const out = {}
  const obj = { a: 1, b: 'x', c: [1,2,3], d: { e: 1 } }
  const N = 2000
  let sink = 0
  const t0 = performance.now()
  for (let i = 0; i < N; i++) sink = (sink + obj.a + obj.c.length) & 0xffff
  window.__sink = sink
  const baseMs = performance.now() - t0
  const t1 = performance.now()
  for (let i = 0; i < N; i++) console.debug(obj)
  const dbgMs = performance.now() - t1
  out.timing = { baseMs: +baseMs.toFixed(4), dbgMs: +dbgMs.toFixed(4), perCallUs: +(dbgMs * 1000 / N).toFixed(4) }

  let touched = 0
  const baked = {}
  Object.defineProperty(baked, 'stack', { get () { touched++; return 'x' }, configurable: true })
  console.debug(baked)
  out.getterTouched = touched

  const traps = []
  const prox = new Proxy({ x: 1 }, {
    ownKeys (t) { traps.push('ownKeys'); return Reflect.ownKeys(t) },
    get (t, k) { traps.push('get:' + String(k)); return t[k] },
    getOwnPropertyDescriptor (t, k) { traps.push('gopd:' + String(k)); return Reflect.getOwnPropertyDescriptor(t, k) }
  })
  console.debug(prox)
  out.proxyTraps = traps.length

  let strCalls = 0
  let tagReads = 0
  const tagged = {}
  Object.defineProperty(tagged, Symbol.toStringTag, { get () { tagReads++; return 'T' }, configurable: true })
  tagged.toString = function () { strCalls++; return 'T' }
  console.debug(tagged)
  out.toStringCalls = strCalls
  out.tagReads = tagReads

  let errTouched = 0
  const err = new Error('x')
  Object.defineProperty(err, 'stack', { get () { errTouched++; return 'y' }, configurable: true })
  console.debug(err)
  out.errStackGetter = errTouched

  let prep = 0
  const origPrep = Error.prepareStackTrace
  Error.prepareStackTrace = function (e, s) { prep++; return origPrep ? origPrep(e, s) : '' }
  ;(function inner () { return new Error().stack })()
  out.prepareStackTrace = prep
  Error.prepareStackTrace = origPrep

  out.consoleDebugLen = console.debug.length
  out.consoleNative = console.debug.toString().indexOf('[native code]') >= 0
  out.consoleOwnProps = Object.getOwnPropertyNames(console).length
  out.consoleKeys = Object.keys(console).length

  out.outer = [window.outerWidth, window.outerHeight]
  out.visibility = document.visibilityState
  out.hasFocus = document.hasFocus()
  out.screenXY = [window.screenX, window.screenY]
  out.webdriver = navigator.webdriver
  out.wdDesc = !!Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver')
  return out
})()`

async function measure(label) {
  const res = await send('Runtime.evaluate', { expression: CANDIDATES, awaitPromise: true, returnByValue: true })
  if (res.exceptionDetails) throw new Error(label + ' 异常: ' + JSON.stringify(res.exceptionDetails).slice(0, 300))
  return res.result.value
}

const before = await measure('before')
await send('Runtime.enable')
await sleep(300)
const after = await measure('after')

console.log('=== 事件计数 ===')
const counts = {}
for (const m of events) counts[m] = (counts[m] ?? 0) + 1
console.log(counts)

console.log('\n=== A/B 差异（仅列出变化的键）===')
const keys = new Set([...Object.keys(before), ...Object.keys(after)])
for (const k of keys) {
  const a = JSON.stringify(before[k])
  const b = JSON.stringify(after[k])
  if (a !== b) console.log(`  ${k}: 无 Runtime ${a}  →  Runtime.enable ${b}`)
  else console.log(`  ${k}: 不变 ${a}`)
}

ws.close()
child.kill()
await sleep(500)