#!/usr/bin/env node
/**
 * P5 验收：本地代理 + 三源关联的代理侧。
 *
 * 对应设计文档 §4.3（三源关联）、§5.1（timings.dns/connect/tls 是代理留给模型的字段）、
 * §6.3 第 2 条（大 body 改写下沉到代理层）、§10 P5、§12「DNS/TLS 信息齐全」。
 *
 * 全部自包含：自己起 https/http origin，自己拉代理子进程（NDJSON），自己拉 Chrome。
 * 唯一的外部依赖是 Chrome 本体（和 P6 那套一样）。
 *
 * 证书方案由 work/spki-experiment2.mjs 的实测决定（Chrome 153）：
 *   A 不带开关              -> ERR_CERT_AUTHORITY_INVALID
 *   B 只 pin SPKI（无 SAN） -> PASS
 *   C pin + 带 SAN          -> PASS
 * 所以走 --ignore-certificate-errors-spki-list，不碰系统信任库。
 *
 *   node scripts/test-proxy.mjs [--dump]
 */

import { spawn } from 'node:child_process'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { gzipSync } from 'node:zlib'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { createAuthority } from '../proxy/cert.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = process.env['CHROME_PATH'] ??
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const DUMP = process.argv.includes('--dump')

const BIG_LEN = 1024 * 1024
const BIG_HEAD = 'BIG-HEAD-MARK'
const BIG_TAIL = 'BIG-TAIL-MARK'
const ORIGINAL_TEXT = 'ORIGINAL-TEXT-HERE'
const REWRITTEN_TEXT = 'REWRITTEN-BODY-OK'
const GZIP_ORIGINAL = 'GZIP-ORIGINAL-TEXT'
const GZIP_REWRITTEN = 'GZIP-REWRITTEN-OK'
const POST_ECHO = 'POST-ECHO-PAYLOAD'
// §6.3 第 2 条：大 body 改写下沉的分界。生产上这个值就是 CDP 那条路的 bodyMaxBytes，
// 这里显式设置它，才能验「== 阈值不下沉、> 阈值才下沉」这条边界
const SINK_LIMIT = 256 * 1024
const SINK_MARK = 'SINK-ORIGINAL'
const SINK_NEW = 'SINK-REWRITTEN'

/** 一段货真价实的二进制（含 PNG magic，content-type 也是 image/png） */
const BINARY_PAD = Buffer.alloc(300 * 1024)
for (let i = 0; i < BINARY_PAD.length; i++) BINARY_PAD[i] = (i * 7) & 0xff
const sinkBinary = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), BINARY_PAD])

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log('  \u2713 ' + name)
  } catch (err) {
    results.push({ name, ok: false, message: err.message })
    console.log('  \u2717 ' + name + '\n      ' + err.message)
  }
}

// ---------------------------------------------------------------- origin

function bigBody() {
  const filler = 'x'.repeat(BIG_LEN - BIG_HEAD.length - BIG_TAIL.length - 40)
  return '<title>BIG</title>' + BIG_HEAD + filler + BIG_TAIL
}

function route(url) {
  if (url === '/reuse') {
    return {
      type: 'text/html',
      body: '<title>REUSE</title><body>R<scr' + 'ipt src="/a.js"></scr' + 'ipt>' +
        '<scr' + 'ipt>var x=new XMLHttpRequest();x.open("GET","/b.js",false);x.send();' +
        'document.body.textContent="REUSE-DONE";</scr' + 'ipt>'
    }
  }
  if (url === '/a.js' || url === '/b.js') return { type: 'text/javascript', body: '/* ' + url + ' */' }
  if (url === '/') return { type: 'text/html', body: '<title>SMOKE</title>HELLO-ORIGIN' }
  if (url === '/rewrite-me') return { type: 'text/html', body: '<title>RW</title>' + ORIGINAL_TEXT }
  if (url === '/untouched') return { type: 'text/html', body: '<title>UT</title>' + ORIGINAL_TEXT }
  if (url === '/header-only') return { type: 'text/html', body: '<title>HO</title>HELLO-HEADER' }
  if (url === '/big') return { type: 'text/html', body: bigBody() }
  if (url === '/gzip') {
    return { type: 'text/html', gzip: true, body: '<title>GZ</title>' + GZIP_ORIGINAL }
  }
  if (url === '/post') {
    return {
      type: 'text/html',
      // 同步 XHR：--dump-dom 是加载完就 dump，异步 fetch 的回显根本等不到
      body: '<title>POSTING</title><body>WAIT<scr' + 'ipt>' +
        'var x=new XMLHttpRequest();x.open("POST","/echo",false);x.send("' + POST_ECHO + '");' +
        'document.body.textContent="ECHO:"+x.responseText;' +
        '</scr' + 'ipt>'
    }
  }
  if (url === '/echo') return { type: 'text/plain', body: 'got' }
  // ---- 下沉边界用例（node 直接过代理打，不用 Chrome）
  if (url === '/sink-big') {
    return { type: 'text/html', body: '<title>SINK</title>' + SINK_MARK + 'x'.repeat(300 * 1024) }
  }
  if (url === '/sink-equal') {
    // 声明长度**正好**等于阈值
    return { type: 'text/html', body: SINK_MARK + 'x'.repeat(SINK_LIMIT - SINK_MARK.length) }
  }
  if (url === '/sink-chunked') {
    return { type: 'text/html', chunked: true, body: '<title>CHUNK</title>' + SINK_MARK + 'x'.repeat(64 * 1024) }
  }
  if (url === '/sink-binary') return { type: 'image/png', binary: true }
  if (url === '/sink-order') {
    return { type: 'text/html', body: '<title>ORDER</title>ORDER-ORIGINAL' + 'x'.repeat(300 * 1024) }
  }
  return { type: 'text/html', body: '<title>OTHER</title>OTHER' }
}

function handler(req, res) {
  const path = req.url.split('?')[0]
  if (path === '/echo') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('got:' + body)
    })
    return
  }
  const r = route(path)
  const headers = { 'content-type': r.type + '; charset=utf-8' }
  if (r.gzip) {
    const buf = gzipSync(Buffer.from(r.body))
    headers['content-encoding'] = 'gzip'
    headers['content-length'] = String(buf.length)
    res.writeHead(200, headers)
    return res.end(buf)
  }
  if (r.binary) {
    const buf = sinkBinary()
    headers['content-type'] = r.type
    headers['content-length'] = String(buf.length)
    res.writeHead(200, headers)
    return res.end(buf)
  }
  if (r.chunked) {
    // 故意不给 content-length：Node 自己会走 Transfer-Encoding: chunked
    res.writeHead(200, headers)
    res.write(r.body.slice(0, 16))
    return res.end(r.body.slice(16))
  }
  headers['content-length'] = String(Buffer.byteLength(r.body))
  res.writeHead(200, headers)
  res.end(r.body)
}

// ---------------------------------------------------------------- 代理子进程

function spawnProxy() {
  const proc = spawn(process.execPath, [join(ROOT, 'proxy', 'server.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const pending = new Map()
  const logs = []
  let seq = 0
  let buf = ''
  proc.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.ev) {
        if (msg.ev === 'log') logs.push('[' + msg.data.level + '] ' + msg.data.msg)
        continue
      }
      const slot = pending.get(msg.id)
      if (slot) { pending.delete(msg.id); slot(msg) }
    }
  })
  proc.stderr.on('data', (d) => logs.push('[stderr] ' + String(d).trim()))
  const call = (op, args) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, (m) => (m.ok ? resolve(m.result) : reject(new Error(m.error))))
    proc.stdin.write(JSON.stringify({ id, op, args }) + '\n')
  })
  return { proc, call, logs, kill: () => { try { proc.kill() } catch {} } }
}

// ---------------------------------------------------------------- Chrome

function runChrome(url, flags) {
  return new Promise((resolve) => {
    const profile = mkdtempSync(join(tmpdir(), 'monitor-proxy-'))
    const args = ['--headless=new', '--dump-dom', '--no-first-run', '--no-default-browser-check',
      '--disable-features=Translate', '--user-data-dir=' + profile, ...flags, url]
    const proc = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    proc.stdout.on('data', (d) => { out += d })
    proc.stderr.on('data', (d) => { err += d })
    const timer = setTimeout(() => { try { proc.kill() } catch {} resolve({ out, err, timedOut: true }) }, 30000)
    proc.on('close', () => {
      clearTimeout(timer)
      try { rmSync(profile, { recursive: true, force: true }) } catch {}
      resolve({ out, err, timedOut: false })
    })
  })
}

const proxyFlags = (proxyPort, spki) => [
  '--proxy-server=http://127.0.0.1:' + proxyPort,
  // Chrome 默认会绕过 loopback；<-loopback> 是「不要绕过」，不然本地用例根本不进代理
  '--proxy-bypass-list=<-loopback>',
  ...(spki ? ['--ignore-certificate-errors-spki-list=' + spki] : [])
]

/** 用 node 自己走一次代理（absolute-form），不劳 Chrome —— 边界用例要跑得快 */
function viaProxy(proxyPort, targetUrl) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        path: targetUrl,
        headers: { host: new URL(targetUrl).host, 'accept-encoding': 'identity' }
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        )
      }
    )
    req.on('error', reject)
    req.end()
  })
}

// ---------------------------------------------------------------- 主流程

const auth = createAuthority({})
const originCert = auth.forHost('localhost')
const httpsOrigin = createHttpsServer({ key: originCert.keyPem, cert: originCert.certPem }, handler)
const httpOrigin = createHttpServer(handler)
// 监听 :: （Windows 上默认双栈，IPv4/IPv6 都收）—— 用 hostname 时 DNS 可能先给 ::1
await new Promise((r) => httpsOrigin.listen(0, '::', r))
await new Promise((r) => httpOrigin.listen(0, '::', r))
const httpsPort = httpsOrigin.address().port
const httpPort = httpOrigin.address().port
const keyDir = join(ROOT, 'work', 'spki')
mkdirSync(keyDir, { recursive: true })
const keyFile = join(keyDir, 'test-proxy.key')

console.log('== P5 本地代理验收 ==\n')
console.log('  https origin 127.0.0.1:' + httpsPort + '   http origin 127.0.0.1:' + httpPort)

const proxy = spawnProxy()
const started = await proxy.call('start', { port: 0, keyFile })
const spki = started.spki
console.log('  代理 127.0.0.1:' + started.port + '  SPKI=' + spki + '\n')

// 上游自签，本地 origin 用我们自己的 CA 签的 —— 生产是正常校验，测试里得放开
await proxy.call('setConfig', { upstreamRejectUnauthorized: false, rewriteMaxBytes: 64 * 1024 })
await proxy.call('setRules', {
  rules: [
    { id: 'r-rewrite', enabled: true, urlPattern: '/rewrite-me', replaceInBody: [{ find: ORIGINAL_TEXT, replace: REWRITTEN_TEXT }] },
    { id: 'r-gzip', enabled: true, urlPattern: '/gzip', replaceInBody: [{ find: GZIP_ORIGINAL, replace: GZIP_REWRITTEN }] },
    { id: 'r-big', enabled: true, urlPattern: '/big', replaceInBody: [{ find: 'zzz', replace: 'yyy' }] },
    // 响应头改写单独一条 URL：§6.2 的语义是「每阶段只应用优先级最高的一条」，
    // 两条规则挂同一个 URL 的话第二条永远不会生效（这是设计，不是 bug）
    { id: 'r-header', enabled: true, urlPattern: '/header-only', setResponseHeader: { name: 'x-proxy-mark', value: 'yes' } }
  ]
})

const base = 'https://127.0.0.1:' + httpsPort
const baseHttp = 'http://127.0.0.1:' + httpPort

console.log('== 跑 Chrome ==')
const runs = {}
runs.pinned = await runChrome(base + '/', proxyFlags(started.port, spki))
runs.unpinned = await runChrome(base + '/', proxyFlags(started.port, null))
runs.rewrite = await runChrome(base + '/rewrite-me', proxyFlags(started.port, spki))
runs.untouched = await runChrome(base + '/untouched', proxyFlags(started.port, spki))
runs.header = await runChrome(base + '/header-only', proxyFlags(started.port, spki))
runs.gzip = await runChrome(base + '/gzip', proxyFlags(started.port, spki))
runs.big = await runChrome(base + '/big', proxyFlags(started.port, spki))
runs.post = await runChrome(base + '/post', proxyFlags(started.port, spki))
runs.plain = await runChrome(baseHttp + '/', proxyFlags(started.port, spki))
runs.hostname = await runChrome('https://localhost:' + httpsPort + '/', proxyFlags(started.port, spki))
runs.reuse = await runChrome(base + '/reuse', proxyFlags(started.port, spki))
for (const [k, v] of Object.entries(runs)) {
  console.log('  ' + k.padEnd(10) + ' bytes=' + String(v.out.length).padEnd(8) +
    ' err=' + ((v.out.match(/ERR_[A-Z_]+/) ?? [])[0] ?? '-') + (v.timedOut ? ' 超时' : ''))
}

const allFlows = (await proxy.call('getFlows', {})).flows
const pathOf = (f) => { try { return new URL(f.url).pathname } catch { return f.url } }
const flowsAt = (path) => allFlows.filter((f) => pathOf(f) === path)
const findFlow = (method, path) => flowsAt(path).find((f) => f.method === method && f.status !== undefined)
const first = (method, path) => flowsAt(path).filter((f) => f.method === method)

console.log('\n== 断言 ==')

await check('代理起来并给出 port / SPKI', () => {
  assert.ok(started.port > 0, '没拿到端口')
  assert.match(spki, /^[A-Za-z0-9+/]{43}=$/, 'SPKI 不是 base64 sha256')
})

await check('CA 落盘复用：重启后 SPKI 不变（pin 才不会失效）', async () => {
  const p2 = spawnProxy()
  const s2 = await p2.call('start', { port: 0, keyFile })
  p2.kill()
  assert.equal(s2.spki, spki, '两次启动的 SPKI 不一致，说明没复用密钥')
})

await check('Chrome 过代理加载 https 页面成功（MITM 成立）', () => {
  assert.ok(runs.pinned.out.includes('HELLO-ORIGIN'), '页面内容没拿到: ' + runs.pinned.out.slice(0, 200))
})

await check('对照组：不带 pin 时被证书拦下（证明 pin 才是放行原因）', () => {
  assert.ok(!runs.unpinned.out.includes('HELLO-ORIGIN'), '不带 pin 竟然也拿到了页面')
  assert.match(runs.unpinned.out, /ERR_CERT_AUTHORITY_INVALID/, '不是证书错误: ' + runs.unpinned.out.slice(0, 200))
})

await check('明文 http 也走代理（absolute-form）', () => {
  assert.ok(runs.plain.out.includes('HELLO-ORIGIN'), 'HTTP 页面没拿到')
  const f = flowsAt('/').find((x) => x.scheme === 'http' && x.status === 200)
  assert.ok(f, '没有明文 http 的 flow')
})

await check('flow 记录：method/url/status/响应体都对得上', () => {
  const f = findFlow('GET', '/')
  assert.ok(f, '没找到 https 首屏的 flow')
  assert.equal(f.status, 200, 'status 不是 200')
  assert.equal(f.scheme, 'https', 'scheme 不是 https')
  assert.equal(f.host, '127.0.0.1', 'host 不对')
  assert.ok(f.requestHeaders['user-agent'].includes('Chrome/'), '请求头里没有 Chrome UA')
  assert.match(f.responseHeaders['content-type'], /text\/html/, '响应头 content-type 不对')
  const body = Buffer.from(f.responseBodyRef.base64, 'base64').toString('utf8')
  assert.ok(body.includes('HELLO-ORIGIN'), '采样到的响应体不对: ' + body.slice(0, 80))
})

await check('DNS/TLS 信息齐全（§12 的硬指标）', () => {
  const f = flowsAt('/').find((x) => x.host === 'localhost' && x.timings.connect !== undefined)
  assert.ok(f, '没有一条以 hostname 新建连接的 flow，测不到 DNS')
  for (const k of ['dns', 'connect', 'tls', 'ttfb', 'download']) {
    assert.equal(typeof f.timings[k], 'number', '缺 timings.' + k)
    assert.ok(f.timings[k] >= 0, 'timings.' + k + ' 是负数')
  }
  assert.ok(f.timings.ttfb > 0, 'ttfb 应该 > 0')
  assert.ok(f.upstreamIp, '没记到 DNS 解析出的 IP')
})

await check('IP 字面量没有 DNS 步骤（这是对的，不是漏采）', () => {
  const f = flowsAt('/').find((x) => x.host === '127.0.0.1' && x.scheme === 'https' && x.timings.connect !== undefined)
  assert.ok(f, '没有 IP 直连的 flow')
  assert.equal(f.timings.dns, undefined, 'IP 直连不该有 dns 耗时')
  assert.equal(typeof f.timings.connect, 'number', 'IP 直连应该有 connect 耗时')
})

await check('复用连接上不再有 dns/connect/tls（和真实浏览器语义一致）', () => {
  const subs = [...flowsAt('/a.js'), ...flowsAt('/b.js')]
  assert.ok(subs.length > 0, '子资源没走到代理')
  const reused = subs.filter((f) => f.timings.connect === undefined)
  assert.ok(reused.length > 0, '没有一个复用连接的子资源 flow（' + subs.length + ' 个子资源）')
  for (const f of reused) {
    assert.equal(f.timings.dns, undefined, '复用连接不该有 dns')
    assert.equal(f.timings.tls, undefined, '复用连接不该有 tls')
    assert.equal(typeof f.timings.ttfb, 'number', '复用连接应该有 ttfb')
  }
})

await check('请求体被采样（POST /echo）', () => {
  const f = findFlow('POST', '/echo')
  assert.ok(f, '没有 /echo 的 POST flow')
  const body = Buffer.from(f.requestBodyRef.base64, 'base64').toString('utf8')
  assert.equal(body, POST_ECHO, '请求体采样不对: ' + body)
  assert.ok(runs.post.out.includes('ECHO:got:' + POST_ECHO), '页面里没看到回显: ' + runs.post.out.slice(0, 200))
})

await check('代理层改写：命中的响应体真的被改了，页面拿到新内容', () => {
  assert.ok(runs.rewrite.out.includes(REWRITTEN_TEXT), '页面里没有改写后的文本: ' + runs.rewrite.out.slice(0, 200))
  assert.ok(!runs.rewrite.out.includes(ORIGINAL_TEXT), '原文还在，说明没改')
  const f = findFlow('GET', '/rewrite-me')
  assert.equal(f.bodyRewritten, true, 'flow 没标记 bodyRewritten')
  assert.equal(f.lane, 'rewrite', 'lane 不是 rewrite: ' + f.lane)
  assert.equal(f.responseBodyRef.encoding, 'identity', '改写后不该再声明压缩编码')
})

await check('改写后发给浏览器的 content-length / content-encoding 对齐', () => {
  const f = findFlow('GET', '/rewrite-me')
  const expected = Buffer.byteLength('<title>RW</title>' + REWRITTEN_TEXT)
  assert.equal(Number(f.sentHeaders['content-length']), expected,
    '发出去的 content-length=' + f.sentHeaders['content-length'] + '，实际 ' + expected)
  assert.equal(f.sentHeaders['content-encoding'], undefined, '改写后不该再声明压缩')
  assert.equal(f.sentBodyBytes, expected, 'sentBodyBytes 对不上')
  assert.ok(runs.rewrite.out.includes('</html>'), '页面没正常收尾，可能被长度坑了')
})

await check('规则外的响应不被误改', () => {
  assert.ok(runs.untouched.out.includes(ORIGINAL_TEXT), '未命中规则的页面被改了')
  const f = findFlow('GET', '/untouched')
  assert.ok(!f.bodyRewritten, '不该标记 bodyRewritten')
})

await check('压缩响应改写：解码 → 改写 → 去掉 content-encoding', () => {
  assert.ok(runs.gzip.out.includes(GZIP_REWRITTEN), '页面里没有改写后的内容: ' + runs.gzip.out.slice(0, 200))
  const f = findFlow('GET', '/gzip')
  assert.equal(f.bodyEncodedUpstream, 'gzip', '没记到上游是 gzip')
  assert.equal(f.bodyRewritten, true, '没标记改写')
  assert.equal(f.responseBodyRef.encoding, 'gzip', '采样到的上游字节应该还是 gzip 原文')
  assert.equal(f.sentHeaders['content-encoding'], undefined, '发给浏览器时不该带 content-encoding')
})

await check('超大 body（> rewriteMaxBytes）退化成透传，且内容完整不截断', () => {
  assert.ok(runs.big.out.includes(BIG_HEAD), '开头标记丢了')
  assert.ok(runs.big.out.includes(BIG_TAIL), '结尾标记丢了 —— body 被截断了')
  const f = findFlow('GET', '/big')
  assert.equal(f.lane, 'pass-oversize', 'lane 不是 pass-oversize: ' + f.lane)
  assert.equal(f.responseBytes, Buffer.byteLength(bigBody()), '响应字节数不对')
  assert.equal(Number(f.sentHeaders['content-length']), Buffer.byteLength(bigBody()), '发给浏览器的长度也不对')
})

await check('响应头改写规则生效（setResponseHeader 真的发给了浏览器）', () => {
  const f = findFlow('GET', '/header-only')
  assert.ok(f, '没有 /header-only 的 flow')
  const hit = f.ruleHits.find((h) => h.kind === 'setResponseHeader')
  assert.ok(hit, '没记到 setResponseHeader 命中: ' + JSON.stringify(f.ruleHits))
  assert.equal(f.sentHeaders['x-proxy-mark'], 'yes', '发出去的响应头里没有 x-proxy-mark')
  assert.ok(runs.header.out.includes('HELLO-HEADER'), '页面内容不对: ' + runs.header.out.slice(0, 120))
})

await check('证书按 host 现签，且 SPKI 恒定', async () => {
  const st = await proxy.call('status', {})
  assert.ok(st.certs >= 1, '没有签发过证书')
  assert.equal(st.spki, spki, 'SPKI 变了，pin 会失效')
})

await check('环缓冲可用（getFlows / clearFlows）', async () => {
  const before = (await proxy.call('getFlows', {})).flows.length
  assert.ok(before > 5, 'flow 太少: ' + before)
  const limited = (await proxy.call('getFlows', { limit: 3 })).flows
  assert.equal(limited.length, 3, 'limit 没生效')
})

await check('代理没往 stderr 吐异常', () => {
  const errs = proxy.logs.filter((l) => /\[error\]|\[stderr\]/.test(l))
  assert.equal(errs.length, 0, '代理日志里有错误: ' + errs.slice(0, 3).join(' | '))
})

console.log('\n== 大 body 改写下沉（§6.3 第 2 条）==')

await proxy.call('setConfig', {
  sinkAboveBytes: SINK_LIMIT,
  rewriteMaxBytes: 4 * 1024 * 1024,
  upstreamRejectUnauthorized: false
})
await proxy.call('setRules', {
  rules: [
    { id: 'sink-big', enabled: true, urlRegex: '/sink-big$', bodyScript: "return body.split('" + SINK_MARK + "').join('" + SINK_NEW + "')" },
    { id: 'sink-equal', enabled: true, urlRegex: '/sink-equal$', bodyScript: "return body.split('" + SINK_MARK + "').join('" + SINK_NEW + "')" },
    { id: 'sink-chunked', enabled: true, urlRegex: '/sink-chunked$', bodyScript: "return body.split('" + SINK_MARK + "').join('" + SINK_NEW + "')" },
    { id: 'sink-binary', enabled: true, urlRegex: '/sink-binary$', bodyScript: "return body.split('PNG').join('XXX')" },
    // 同一个 URL 命中两条：只该执行第一条 —— 下发的顺序就是优先级
    { id: 'sink-order-first', enabled: true, urlRegex: '/sink-order$', bodyScript: "return body.split('ORDER-ORIGINAL').join('ORDER-FIRST')" },
    { id: 'sink-order-second', enabled: true, urlRegex: '/sink-order$', bodyScript: "return body.split('ORDER-FIRST').join('ORDER-SECOND')" }
  ]
})

const sinkPaths = ['/sink-big', '/sink-equal', '/sink-chunked', '/sink-binary', '/sink-order']
const sinkAnswers = {}
for (const p of sinkPaths) sinkAnswers[p] = await viaProxy(started.port, baseHttp + p)

const sinkFlows = (await proxy.call('getFlows', {})).flows
const sinkFlow = (path) => sinkFlows.filter((f) => pathOf(f) === path && f.status === 200).pop()
const sinkHit = (f, kind) => (f ? f.ruleHits.find((h) => h.kind === kind) : undefined)

await check('大 body（声明长度 > 阈值）真的在代理层被脚本改掉，长度也对齐', () => {
  const res = sinkAnswers['/sink-big']
  const text = res.body.toString('utf8')
  assert.ok(text.includes(SINK_NEW), '代理没改这条大 body')
  assert.ok(!text.includes(SINK_MARK), '原文还在，说明没改')
  const f = sinkFlow('/sink-big')
  assert.ok(f, '没有 /sink-big 的 flow')
  assert.equal(f.lane, 'rewrite', 'lane 不是 rewrite: ' + f.lane)
  assert.equal(f.bodyRewritten, true, '没标记 bodyRewritten')
  const hit = sinkHit(f, 'bodyScript')
  assert.ok(hit && hit.applied === true && hit.id === 'sink-big', '没记到 bodyScript 命中: ' + JSON.stringify(f.ruleHits))
  const declared = Number(f.responseHeaders['content-length'])
  assert.ok(declared > SINK_LIMIT, 'origin 的声明长度没超过阈值: ' + declared)
  assert.equal(Number(f.sentHeaders['content-length']), res.body.length, '发给浏览器的 content-length 和改后 body 对不上')
  assert.equal(f.sentHeaders['content-encoding'], undefined, '改写后不该再声明压缩')
})

await check('边界：声明长度 == 阈值不下沉（这一段归 CDP 那条路）', () => {
  const res = sinkAnswers['/sink-equal']
  assert.equal(res.body.length, SINK_LIMIT, 'origin 不是正好 ' + SINK_LIMIT + ' 字节')
  assert.ok(res.body.toString('utf8').includes(SINK_MARK), '边界上的 body 被代理改了')
  const f = sinkFlow('/sink-equal')
  assert.equal(f.lane, 'pass', 'lane 不是 pass: ' + f.lane)
  const hit = sinkHit(f, 'bodyRewrite')
  assert.ok(hit && hit.applied === false, '没记下「不下沉」: ' + JSON.stringify(f.ruleHits))
  assert.match(hit.reason, /没超过下沉阈值/, '原因不对: ' + hit.reason)
})

await check('边界：拿不到 content-length（chunked）不下沉，且如实记原因', () => {
  const res = sinkAnswers['/sink-chunked']
  assert.ok(res.body.toString('utf8').includes(SINK_MARK), 'chunked 响应被代理改了')
  assert.equal(res.headers['transfer-encoding'], 'chunked', 'origin 没按 chunked 发')
  const f = sinkFlow('/sink-chunked')
  assert.equal(f.responseHeaders['content-length'], undefined, 'chunked 不该有 content-length')
  const hit = sinkHit(f, 'bodyRewrite')
  assert.ok(hit && hit.applied === false, '没记下「不下沉」: ' + JSON.stringify(f.ruleHits))
  assert.match(hit.reason, /content-length/, '原因没说清是缺 content-length: ' + hit.reason)
})

await check('边界：二进制（content-type 非文本）不下沉，字节原样透传', () => {
  const res = sinkAnswers['/sink-binary']
  assert.equal(res.headers['content-type'], 'image/png', 'content-type 变了')
  assert.ok(res.body.equals(sinkBinary()), '二进制字节被动了')
  const f = sinkFlow('/sink-binary')
  assert.equal(f.lane, 'pass', 'lane 不是 pass: ' + f.lane)
  const hit = sinkHit(f, 'bodyRewrite')
  assert.ok(hit && hit.applied === false, '没记下「不下沉」: ' + JSON.stringify(f.ruleHits))
  assert.match(hit.reason, /二进制/, '原因不对: ' + hit.reason)
})

await check('同一 URL 命中多条时只执行第一条（下发顺序即优先级）', () => {
  const text = sinkAnswers['/sink-order'].body.toString('utf8')
  assert.ok(text.includes('ORDER-FIRST'), '第一条规则没生效')
  assert.ok(!text.includes('ORDER-SECOND'), '第二条也执行了 —— 代理的优先级语义和主进程不一致')
  const f = sinkFlow('/sink-order')
  assert.equal(f.ruleHits.filter((h) => h.kind === 'bodyScript' && h.applied).length, 1, '执行的规则数不是 1')
})

if (DUMP) {
  console.log('\n== flows ==')
  for (const f of allFlows) {
    console.log('  ' + f.flowId + ' ' + f.method + ' ' + f.status + ' ' + f.url +
      ' lane=' + f.lane + ' ip=' + f.upstreamIp + ' err=' + f.error + ' timings=' + JSON.stringify(f.timings))
  }
  console.log('\n== 代理日志 ==')
  for (const l of proxy.logs) console.log('  ' + l)
}

proxy.kill()
httpsOrigin.close()
httpOrigin.close()
try { rmSync(keyFile, { force: true }) } catch {}

console.log('\n== 结果 ==')
const failed = results.filter((item) => !item.ok)
console.log('  ' + (results.length - failed.length) + '/' + results.length + ' 通过')
for (const item of failed) console.log('  \u2717 ' + item.name + ': ' + item.message)
process.exit(failed.length === 0 ? 0 : 1)
