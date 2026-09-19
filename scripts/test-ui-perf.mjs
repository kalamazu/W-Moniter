#!/usr/bin/env node
/**
 * 看板列表性能验收：10 万条请求下滚动还能不能跑满 60fps。
 * 对应设计文档 §12「UI 列表性能：10 万条 60fps」，也是 P2 的最后一条指标。
 *
 * 为什么探针在外部（CDP）而不塞进渲染进程：
 *   这个数字只有验收时关心，长期驻留在产品代码里是纯负担。
 *   Electron 的控制窗口本来就能挂远程调试端口，于是「把列表滚起来 +
 *   量每一帧的间隔」整个从外面注入，产品代码一行都不用改。
 *
 * 三步：
 *   1. 用存储进程灌 10 万条（走的就是线上那条 NDJSON 通道）
 *   2. 起受控 origin + 看板（带 --remote-debugging-port）
 *   3. 挂上控制窗口：先滚到底把 10 万条全加载进渲染进程，再量滚动帧率
 *
 *   node scripts/test-ui-perf.mjs [条数]
 *
 * 两个前提，不满足量出来的就不是渲染能力：
 *   1. 窗口必须真的在渲染 —— Chromium 会节流不可见/被遮挡页面的 rAF。
 *      除了显式 Page.bringToFront，还用 --disable-features=CalculateNativeWinOcclusion
 *      把「窗口被别的窗口盖住」这个判断整个关掉，否则量到的是节流策略。
 *   2. 不能给 Electron 设 windowsHide —— STARTUPINFO 的 wShowWindow 会把
 *      第一次 ShowWindow 强制成隐藏，窗口永远不显示（demo-run 踩过同一个坑）。
 */

import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = join(ROOT, 'storage', 'server.mjs')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const CLEANUP = join(ROOT, 'scripts', 'cleanup-stray.ps1')

const TOTAL = Number(process.argv[2] ?? 100000)
const CDP_PORT = Number(process.env['UI_PERF_CDP_PORT'] ?? 9444)
const ORIGIN_PORT = process.env['DEMO_ORIGIN_PORT'] ?? '8777'
const MEASURE_FRAMES = Number(process.env['UI_PERF_FRAMES'] ?? 900)
const LOAD_LIMIT_MS = 240000

/**
 * 灌进去的 seq 从 100 万起跳。真实会话的 seq 是从 0 涨的，
 * 不从高位起跳的话两条线会用同一批 (inst, seq) —— upsert 会互相覆盖。
 */
const SEQ_BASE = 1000000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 带超时且会清定时器的等待。别用 Promise.race + sleep：定时器不会取消，
 *  晚到的分支会对着已经复用掉的 pid 再来一发 taskkill，把无辜进程打死。 */
function withTimeout(promise, ms, label) {
  let timer = null
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' 超时')), ms)
  })
  return Promise.race([promise, guard]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

const results = []
function check(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
    console.log(`  \u2713 ${name}`)
  } catch (err) {
    results.push({ name, ok: false, message: err.message })
    console.log(`  \u2717 ${name}\n      ${err.message}`)
  }
}

/* ------------------------------------------------------------ 存储通道 */

class StorageClient {
  constructor(child) {
    this.child = child
    this.nextId = 1
    this.pending = new Map()
    this.carry = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.consume(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => process.stderr.write('[server] ' + chunk))
  }

  consume(chunk) {
    const text = this.carry + chunk
    let start = 0
    let index = text.indexOf('\n', start)
    while (index !== -1) {
      const line = text.slice(start, index)
      if (line.length > 0) {
        const msg = JSON.parse(line)
        if (msg.id !== undefined && msg.id !== null) {
          const slot = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          if (slot) slot(msg)
        }
      }
      start = index + 1
      index = text.indexOf('\n', start)
    }
    this.carry = text.slice(start)
  }

  send(op, args = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`op ${op} 超时`))
      }, 60000)
      this.pending.set(id, (msg) => {
        clearTimeout(timer)
        if (msg.ok) resolve(msg.result)
        else reject(new Error(`${op}: ${msg.error}`))
      })
      this.child.stdin.write(JSON.stringify({ id, op, args }) + '\n')
    })
  }

  close() {
    this.child.stdin.end()
  }
}

const TYPES = ['Document', 'Script', 'Stylesheet', 'Image', 'XHR', 'Fetch', 'Font', 'Media', 'Ping', 'Other']
const HOSTS = ['cdn.example.com', 'api.example.com', 'static.example.com', 'tracker.example.net']
const STATUSES = [200, 200, 200, 204, 304, 404, 500, 302]
const MIMES = ['text/html', 'application/javascript', 'text/css', 'image/png', 'application/json']

/** 和 test-storage.mjs 同一份样本生成器：字段必须能过 appendRequests 的列校验 */
function makeRow(seq, inst) {
  const host = HOSTS[seq % HOSTS.length]
  const type = TYPES[seq % TYPES.length]
  const status = STATUSES[seq % STATUSES.length]
  // 时间戳铺在「最近半小时」里：灌进去的数据和实时流量落在同一条时间线上，
  // 列表按时间倒序排出来才是真实的样子（否则同屏里一半 2020 年一半今天）
  const startTs = Date.now() - 1_800_000 + (seq - SEQ_BASE) * 18
  const duration = (seq % 900) + 1
  return {
    seq,
    key: `sess-${seq % 7}|${seq}`,
    request_id: `${seq}.${seq % 13}`,
    session_id: `sess-${seq % 7}`,
    target_id: 'T' + (seq % 5),
    target_type: seq % 11 === 0 ? 'service_worker' : seq % 7 === 0 ? 'worker' : 'page',
    frame_url: 'https://' + host + '/page',
    url: `https://${host}/asset/${seq}?v=${seq % 17}`,
    host,
    scheme: 'https',
    path: `/asset/${seq}`,
    query: `v=${seq % 17}`,
    method: seq % 23 === 0 ? 'POST' : 'GET',
    resource_type: type,
    initiator_type: type === 'XHR' ? 'xhr' : 'parser',
    priority: 'High',
    status,
    status_text: status === 200 ? 'OK' : 'X',
    mime_type: MIMES[seq % MIMES.length],
    protocol: 'h2',
    remote_ip: '93.184.216.34',
    remote_port: 443,
    req_headers: JSON.stringify({ accept: '*/*' }),
    resp_headers: JSON.stringify({ 'content-type': MIMES[seq % MIMES.length] }),
    req_body: null,
    encoded_len: (seq % 5000) + 100,
    decoded_len: (seq % 6000) + 120,
    from_cache: seq % 5 === 0,
    from_sw: seq % 11 === 0,
    ttfb_ms: 10 + (seq % 200),
    duration_ms: duration,
    start_ts: startTs,
    end_ts: startTs + duration,
    failed: status === 500 ? 'net::ERR_FAILED' : null,
    canceled: false
  }
}

/* ---------------------------------------------------------------- CDP */

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
    // 目标没了必须让等在上面的调用立刻失败，不然就是干等到超时
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
}

async function openCdp(wsUrl) {
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

/** 控制窗口是个 file:// 的 page 目标；受控浏览器的调试端口在它自己的管道上，不会串味 */
async function waitControlTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      const list = await res.json()
      const hit = list.find((t) => t.type === 'page' && String(t.url).includes('index.html'))
      if (hit && hit.webSocketDebuggerUrl) return hit
    } catch {
      /* 端口还没起来，继续等 */
    }
    await sleep(400)
  }
  return null
}

/* --------------------------------------------------------------- 探针 */

const PROBE = `
(async () => {
  const frames = (n) => new Promise((resolve) => {
    let left = n
    const tick = () => {
      if (--left <= 0) resolve()
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  // 调试目标一出现就挂上来了，这时 React 往往还没挂载 ——
  // 必须等元素出现，而不是查一次没有就判死
  const waitFor = async (selector, ms) => {
    const started = performance.now()
    while (performance.now() - started < ms) {
      const node = document.querySelector(selector)
      if (node) return node
      await frames(3)
    }
    return null
  }
  const el = await waitFor('.rtable-body', 30000)
  if (!el) return { ok: false, reason: 'no-rtable-body: html=' + document.body.innerHTML.length }

  // 底部那行「已加载 X / Y 条」是唯一能同时看到 loaded 和 total 的地方。
  // 只认数字，不依赖文案。
  const readFoot = () => {
    const node = document.querySelector('.rtable-foot')
    const nums = node ? (node.textContent.match(/[0-9]+/g) || []).map(Number) : []
    return { loaded: nums[0] || 0, total: nums[1] || 0 }
  }

  // 等第一页到位（存储进程可能还在开库）
  const waitStart = performance.now()
  let state = readFoot()
  while (state.total === 0 && performance.now() - waitStart < 60000) {
    await frames(3)
    state = readFoot()
  }
  if (state.total === 0) return { ok: false, reason: 'no-data' }

  // 阶段一：一直滚到底，逼 useRequests 一页页把全部数据加载进渲染进程。
  // 滚到底才触发 handleScroll 里的 loadMore；行数涨了 scrollHeight 才涨，
  // 所以「赋值 -> 等两帧 -> 再看加载数」这个循环天然自推进。
  const loadStart = performance.now()
  let lastLoaded = -1
  let stalled = 0
  while (performance.now() - loadStart < ${LOAD_LIMIT_MS}) {
    state = readFoot()
    if (state.loaded >= state.total) break
    el.scrollTop = el.scrollHeight
    await frames(2)
    const now = readFoot()
    if (now.loaded === lastLoaded) stalled++
    else {
      stalled = 0
      lastLoaded = now.loaded
    }
    if (stalled > 600) break
  }
  const loadMs = Math.round(performance.now() - loadStart)
  const loadedState = readFoot()

  // 阶段二：在列表的头/中/尾三处连续滚，量相邻两帧的间隔。
  //
  // 这里刻意不用「每帧跳一屏」的走法：那样每帧 46 行全换，比任何人手都快，
  // 量出来的是极限压力而不是 60fps 这条线。真实滚轮/拖拽大约每帧十几到几十像素，
  // 这里取每帧 240px（约 9 行、20% 的可见行换掉），已经偏激进。
  // 整条列表 260 万像素，按这个速度从头走到尾要一百多秒，所以抽样三处各 300 帧。
  const range = Math.max(1, el.scrollHeight - el.clientHeight)
  const STEP = 240
  const PER_REGION = Math.max(60, Math.round(${MEASURE_FRAMES} / 3))
  const samples = []
  let elapsed = 0
  for (const anchor of [0.02, 0.5, 0.985]) {
    const origin = Math.round(range * anchor)
    el.scrollTop = origin
    await frames(3)
    let index = 0
    let previous = performance.now()
    const regionStart = previous
    await new Promise((resolve) => {
      const tick = () => {
        const now = performance.now()
        if (index > 0) samples.push(now - previous)
        previous = now
        index++
        const next = el.scrollTop + STEP
        el.scrollTop = next > range ? origin : next
        if (index < PER_REGION) requestAnimationFrame(tick)
        else resolve()
      }
      requestAnimationFrame(tick)
    })
    elapsed += performance.now() - regionStart
  }
  // 附：极限压力。每帧跳一屏（range/420），整窗可见行全换 —— 比任何人手都快。
  // 这一组不进判据，只用来看真实速度下还剩多少余量。
  const stress = []
  el.scrollTop = 0
  await frames(3)
  const bigStep = Math.max(240, Math.round(range / 420))
  let sIndex = 0
  let sPrevious = performance.now()
  const stressStart = sPrevious
  await new Promise((resolve) => {
    const tick = () => {
      const now = performance.now()
      if (sIndex > 0) stress.push(now - sPrevious)
      sPrevious = now
      sIndex++
      const next = el.scrollTop + bigStep
      el.scrollTop = next >= range ? 0 : next
      if (sIndex < ${MEASURE_FRAMES}) requestAnimationFrame(tick)
      else resolve()
    }
    requestAnimationFrame(tick)
  })
  const stressElapsed = performance.now() - stressStart
  stress.sort((a, b) => a - b)

  samples.sort((a, b) => a - b)
  const at = (p) => samples[Math.min(samples.length - 1, Math.floor(p * (samples.length - 1)))]
  const round = (v) => Math.round(v * 100) / 100
  const median = at(0.5)
  return {
    ok: true,
    loaded: loadedState.loaded,
    total: loadedState.total,
    loadMs,
    stalled,
    scrollRange: range,
    frames: samples.length,
    elapsedMs: Math.round(elapsed),
    fps: round((samples.length * 1000) / elapsed),
    medianMs: round(median),
    p95Ms: round(at(0.95)),
    p99Ms: round(at(0.99)),
    maxMs: round(samples[samples.length - 1]),
    over16: samples.filter((d) => d > 16.7).length,
    over33: samples.filter((d) => d > 33.4).length,
    dropped: samples.filter((d) => d > median * 1.5).length,
    stress: {
      frames: stress.length,
      fps: round((stress.length * 1000) / stressElapsed),
      medianMs: round(stress[Math.floor(stress.length / 2)]),
      p95Ms: round(stress[Math.min(stress.length - 1, Math.floor(0.95 * (stress.length - 1)))]),
      maxMs: round(stress[stress.length - 1]),
      over16: stress.filter((d) => d > 16.7).length
    }
  }
})()
`

/* --------------------------------------------------------------- 主流程 */

function cleanupStray() {
  try {
    execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CLEANUP, '-Root', ROOT],
      { encoding: 'utf8', timeout: 60000 }
    )
  } catch {
    /* 清理失败不影响本次结果 */
  }
}

function killTree(pid) {
  if (!pid) return
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    /* 进程可能已经退了 */
  }
}

async function main() {
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '')
  const dir = join(ROOT, '.userdata', `uiperf-${stamp}`)
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, 'monitor.db')

  cleanupStray()

  console.log(`\n== 灌数据（${TOTAL} 条） ==`)
  const client = new StorageClient(spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] }))
  await client.send('open', { dbPath, config: { storeBodies: false } })

  // Electron 启动时会自己 beginInstance。那个自增号我们不去动它，而是直接把
  // 数据挂到「它将会拿到的号」上（= 当前已用的最大号 + 1）。这样既不用删实例行，
  // 也不用碰 sqlite_sequence，结果还是确定的。
  await client.send('beginInstance', {
    url: 'ui-perf-fixture',
    profile: 'L',
    kernel: 'fixture',
    kernelVersion: 'fixture'
  })
  const peek = new DatabaseSync(dbPath)
  const seqRow = peek.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'instances'").get()
  peek.close()
  const inst = Number(seqRow?.seq ?? 0) + 1

  const rows = Array.from({ length: TOTAL }, (_, i) => makeRow(i + SEQ_BASE, inst))
  const BATCH = 2000
  const writeStart = Date.now()
  for (let i = 0; i < TOTAL; i += BATCH) {
    await client.send('appendRequests', { inst, rows: rows.slice(i, i + BATCH) })
  }
  console.log(`  ${TOTAL} 条 / ${Date.now() - writeStart}ms  (inst=${inst}, seq 自 ${SEQ_BASE} 起)`)

  client.close()
  await withTimeout(
    once(client.child, 'exit').then(() => true),
    8000,
    '存储进程退出'
  ).catch(() => {
    killTree(client.child.pid)
    return false
  })

  console.log('\n== 起看板 ==')
  const origin = spawn(process.execPath, ['scripts/test-origin.mjs', ORIGIN_PORT], {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true
  })
  await sleep(1200)

  const logPath = join(dir, 'app.log')
  const logFd = openSync(logPath, 'a')
  const app = spawn(
    ELECTRON,
    [
      'out/main/index.js',
      '--no-sandbox',
      `--remote-debugging-port=${CDP_PORT}`,
      // 窗口被别的窗口盖住时 Chromium 会停渲染/降 rAF，量出来就不是渲染能力了
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion'
    ],
    {
      cwd: ROOT,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        MONITOR_URL: `http://127.0.0.1:${ORIGIN_PORT}/`,
        MONITOR_DATA_DIR: dir,
        MONITOR_DB: dbPath,
        MONITOR_UI_TAB: 'list',
        MONITOR_CAPTURE_BODIES: '0',
        MONITOR_CAPTURE_SCRIPTS: '0',
        MONITOR_AUTO_QUIT_MS: '0'
      }
    }
  )
  console.log(`  electron pid=${app.pid}  cdp=${CDP_PORT}`)

  let report = null
  let failure = null
  try {
    const target = await waitControlTarget(60000)
    if (!target) throw new Error('等不到控制窗口的调试目标')
    const cdp = await openCdp(target.webSocketDebuggerUrl)
    await cdp.send('Page.bringToFront').catch(() => {})

    console.log('\n== 滚起来 ==')
    // 调试目标是在文档切换的当口冒出来的，挂上去时上下文可能刚被销毁。
    // 这种错重试就行；别的错（比如探针自己有语法问题）必须立刻抛出来。
    let lastError = null
    for (let attempt = 1; attempt <= 4 && !report; attempt++) {
      try {
        const evaluated = await withTimeout(
          cdp.send('Runtime.evaluate', {
            expression: PROBE,
            awaitPromise: true,
            returnByValue: true,
            timeout: LOAD_LIMIT_MS + 120000
          }),
          LOAD_LIMIT_MS + 180000,
          '探针'
        )
        if (evaluated?.exceptionDetails) {
          throw new Error(evaluated.exceptionDetails.exception?.description ?? '探针抛异常')
        }
        report = evaluated?.result?.value ?? null
        if (!report) throw new Error('探针没回结果：' + JSON.stringify(evaluated).slice(0, 400))
      } catch (err) {
        lastError = err
        if (!/destroyed|Cannot find context|Target closed|Target crashed/i.test(err.message)) throw err
        if (attempt < 4) await sleep(1000)
      }
    }
    if (!report) throw lastError ?? new Error('探针没结果')
  } catch (err) {
    failure = err
  } finally {
    killTree(app.pid)
    killTree(origin.pid)
    cleanupStray()
  }

  if (failure) {
    console.log('\n== 结果 ==')
    console.log(`  \u2717 跑挂了: ${failure.message}`)
    try {
      const tail = readFileSync(logPath, 'utf8').slice(-2000)
      if (tail.trim()) console.log('  --- app.log 尾部 ---\n' + tail)
    } catch {
      /* 日志读不到就算了 */
    }
    process.exitCode = 1
    return
  }

  if (!report.ok) {
    console.log(`\n  \u2717 探针拒绝跑: ${report.reason}`)
    process.exitCode = 1
    return
  }

  console.log('\n== 结果 ==')
  console.log(
    `  加载 ${report.loaded}/${report.total} 条用了 ${report.loadMs}ms` +
      (report.stalled > 0 ? `（中途卡了 ${report.stalled} 帧没涨）` : '')
  )
  console.log(
    `  滚动 ${report.frames} 帧 / ${report.elapsedMs}ms = ${report.fps}fps\n` +
      `  帧间隔 p50 ${report.medianMs}ms  p95 ${report.p95Ms}ms  p99 ${report.p99Ms}ms  max ${report.maxMs}ms\n` +
      `  >16.7ms ${report.over16} 帧  >33.4ms ${report.over33} 帧  掉帧(>1.5x p50) ${report.dropped} 帧`
  )
  if (report.stress) {
    console.log(
      `  [参考·不进判据] 极限压力（每帧整屏换行）${report.stress.frames} 帧 = ${report.stress.fps}fps，` +
        `p50 ${report.stress.medianMs}ms  p95 ${report.stress.p95Ms}ms  max ${report.stress.maxMs}ms  ` +
        `>16.7ms ${report.stress.over16} 帧`
    )
  }
  if (report.medianMs > 100) {
    console.log('  ! p50 远大于 16.7ms，窗口多半没在渲染，rAF 被节流了 —— 这组数不算数')
  }

  writeFileSync(join(dir, 'ui-perf.json'), JSON.stringify(report, null, 2), 'utf8')

  // total 会略大于灌进去的条数：看板自己跑起来的那次会话也在同一个库里落行
  check(`库里至少有 ${TOTAL} 条`, () => assert.ok(report.total >= TOTAL, `实际 ${report.total}`))
  check('全部加载进了渲染进程（不是只翻了前几页）', () =>
    assert.equal(report.loaded, report.total))
  check('滚动平均帧率 >= 55fps', () => assert.ok(report.fps >= 55, `实际 ${report.fps}fps`))
  check('p95 帧间隔 <= 16.7ms（95% 的帧在 60fps 预算内）', () =>
    assert.ok(report.p95Ms <= 16.7, `实际 ${report.p95Ms}ms`))
  check('长帧(>33ms)占比 < 1%', () =>
    assert.ok(report.over33 / report.frames < 0.01, `实际 ${report.over33}/${report.frames}`))

  console.log(`  报告 ${join(dir, 'ui-perf.json')}`)
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) process.exitCode = 1
}

await main()
