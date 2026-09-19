#!/usr/bin/env node
/**
 * 受控 origin —— 完整性验收的「真值来源」。
 *
 * 思路：服务端自己记录收到的每一个请求，这份日志不依赖任何 CDP 机制。
 * 拿它和监控库里的记录做多重集比对，差出来的就是真漏抓。
 * 比「和代理对照」轻，但同样是独立信源，而且完全可控、可复现。
 *
 *   node scripts/test-origin.mjs 8777        # 单独起，手工点
 */

import { createServer } from 'node:http'

/** 1x1 透明 PNG，图像接口都用它，靠 padding 造不同大小 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

const DUP_JS = 'window.__dup = (window.__dup || 0) + 1\n'

/**
 * P3 干预验收用的探针页：把「页面实际看到的」回报给服务端。
 * 这是端到端证据 —— 规则生效与否不由引擎自己说了算，由页面说。
 */
const RULES_PROBE_PAGE = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>规则验收页</title>
<link rel="stylesheet" href="/style.css"></head>
<body>
<h1>rules probe</h1>
<script>
(async () => {
  const out = { v: '', h: '', inj: '', blocked: 'no', delay: '0', man: '', mock: '', redir: '' }
  try { out.v = String((await (await fetch('/api/fetch-get')).json()).fetch) } catch (e) { out.v = 'err' }
  try { out.h = (await fetch('/style.css')).headers.get('x-monitor-resp') || '' } catch (e) { out.h = 'err' }
  try { await fetch('/missing'); out.blocked = 'no' } catch (e) { out.blocked = 'blocked' }
  try { out.man = (await (await fetch('/manifest.webmanifest')).text()).includes('fulfilled') ? 'ok' : 'no' } catch (e) { out.man = 'err' }
  try { out.mock = (await (await fetch('/api/through-sw')).text()).includes('mocked') ? 'ok' : 'no' } catch (e) { out.mock = 'err' }
  try { out.redir = (await fetch('/api/fetch-post')).status === 404 ? 'ok' : 'no' } catch (e) { out.redir = 'err' }
  out.inj = String(window.__INJECTED__ || '')
  try { await fetch('/api/xhr-get') } catch (e) {}
  const t0 = performance.now()
  try { await fetch('/api/xhr-post', { method: 'POST', body: 'a=1' }) } catch (e) {}
  out.delay = String(Math.round(performance.now() - t0))
  await fetch('/api/rules-report?' + new URLSearchParams(out).toString())
})()
</script>
</body></html>`

/**
 * P6 行为验收用的记录页：把页面收到的**真实 DOM 输入事件**记下来。
 *
 * 为什么必须由页面记：CDP 的 Input.dispatch* 生成的是 isTrusted 的真事件，
 * 只有从页面侧看才能证明「走的是浏览器输入管线」而不是 JS 派发（§6.4）。
 * 布局刻意用绝对定位固定坐标，验收脚本才能算出精确落点。
 */
const INPUT_PROBE_PAGE = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>输入验收页</title>
<style>
  html, body { margin: 0; height: 100%; background: #fff; color: #111;
    font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
  #target { position: absolute; left: 600px; top: 300px; width: 120px; height: 44px; }
  #field { position: absolute; left: 600px; top: 400px; width: 300px; height: 28px; }
  #out { position: absolute; left: 8px; top: 8px; margin: 0; font-size: 12px; }
</style></head>
<body>
<button id="target">点我</button>
<input id="field" />
<pre id="out"></pre>
<script>
(function () {
  var rec = { moves: [], clicks: [], keys: [], wheels: [], downs: [], ups: [], startedAt: 0 }
  window.__rec = rec
  function now() { return Math.round((performance.now() - rec.startedAt) * 1000) / 1000 }
  window.__resetRec = function () {
    rec.moves.length = 0; rec.clicks.length = 0; rec.keys.length = 0
    rec.wheels.length = 0; rec.downs.length = 0; rec.ups.length = 0
    rec.startedAt = performance.now()
    var field = document.getElementById('field')
    if (field) field.value = ''
    return true
  }
  window.addEventListener('mousemove', function (e) {
    rec.moves.push({ x: e.clientX, y: e.clientY, t: now(), trusted: e.isTrusted })
  }, true)
  window.addEventListener('mousedown', function (e) { rec.downs.push({ t: now(), trusted: e.isTrusted }) }, true)
  window.addEventListener('mouseup', function (e) { rec.ups.push({ t: now(), trusted: e.isTrusted }) }, true)
  window.addEventListener('click', function (e) {
    rec.clicks.push({ x: e.clientX, y: e.clientY, target: e.target && e.target.id, t: now(), trusted: e.isTrusted })
  }, true)
  window.addEventListener('keydown', function (e) {
    rec.keys.push({ key: e.key, t: now(), trusted: e.isTrusted })
  }, true)
  window.addEventListener('wheel', function (e) {
    rec.wheels.push({ dy: e.deltaY, t: now(), trusted: e.isTrusted })
  }, true)
  setInterval(function () {
    document.getElementById('out').textContent =
      'moves=' + rec.moves.length + ' clicks=' + rec.clicks.length +
      ' keys=' + rec.keys.length + ' wheels=' + rec.wheels.length
  }, 200)
})()
</script>
</body></html>`

/**
 * §12「对页面的性能影响」用的负载页：自己量自己，把数字 post 回 origin。
 *
 * 为什么由页面报数：基线臂压根不带 CDP，只有「页面自己量、走 HTTP 报回来」
 * 这条路，三臂（无监控 / Profile L / Profile H）才量的是同一件事。
 *
 * 三段负载各打一个死角：
 *   cpu   纯计算 —— Profile L 的 Debugger/Runtime 插桩会放大每一次脚本执行
 *   dom   建 5000 个节点 + 强制同步布局 —— 量渲染管线这一侧
 *   net   120 条请求、每批 6 条并发 —— 量 Fetch 拦截与放行的开销
 * total 从导航开始到负载结束（performance.now() 的时间原点就是导航起点）
 */
/**
 * §12「对页面的性能影响」用的负载页：自己量自己，把数字 post 回 origin。
 *
 * 为什么由页面报数：基线臂压根不带 CDP，只有「页面自己量、走 HTTP 报回来」
 * 这条路，三臂（无监控 / Profile L / Profile H）才量的是同一件事。
 *
 * 为什么跑两轮、只认第二轮：
 *   第一轮吸掉的是一次性成本 —— 新 profile 的浏览器启动（实测导航到脚本开始要
 *   270ms 上下）、V8 的 JIT 预热、连接池建立。这些跟「监控」无关，却会把倍数
 *   搅成 0.5× 这种荒唐值（监控开着反而「更快」）。start / warm_* 照报不误，
 *   但它们只做参考，不进判据；判据只看稳态那一轮。
 *
 * 计分轮的三段负载：
 *   cpu   纯计算 —— Profile L 的 Debugger/Runtime 插桩会放大每一次脚本执行
 *   dom   建 5000 个节点 + 强制同步布局 —— 量渲染管线这一侧
 *   net   120 条请求、每批 6 条并发 —— 量 Fetch 拦截与放行的开销
 *   work  = cpu+dom+net，就是判据用的「页面自身负载耗时」
 */
/**
 * §7.1 面板 #3「DOM 与元素检查」用的探针页。
 *
 * 三处刻意设计的证据点：
 *   1. 同一个元素被三层规则命中（同优先级后写的 `.box`、更高优先级的 `#root .box`、
 *      元素自带的 style 属性）—— 只有把三条都列出来并正确标出「谁被盖了」，
 *      「覆盖判定」这一步才算真的做对了，不是靠猜。
 *   2. 文本节点与注释节点 —— 树的懒展开要能区分 1/3/8 三类。
 *   3. 三个元素挂了监听器，其中一个用 passive —— 事件监听器这一栏有东西可查，
 *      且不依赖 Runtime（Profile H 下也要能用）。
 */
const DOM_PROBE_PAGE = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>DOM 验收页</title>
<style>
  html, body { margin: 0; background: #fff; color: #111;
    font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
  /* 同优先级，后写的赢 → 前一条的 color 应当被判为「被覆盖」 */
  .box { color: #0000ff; border: 1px solid #cccccc; padding: 4px; }
  .box { color: #0000ee; }
  /* id + class，优先级更高 → color 实际由它决定 */
  #root .box { color: #008000; }
  #probe-inline { color: #123456; }
  #probe-attr { color: #ff00ff; }
  .deep .leaf { font-weight: 700; }
</style>
</head>
<body>
<div id="root" class="box">
  <div class="box" id="probe-style">样式覆盖判定</div>
  <div id="probe-inline" style="color: #aabbcc">行内样式最高</div>
  <div id="probe-attr" data-kind="attr" title="属性表">属性表</div>
  <div class="deep" id="probe-deep"><div class="leaf" id="probe-leaf">深层节点</div></div>
  <p id="probe-text">文本预览</p>
  <!-- DOM 验收用的注释节点 -->
  <button id="probe-btn" type="button">按钮</button>
  <form id="probe-form"><input id="probe-input" name="q" /></form>
</div>
<script>
(function () {
  window.__probe = { clicks: 0, submits: 0, inputs: 0, downs: 0 }
  var btn = document.getElementById('probe-btn')
  var form = document.getElementById('probe-form')
  var input = document.getElementById('probe-input')
  btn.addEventListener('click', function () { window.__probe.clicks += 1 })
  btn.addEventListener('pointerdown', function () { window.__probe.downs += 1 }, { passive: true })
  form.addEventListener('submit', function (e) { e.preventDefault(); window.__probe.submits += 1 })
  input.addEventListener('input', function () { window.__probe.inputs += 1 })
})()
</script>
</body></html>`
const PERF_PAGE = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>性能影响验收页</title></head>
<body>
<div id="stage"></div>
<script>
(async () => {
  const NONCE = new URLSearchParams(location.search).get('nonce') || ''
  const now = () => performance.now()
  // 透传服务端思考时间，让这一页贴着真实页面的构成（大头是网络与服务端，不是监控）
  const THINK = String(Number(new URLSearchParams(location.search).get('d') ?? 0))
  // 仪器：脚本开始执行的时刻（timeOrigin 就是导航起点）
  const start = now()

  const burn = () => {
    let acc = 0
    for (let i = 0; i < 2500000; i += 1) acc += Math.sqrt(i % 997) * 1.0000001
    return acc
  }
  const stage = document.getElementById('stage')

  const runOnce = async () => {
    const out = {}
    // 1) 纯 JS 计算
    let s = now()
    let acc = 0
    for (let k = 0; k < 3; k += 1) acc += burn()
    out.cpu = now() - s
    out.acc = Math.round(acc)

    // 2) DOM + 布局
    s = now()
    const frag = document.createDocumentFragment()
    for (let i = 0; i < 5000; i += 1) {
      const d = document.createElement('div')
      d.textContent = 'row ' + i
      frag.appendChild(d)
    }
    stage.appendChild(frag)
    const box = stage.getBoundingClientRect()
    out.dom = now() - s
    out.rows = box.height > 0 ? 1 : 0
    stage.textContent = ''

    // 3) 请求：每批 6 条并发，贴着浏览器的真实并发度
    s = now()
    let ok = 0
    for (let base = 1; base <= 120; base += 6) {
      await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          fetch('/seq/' + (base + i) + '?d=' + THINK).then((r) => r.text()).then(() => { ok += 1 })
        )
      )
    }
    out.net = now() - s
    out.ok = ok
    return out
  }

  const warm = await runOnce() // 热身轮：不计分

  // 静默：等监控容器把热身轮那 120 条请求的流水线（body 采集 → 关联 → 落库）排空。
  // 不等的话，计分轮的 cpu 段会和容器消化上一轮的排队撞在一起 ——
  // 实测能把纯 JS 计算放大到 5×，那量到的是排队，不是监控对页面的开销。
  await new Promise((resolve) => setTimeout(resolve, 2000))

  const run = await runOnce() // 计分轮
  const total = now()
  const q = new URLSearchParams({
    nonce: NONCE,
    start: start.toFixed(1),
    total: total.toFixed(1),
    warm_cpu: warm.cpu.toFixed(1),
    warm_dom: warm.dom.toFixed(1),
    warm_net: warm.net.toFixed(1),
    cpu: run.cpu.toFixed(1),
    dom: run.dom.toFixed(1),
    net: run.net.toFixed(1),
    work: (run.cpu + run.dom + run.net).toFixed(1),
    rows: String(run.rows),
    ok: String(run.ok),
    acc: String(run.acc),
    // 内核版本：验收报告里要写明这份数字是在哪个 Chrome 上量的
    ua: String(navigator.userAgent.split('Chrome/')[1] || '').split(' ')[0]
  })
  await fetch('/api/perf-report?' + q.toString())
})().catch((e) => {
  fetch('/api/perf-report?nonce=' + NONCE + '&err=' + encodeURIComponent(String(e && e.message)))
})
</script>
</body></html>`

const PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>监控容器验收页</title>
<link rel="stylesheet" href="/style.css">
<link rel="manifest" href="/manifest.webmanifest">
</head>
<body>
<h1>monitor acceptance origin</h1>
<img src="/img1.png" alt=""><img src="/img2.png" alt=""><img src="/img3.png" alt="">
<img src="/img4.png" alt=""><img src="/img5.png" alt=""><img src="/img6.png" alt="">
<img src="/img7.png" alt=""><img src="/img8.png" alt="">
<img src="/missing-image.png" alt="">
<iframe src="/iframe.html" width="200" height="80"></iframe>
<script src="/app1.js"></script>
<script src="/app2.js"></script>
<script src="/app3.js"></script>
<script src="/dup1.js"></script>
<script src="/dup2.js"></script>
<script>
window.__done = null
const results = {}

function note(key, value) { results[key] = value }

// XHR：GET + POST
const xhrGet = new XMLHttpRequest()
xhrGet.open('GET', '/api/xhr-get')
xhrGet.onload = () => note('xhrGet', xhrGet.status)
xhrGet.send()

const xhrPost = new XMLHttpRequest()
xhrPost.open('POST', '/api/xhr-post')
xhrPost.setRequestHeader('content-type', 'application/x-www-form-urlencoded')
xhrPost.onload = () => note('xhrPost', xhrPost.status)
xhrPost.send('a=1&b=2')

// fetch：GET + POST
fetch('/api/fetch-get').then((r) => note('fetchGet', r.status))
fetch('/api/fetch-post', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ hello: 'world' })
}).then((r) => note('fetchPost', r.status))

// 重定向、204、404
fetch('/redirect').then((r) => note('redirect', r.status))
fetch('/nocontent').then((r) => note('nocontent', r.status))
fetch('/missing').then((r) => note('missing', r.status))

// 无 content-length 的分块响应
fetch('/chunked').then((r) => r.text()).then((t) => note('chunked', t.length))

// 超过 body 上限的大响应
fetch('/big').then((r) => r.arrayBuffer()).then((b) => note('big', b.byteLength))

// sendBeacon
try { navigator.sendBeacon('/beacon', 'ping') } catch (e) { note('beacon', 'err') }

// SSE：服务端不主动关，验证我们不会把长连接挂在手里
try {
  const es = new EventSource('/events')
  es.onmessage = (event) => { note('sse', event.data); es.close() }
} catch (e) { note('sse', 'err') }

// Web Worker：它自己发的请求是独立 target 的流量
try {
  const worker = new Worker('/worker.js')
  worker.onmessage = (event) => note('worker', event.data)
} catch (e) { note('worker', 'err') }

// Service Worker：注册后由它接管一次 fetch
if (navigator.serviceWorker) {
  navigator.serviceWorker.register('/sw.js')
    .then(() => fetch('/api/through-sw').then((r) => note('sw', r.status)))
    .catch((e) => note('sw', 'err:' + e.message))
}

// 体量：一串动态请求，用来把漏抓率的分母撑起来
let settled = 0
const VOLUME = 150
for (let i = 1; i <= VOLUME; i += 1) {
  fetch('/seq/' + i)
    .then((r) => r.text())
    .then(() => { settled += 1 })
    .catch(() => { settled += 1 })
    .finally(() => {
      if (settled === VOLUME) window.__done = results
    })
}
</script>
</body>
</html>
`

const IFRAME = `<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="/iframe.css"></head>
<body><p>iframe</p><script src="/iframe.js"></script></body></html>
`

const WORKER_JS = `
fetch('/worker-data.json').then((r) => r.json()).then((d) => postMessage(d.ok))
`

const SW_JS = `
self.addEventListener('install', (event) => {
  event.waitUntil(fetch('/api/sw-install').then(() => self.skipWaiting()))
})
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (event) => {
  // 只旁观，不改写 —— 保证服务端看到的请求集合是确定的
})
`

function chunk(buffer, size) {
  const parts = []
  for (let offset = 0; offset < buffer.length; offset += size) {
    parts.push(buffer.subarray(offset, offset + size))
  }
  return parts
}

/**
 * 起一个受控 origin。返回 { port, requests, close }。
 * requests 就是「真值日志」，每条 { method, path, status, bytes, at }。
 */
export function startOrigin(port = 0) {
  const requests = []
  const openStreams = new Set()

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const path = url.pathname
    const entry = {
      method: req.method,
      path,
      status: 0,
      bytes: 0,
      at: Date.now(),
      query: url.search,
      // 规则改写请求头的证据：改动后的头会带在真值日志里
      probe: req.headers['x-monitor-rule'] ?? null
    }
    requests.push(entry)

    let bodyBytes = 0
    req.on('data', (c) => { bodyBytes += c.length })
    res.on('finish', () => {
      entry.status = res.statusCode
      entry.bytes = bodyBytes
    })

    const send = (status, type, payload, extraHeaders = {}) => {
      const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload))
      res.writeHead(status, {
        'content-type': type,
        'content-length': buffer.length,
        'cache-control': 'no-store',
        ...extraHeaders
      })
      res.end(buffer)
    }

    if (path === '/') return send(200, 'text/html; charset=utf-8', PAGE)
    if (path === '/rules-probe.html') return send(200, 'text/html; charset=utf-8', RULES_PROBE_PAGE)
    if (path === '/input-probe.html') return send(200, 'text/html; charset=utf-8', INPUT_PROBE_PAGE)
    if (path === '/dom-probe.html') return send(200, 'text/html; charset=utf-8', DOM_PROBE_PAGE)
    if (path === '/perf.html') return send(200, 'text/html; charset=utf-8', PERF_PAGE)
    if (path === '/style.css') {
      return send(
        200,
        'text/css',
        '@font-face{font-family:x;src:url(/font.woff2) format("woff2")}body{font-family:x;margin:0}'
      )
    }
    if (path === '/iframe.css') return send(200, 'text/css', 'p{color:#333}')
    if (path === '/iframe.js') return send(200, 'application/javascript', 'window.__iframe=1')
    if (path === '/iframe.html') return send(200, 'text/html; charset=utf-8', IFRAME)
    if (path === '/app1.js') return send(200, 'application/javascript', 'window.__a1=1')
    if (path === '/app2.js') return send(200, 'application/javascript', 'window.__a2=2')
    if (path === '/app3.js') return send(200, 'application/javascript', 'window.__a3=3')
    if (path === '/dup1.js' || path === '/dup2.js') {
      return send(200, 'application/javascript', DUP_JS)
    }
    if (path === '/worker.js') return send(200, 'application/javascript', WORKER_JS)
    if (path === '/sw.js') return send(200, 'application/javascript', SW_JS, {
      'service-worker-allowed': '/'
    })
    if (path === '/worker-data.json') return send(200, 'application/json', '{"ok":true}')
    if (path === '/manifest.webmanifest') return send(200, 'application/manifest+json', '{"name":"t"}')
    if (path === '/font.woff2') return send(200, 'font/woff2', Buffer.alloc(2048, 7))

    if (/^\/img\d+\.png$/.test(path)) {
      const index = Number(/img(\d+)/.exec(path)[1])
      return send(200, 'image/png', Buffer.concat([PNG_1X1, Buffer.alloc(index * 64, 3)]))
    }

    if (path === '/api/xhr-get') return send(200, 'application/json', '{"xhr":"get"}')
    if (path === '/api/xhr-post') return send(200, 'application/json', '{"xhr":"post"}')
    if (path === '/api/fetch-get') return send(200, 'application/json', '{"fetch":"get"}')
    if (path === '/api/fetch-post') return send(200, 'application/json', '{"fetch":"post"}')
    if (path === '/api/through-sw') return send(200, 'application/json', '{"sw":true}')
    if (path === '/api/sw-install') return send(200, 'application/json', '{"sw":"install"}')
    if (path === '/api/redirected') return send(200, 'application/json', '{"redirected":true}')
    if (path === '/beacon') return send(204, 'text/plain', '')
    if (path === '/nocontent') return send(204, 'text/plain', '')
    if (path === '/missing' || path === '/missing-image.png') {
      return send(404, 'text/plain', 'not found')
    }

    if (path === '/redirect') {
      res.writeHead(302, { location: '/api/redirected', 'content-length': '0', 'cache-control': 'no-store' })
      return res.end()
    }

    // 分块响应：故意不带 content-length
    if (path === '/chunked') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      const payload = JSON.stringify({ chunked: true, pad: 'x'.repeat(3000) })
      for (const part of chunk(Buffer.from(payload), 512)) res.write(part)
      return res.end()
    }

    // 2MB —— 超过默认 256KB 上限，应该落到 too_large
    if (path === '/big') return send(200, 'application/octet-stream', Buffer.alloc(2 * 1024 * 1024, 9))

    // SSE：连上就一直开着，验证「流式响应不取 body」的护栏
    if (path === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive'
      })
      res.write('retry: 60000\n\n')
      res.write('data: hello\n\n')
      openStreams.add(res)
      res.on('close', () => openStreams.delete(res))
      return
    }

    if (/^\/seq\/\d+$/.test(path)) {
      const n = Number(path.slice(5))
      const payload = JSON.stringify({ n, pad: 'y'.repeat(n % 200) })
      // ?d=<ms>：服务端思考时间。性能验收用它模拟真实网络 RTT + 服务端处理 ——
      // 这部分时间监控碰不到，正是真实页面里占大头的那一块。
      const think = Number(url.searchParams.get('d') ?? 0)
      if (think > 0) return setTimeout(() => send(200, 'application/json', payload), think)
      return send(200, 'application/json', payload)
    }

    if (path === '/favicon.ico') return send(200, 'image/x-icon', PNG_1X1)

    // 规则跳转的落点：页面从不直接请求它，出现在日志里就是跳转真的发生了
    if (path === '/rules-redirect-target') return send(404, 'text/plain', 'redirect target')
    if (path === '/api/rules-report') return send(200, 'application/json', '{"ok":true}')
    if (path === '/api/perf-report') return send(200, 'application/json', '{"ok":true}')

    return send(404, 'text/plain', 'unknown: ' + path)
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        requests,
        close: () =>
          new Promise((done) => {
            for (const stream of openStreams) {
              try {
                stream.destroy()
              } catch {
                /* 已经断了 */
              }
            }
            server.closeAllConnections?.()
            server.close(() => done())
          })
      })
    })
  })
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
if (isMain) {
  const port = Number(process.argv[2] ?? 8777)
  const origin = await startOrigin(port)
  console.log(`受控 origin: http://127.0.0.1:${origin.port}/`)
  console.log('把它填给 MONITOR_URL，或直接用 node scripts/verify-completeness.mjs 跑全套')
}
