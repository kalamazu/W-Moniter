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

import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

/** 1x1 透明 PNG，图像接口都用它，靠 padding 造不同大小 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

const DUP_JS = 'window.__dup = (window.__dup || 0) + 1\n'

/** 固定正文：不管谁来取、取几次，字节完全一致 —— 用来验「共享响应体」 */
const DUP_BODY = JSON.stringify({ kind: 'dup-body', note: 'same bytes every time', pad: 'z'.repeat(120) })

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

const RT_PAGE = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>实时分析验收页</title></head>
<body>
<h1>realtime probe</h1>
<script>
(async () => {
  const params = new URLSearchParams(location.search)
  const phase = params.get('phase') || '1'
  const peer = params.get('peer') || ''
  const out = { phase, ws: '', wsrecv: '', wsmsg: '', api: '', apiStatus: '', echoB: '', dup: '', peer: '', dl: 'no' }

  // 1) WebSocket：只在 phase1 跑 —— 真值日志里就一次握手，判据才是确定的
  if (phase === '1') {
    try {
      const ws = new WebSocket('ws://' + location.host + '/ws-probe')
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ws timeout')), 8000)
        ws.onopen = () => { clearTimeout(timer); resolve() }
        ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')) }
      })
      out.ws = 'open'
      const got = (predicate) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('frame timeout')), 8000)
        ws.addEventListener('message', (event) => {
          const text = typeof event.data === 'string' ? event.data : '(binary)'
          if (!predicate(text)) return
          clearTimeout(timer)
          resolve(text)
        })
      })
      // 先把两个监听挂上再发，免得回声比监听先到
      const pushed = got((text) => text.indexOf('server-push') === 0)
      const echoed = got((text) => text.indexOf('echo:') === 0)
      ws.send('hello-from-page')
      out.wsrecv = await pushed
      out.wsmsg = await echoed
      ws.close()
    } catch (error) { out.ws = 'err:' + error.message }
  }

  // 2) 带 JSON body 的接口：每轮 3 次（「调用节奏」要 >= 3 个样本才算得出来）。
  //    phase2 的响应多一个字段，契约回归就靠它证明看得见变化
  try {
    let last = null
    for (let i = 0; i < 3; i += 1) {
      const body = { user: phase === '2' ? 'bob' : 'amy', n: i + 1 }
      if (phase === '2') body.extra = true
      const res = await fetch('/api/json-echo?token=tk-1&page=' + phase + '-' + i, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
      out.apiStatus = String(res.status)
      last = await res.json()
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    out.api = JSON.stringify(last)
  } catch (error) { out.api = 'err:' + error.message }

  // 3) 第二个接口，共用同一个 token —— 关联分析要看得见「同值参数跨端点」
  try {
    const res = await fetch('/api/json-echo-b?token=tk-1&phase=' + phase)
    out.echoB = String((await res.json()).name)
  } catch (error) { out.echoB = 'err:' + error.message }

  // 4) 同一份响应体被两个不同地址取到 —— 「共享响应体（重复资源）」的靶子
  try {
    const a = await fetch('/api/dup-body.json?v=' + phase)
    const b = await fetch('/api/dup-body.json?v=' + phase + 'b')
    out.dup = String((await a.text()).length + '+' + (await b.text()).length)
  } catch (error) { out.dup = 'err:' + error.message }

  // 5) 跨域资源：换一个端口就是另一个 origin，页面 → 域的关联要看得见它。
  //    用 onload/onerror 都放行的写法：验的是「请求发生了」，不是「图片能解码」
  if (peer) {
    try {
      await new Promise((resolve) => {
        const img = new Image()
        const done = () => resolve()
        img.onload = done
        img.onerror = done
        img.src = 'http://127.0.0.1:' + peer + '/img1.png?from=realtime'
        setTimeout(done, 3000)
      })
      out.peer = 'requested'
    } catch (error) { out.peer = 'err:' + error.message }
  }

  // 6) 下载：只在 phase2 触发一次（同一个页面里第二次下载会被浏览器拦下来问）
  if (phase === '2') {
    try {
      const link = document.createElement('a')
      link.href = '/download.txt'
      link.download = 'monitor-rt-download.txt'
      document.body.appendChild(link)
      link.click()
      out.dl = 'clicked'
    } catch (error) { out.dl = 'err:' + error.message }
  }

  await fetch('/api/rt-report?' + new URLSearchParams(out).toString())
})().catch((error) => {
  fetch('/api/rt-report?err=' + encodeURIComponent(String(error && error.message)))
})
</script>
</body>
</html>`

const DIALOG_PAGE = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>对话框验收页</title></head>
<body>
<h1>dialog probe</h1>
<script>
// alert 会挂住渲染进程（采集也跟着停）—— 正是要验的那件事：
// 只有真的应答了，下面这行才跑得到，服务端才会收到回报
alert('monitor-dialog-probe')
fetch('/api/rt-report?dialog=dismissed').catch(() => {})
</script>
</body>
</html>`

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

const CAPTURE_MATRIX_PAGE = `<!doctype html><meta charset="utf-8"><title>capture matrix</title>
<script>
(async () => {
  const result = { page: true }
  const attempt = async (key, work) => { try { result[key] = await work() } catch (error) { result[key] = { error: String(error) } } }
  await attempt('binary', async () => {
    const bytes = await (await fetch('/matrix-binary')).arrayBuffer()
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((x) => x.toString(16).padStart(2, '0')).join('')
    return { bytes: bytes.byteLength, hash }
  })
  if (!new URLSearchParams(location.search).has('skipUpload')) await attempt('upload', async () => {
    const bytes = new Uint8Array(2 * 1024 * 1024).fill(71)
    return await (await fetch('/matrix-upload', { method: 'POST', body: bytes })).json()
  })
  await attempt('stream', async () => {
    const response = await fetch('/matrix-stream')
    const reader = response.body.getReader()
    let bytes = 0
    for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength }
    return { bytes }
  })
  await attempt('truncated', async () => { await (await fetch('/matrix-truncate')).arrayBuffer(); return { complete: true } })
  await attempt('aborted', async () => {
    const controller = new AbortController()
    const pending = fetch('/matrix-slow', { signal: controller.signal }).then((response) => response.arrayBuffer())
    setTimeout(() => controller.abort(), 250)
    await pending
    return { complete: true }
  })
  await attempt('cache', async () => {
    const cache = await caches.open('matrix-v1')
    await cache.add('/matrix-cache')
    return { stored: !!(await cache.match('/matrix-cache')) }
  })
  await attempt('serviceWorker', async () => {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    await navigator.serviceWorker.ready
    return { ready: true, status: (await fetch('/api/through-sw')).status }
  })
  await attempt('sse', () => new Promise((resolve, reject) => {
    const stream = new EventSource('/events')
    const timer = setTimeout(() => { stream.close(); reject(new Error('sse timeout')) }, 8000)
    stream.onmessage = (event) => { clearTimeout(timer); stream.close(); resolve(event.data) }
    stream.onerror = () => { clearTimeout(timer); stream.close(); reject(new Error('sse error')) }
  }))
  await attempt('ws', () => new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://' + location.host + '/ws-probe')
    const timer = setTimeout(() => { ws.close(); reject(new Error('ws timeout')) }, 8000)
    ws.onopen = () => ws.send('matrix-message')
    ws.onmessage = (event) => { if (String(event.data).includes('echo:matrix-message')) { clearTimeout(timer); ws.close(); resolve(String(event.data)) } }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')) }
  }))
  await attempt('download', async () => {
    const link = document.createElement('a'); link.href = '/matrix-download'; link.download = 'matrix-download.bin'
    document.body.append(link); link.click(); link.remove()
    return { clicked: true }
  })
  await fetch('/matrix-report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(result) })
})()
</script>`

/** 服务端 → 客户端不加掩码（RFC6455 对方向的规定）。长度按 7 / 16 / 64 位分档 */
function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const length = payload.length
  let head
  if (length < 126) {
    head = Buffer.from([0x81, length])
  } else if (length < 65536) {
    head = Buffer.alloc(4)
    head[0] = 0x81
    head[1] = 126
    head.writeUInt16BE(length, 2)
  } else {
    head = Buffer.alloc(10)
    head[0] = 0x81
    head[1] = 127
    head.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([head, payload])
}

function encodeCloseFrame() {
  return Buffer.from([0x88, 0x00])
}

/**
 * 解析客户端帧（浏览器发的帧一定带掩码）。半包留着下次接着解 —— 真实现的骨架。
 * 自己实现而不是引 ws：这里要的就是「服务端侧看到了什么」，多一层库反而看不清。
 */
function decodeFrames(buffer) {
  const frames = []
  let offset = 0
  for (;;) {
    if (buffer.length - offset < 2) break
    const opcode = buffer[offset] & 0x0f
    const second = buffer[offset + 1]
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let p = offset + 2
    if (length === 126) {
      if (buffer.length - p < 2) break
      length = buffer.readUInt16BE(p)
      p += 2
    } else if (length === 127) {
      if (buffer.length - p < 8) break
      length = Number(buffer.readBigUInt64BE(p))
      p += 8
    }
    const maskLength = masked ? 4 : 0
    if (buffer.length - p < maskLength + length) break
    const mask = masked ? buffer.subarray(p, p + 4) : null
    p += maskLength
    const payload = Buffer.from(buffer.subarray(p, p + length))
    if (mask) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
    }
    p += length
    offset = p
    frames.push({ opcode, payload: opcode === 0x1 ? payload.toString('utf8') : '' })
  }
  return { frames, rest: buffer.subarray(offset) }
}

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
/**
 * 站点资源探针页：把「浏览器里能存东西的地方」全都真写一遍 —— localStorage /
 * sessionStorage / cookie / IndexedDB / CacheStorage / Service Worker。
 *
 * 写完不是自己宣布成功，而是把每块的结果原样回报给 origin
 * （/api/sitedata-report?phase=1&info=...）。这样验收的火药味就在外部：
 * 服务端记下的这份回报 vs 我们从 CDP 扫回来的那份，必须对得上。
 */
const SITEDATA_PAGE = `
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>sitedata-probe</title></head>
<body>
<div id="out">running</div>
<script>
async function report(info) {
  try {
    await fetch('/api/sitedata-report?phase=1&info=' + encodeURIComponent(JSON.stringify(info)))
  } catch (err) {}
}
async function openIdb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('sd_db', 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
async function main() {
  const out = {}
  try {
    localStorage.setItem('sd_alpha', 'A1')
    localStorage.setItem('sd_beta', 'B1')
    sessionStorage.setItem('sd_sess', 'S1')
    document.cookie = 'sd_js=C1; path=/'
    out.storage = 'ok'
  } catch (err) { out.storage = String(err) }

  try {
    const db = await openIdb()
    await new Promise((resolve, reject) => {
      const tx = db.transaction('items', 'readwrite')
      tx.objectStore('items').put({ id: 1, v: 'idb1' })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
    out.idb = 'ok'
  } catch (err) { out.idb = String(err) }

  try {
    const cache = await caches.open('sd_cache')
    await cache.add(new Request('/api/sd-asset', { cache: 'no-cache' }))
    out.cache = 'ok'
  } catch (err) { out.cache = String(err) }

  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    await navigator.serviceWorker.ready
    out.sw = 'ok'
  } catch (err) { out.sw = String(err) }

  // 带 Set-Cookie 的响应：这条专门用来验「cookie 变了，是谁改的」
  try {
    await fetch('/api/sd-set-cookie', { cache: 'no-store' })
    out.setCookie = 'ok'
  } catch (err) { out.setCookie = String(err) }

  document.getElementById('out').textContent = 'done'
  await report(out)
}
main()
</script>
</body>
</html>
`
export function startOrigin(port = 0) {
  const requests = []
  const matrixReports = []
  const streamReports = []
  const authSessions = new Map()
  const openStreams = new Set()
  /** WS 双向真值日志：handshake / in（页面发出）/ out（服务端发出）/ close */
  const wsLog = []
  const wsSockets = new Set()

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const path = url.pathname
    const entry = {
      method: req.method,
      path,
      status: 0,
      bytes: 0,
      receivedBytes: 0,
      at: Date.now(),
      query: url.search,
      // 规则改写请求头的证据：改动后的头会带在真值日志里
      probe: req.headers['x-monitor-rule'] ?? null,
      // 站点资源验收要看「这条请求带出去了哪些 cookie」—— 只有服务端侧才算数
      cookie: req.headers.cookie ?? null
    }
    requests.push(entry)

    let bodyBytes = 0
    const bodyDigest = path === '/matrix-upload' ? createHash('sha256') : null
    // 顺手留一份请求体文本（只给 /api/json-echo 用）—— 契约回归要看得见「请求体多了个字段」
    let bodyText = ''
    req.on('data', (c) => {
      bodyBytes += c.length
      entry.receivedBytes = bodyBytes
      bodyDigest?.update(c)
      if (bodyText.length < 65536) bodyText += c.toString('utf8')
    })
    res.on('finish', () => {
      entry.status = res.statusCode
      entry.bytes = bodyBytes
      entry.finishedAt = Date.now()
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
    if (path === '/capture-matrix.html') return send(200, 'text/html; charset=utf-8', CAPTURE_MATRIX_PAGE)
    if (path === '/stream-test.html') return send(200, 'text/html; charset=utf-8', `<!doctype html><meta charset="utf-8"><title>stream test</title><script>
      (async () => { const mb = Number(new URLSearchParams(location.search).get('mb') || 100);
        const response = await fetch('/stream-test-data?mb=' + mb);
        const reader = response.body.getReader(); let bytes = 0;
        for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length }
        await fetch('/stream-test-report', { method:'POST', body:JSON.stringify({ mb, bytes, ok:response.ok }) });
      })().catch(error => fetch('/stream-test-report', {method:'POST', body:JSON.stringify({ error:String(error) })}));
      </script>`)
    if (path === '/stream-test-data') {
      const mb = Number(url.searchParams.get('mb'))
      if (![100, 1024].includes(mb)) return send(400, 'text/plain', 'invalid size')
      const block = Buffer.alloc(1024 * 1024, 73)
      const hash = createHash('sha256')
      for (let i = 0; i < mb; i += 1) hash.update(block)
      entry.bodyHash = hash.digest('hex')
      entry.sentBytes = 0
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(mb * block.length), 'cache-control': 'no-store' })
      for (let i = 0; i < mb && !res.destroyed; i += 1) {
        entry.sentBytes += block.length
        if (!res.write(block)) await new Promise(resolve => res.once('drain', resolve))
      }
      return res.end()
    }
    if (path === '/stream-test-report') {
      await new Promise(resolve => req.readableEnded ? resolve() : req.once('end', resolve))
      try { streamReports.push(JSON.parse(bodyText)) } catch { streamReports.push({ error: 'invalid_report' }) }
      return send(200, 'application/json', '{"ok":true}')
    }
    if (path === '/auth/login') {
      const account = String(url.searchParams.get('account') ?? '').slice(0, 80)
      if (!account) return send(400, 'text/plain', 'account required')
      const token = randomUUID()
      authSessions.set(token, account)
      return send(200, 'text/html; charset=utf-8', `<h1>Logged in: ${account.replaceAll('<', '&lt;')}</h1>`,
        { 'set-cookie': `auth_session=${token}; HttpOnly; SameSite=Lax; Path=/` })
    }
    if (path === '/auth/whoami') {
      const token = /(?:^|;\s*)auth_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
      const account = token ? authSessions.get(token) : null
      if (account === 'slow') await new Promise(resolve => setTimeout(resolve, 8000))
      return account ? send(200, 'application/json', JSON.stringify({ account })) : send(401, 'application/json', '{"error":"logged_out"}')
    }
    if (path === '/auth/logout' || path === '/auth/expire') {
      const token = /(?:^|;\s*)auth_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
      if (token) authSessions.delete(token)
      return send(200, 'text/html; charset=utf-8', '<h1>Logged out</h1>',
        path === '/auth/logout' ? { 'set-cookie': 'auth_session=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/' } : {})
    }
    if (path === '/matrix-binary') return send(200, 'application/octet-stream', Buffer.alloc(2 * 1024 * 1024, 37))
    if (path === '/matrix-cache') return send(200, 'application/json', '{"cached":true}', { 'cache-control': 'max-age=3600' })
    if (path === '/matrix-download') return send(200, 'application/octet-stream', Buffer.alloc(4096, 51), { 'content-disposition': 'attachment; filename="matrix-download.bin"' })
    if (path === '/matrix-stream') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' })
      for (let n = 0; n < 3; n += 1) res.write(Buffer.alloc(256 * 1024, n + 1))
      return res.end()
    }
    if (path === '/matrix-truncate') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '65536', 'cache-control': 'no-store' })
      res.write(Buffer.alloc(1024, 4))
      return setTimeout(() => res.destroy(), 50)
    }
    if (path === '/matrix-slow') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' })
      res.write(Buffer.alloc(1024, 5))
      return setTimeout(() => { if (!res.destroyed) res.end(Buffer.alloc(1024, 6)) }, 3000)
    }
    if (path === '/matrix-upload' || path === '/matrix-report') {
      await new Promise((resolve) => req.readableEnded ? resolve() : req.once('end', resolve))
      if (path === '/matrix-upload') {
        const hash = bodyDigest.digest('hex')
        entry.bodyHash = hash
        return send(200, 'application/json', JSON.stringify({ bytes: bodyBytes, hash }))
      }
      try { matrixReports.push(JSON.parse(bodyText)) } catch { matrixReports.push({ error: 'invalid_report' }) }
      return send(200, 'application/json', '{"ok":true}')
    }
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

    /* ---- 实时分析验收用的路由（老页面不引用它们，老验收的请求集合不受影响） ---- */

    if (path === '/realtime.html') return send(200, 'text/html; charset=utf-8', RT_PAGE)
    if (path === '/dialog.html') return send(200, 'text/html; charset=utf-8', DIALOG_PAGE)
    if (path === '/download.txt') {
      return send(200, 'text/plain; charset=utf-8', 'monitor-download-payload\n', {
        'content-disposition': 'attachment; filename="monitor-rt-download.txt"'
      })
    }
    if (path === '/api/rt-report') return send(200, 'application/json', '{"ok":true}')
    /* ---- 站点资源验收用的路由（同样只给新页面用） ---- */

    if (path === '/sitedata.html') return send(200, 'text/html; charset=utf-8', SITEDATA_PAGE)
    // 要进 CacheStorage 的东西：必须自己带上可缓存的头，否则 Cache.add 会拒收
    if (path === '/api/sd-asset') {
      return send(200, 'application/json', JSON.stringify({ asset: 1 }), { 'cache-control': 'max-age=300' })
    }
    // 归因用：这条响应带 Set-Cookie，验收里要能看到事件指向它
    if (path === '/api/sd-set-cookie') {
      return send(200, 'application/json', JSON.stringify({ set: 1 }), {
        'set-cookie': 'sd_http=H1; Path=/; Max-Age=3600'
      })
    }
    if (path === '/api/sitedata-report') return send(200, 'application/json', '{"ok":true}')
    if (path === '/api/json-echo') {
      // body 是异步到的：不等它收完，读到的就是空对象
      await new Promise((resolve) => {
        if (req.readableEnded) return resolve()
        req.on('end', resolve)
        req.on('error', resolve)
      })
      // 请求体带 extra 才多给一个字段 —— 契约回归就靠这个「多出来的字段」证明它看得见变化
      let parsed = null
      try {
        parsed = JSON.parse(bodyText || '{}')
      } catch {
        parsed = null
      }
      const payload = {
        ok: true,
        name: 'json-echo',
        echo: { user: (parsed && parsed.user) ?? null, n: (parsed && parsed.n) ?? null },
        items: [1, 2, 3],
        meta: { source: 'probe' }
      }
      if (parsed && parsed.extra) payload.bonus = { deep: true }
      return send(200, 'application/json', JSON.stringify(payload))
    }

    // 与 json-echo 共用同一个 token：关联分析要看得见「同值参数跨端点」
    if (path === '/api/json-echo-b') {
      return send(200, 'application/json', JSON.stringify({ ok: true, name: 'json-echo-b' }))
    }

    // 固定正文：两个不同 URL 拿到同一份字节 —— 共享响应体（重复资源）的靶子
    if (path === '/api/dup-body.json') {
      return send(200, 'application/json', DUP_BODY)
    }

    return send(404, 'text/plain', 'unknown: ' + path)
  })

  /*
   * 真 WebSocket 握手 + 双向帧。
   *
   * Node 的 http server 对 Upgrade 请求不走 request 监听器，所以这里单独接管；
   * wsLog 就是「服务端侧的真值」：收到了什么、发出了什么，一条不落。
   */
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname !== '/ws-probe') {
      socket.destroy()
      return
    }
    const key = req.headers['sec-websocket-key']
    if (!key) {
      socket.destroy()
      return
    }
    const accept = createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    )
    wsSockets.add(socket)
    wsLog.push({ dir: 'handshake', data: url.search, at: Date.now() })
    // 握手后服务端主动推一条：这条要与库里「收到的帧」逐字对上
    const push = 'server-push-1'
    socket.write(encodeTextFrame(push))
    wsLog.push({ dir: 'out', data: push, at: Date.now() })

    let buffer = Buffer.alloc(0)
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data])
      const parsed = decodeFrames(buffer)
      buffer = parsed.rest
      for (const frame of parsed.frames) {
        if (frame.opcode === 0x8) {
          wsLog.push({ dir: 'close', data: '', at: Date.now() })
          socket.end(encodeCloseFrame())
          return
        }
        if (frame.opcode !== 0x1) continue
        wsLog.push({ dir: 'in', data: frame.payload, at: Date.now() })
        // 回声加前缀：好和「服务端主动推的」那条区分开
        const echo = 'echo:' + frame.payload
        socket.write(encodeTextFrame(echo))
        wsLog.push({ dir: 'out', data: echo, at: Date.now() })
      }
    })
    socket.on('close', () => wsSockets.delete(socket))
    socket.on('error', () => wsSockets.delete(socket))
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        requests,
        matrixReports,
        streamReports,
        wsLog,
        close: () =>
          new Promise((done) => {
            for (const stream of openStreams) {
              try {
                stream.destroy()
              } catch {
                /* 已经断了 */
              }
            }
            for (const socket of wsSockets) {
              try {
                socket.destroy()
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
