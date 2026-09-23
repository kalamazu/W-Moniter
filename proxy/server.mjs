#!/usr/bin/env node
/**
 * 监控容器 · 本地代理进程（P5）
 *
 * 为什么又是独立进程：和 storage/server.mjs 同样的理由。
 *   1) 设计文档 §5.2：绝不在 CDP 事件回调里做同步 IO。代理要读写 socket、改写 body，
 *      塞进 Electron 主进程会直接和 UI 抢事件循环；
 *   2) §6.3 第 2 条：大 body 改写必须下沉到代理层（CDP 那条路 base64 过 IPC 会卡住页面）；
 *   3) 可以脱离 Electron 单独测 —— 证书、时序、改写都能在脚本里直接验。
 *
 * 协议：stdin/stdout 上的 NDJSON（与 storage 进程同形）。
 *   请求  {"id":1,"op":"start","args":{}}
 *   应答  {"id":1,"ok":true,"result":{...}} / {"id":1,"ok":false,"error":"..."}
 *   事件  {"ev":"flow","data":{...}} / {"ev":"log","data":{...}}
 * body 走 base64。
 *
 * 证书：见 proxy/cert.mjs。Chrome 那边靠 --ignore-certificate-errors-spki-list=<spki> 放行，
 * 不碰系统信任库（装系统根是个全局可观察的改动）。
 *
 * 时序：dns / connect / tls / ttfb / download。这是代理相对 CDP 的唯一硬增量 ——
 * CDP 给不了 DNS 和 TLS。复用连接上只有 ttfb / download（真实浏览器也是这样）。
 */

import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import net from 'node:net'
import dns from 'node:dns'
import zlib from 'node:zlib'
import { ScriptSandbox } from './rule-sandbox.mjs'
import { readFileSync } from 'node:fs'
import { createAuthority, pemOf } from './cert.mjs'

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000  // ms，小数
const ms = (v) => Math.round(v * 1000) / 1000

const config = {
  host: '127.0.0.1',
  port: 0,
  /** 单条 body 过线/回报的上限，超了只留 head + size */
  bodyMaxBytes: 256 * 1024,
  /** 代理层改写的上限：超过这个大小的响应体直接透传，不改 */
  rewriteMaxBytes: 32 * 1024 * 1024,
  /** 关掉就完全不缓冲 body（只要元数据/时序） */
  captureBodies: true,
  /** 上游 TLS 校验：默认开。关掉是为了配合自签上游做测试 */
  upstreamRejectUnauthorized: true,
  /** 环缓冲上限，给 getFlows 用（事件才是主路径） */
  flowBuffer: 20000,
  /**
   * 只有「声明长度大于这个值」的响应才在代理层套规则（§6.3 第 2 条）。
   *
   * 为什么用声明长度而不是实到字节：CDP 那条路是按 content-length 判断要不要
   * 去取 body 的，代理必须用同一个判据，两边才会**正好互补、不会重叠**。
   * 重叠的后果是同一条 body 被改两遍（脚本不一定幂等），比漏改严重得多。
   * 拿不到 content-length 的（chunked）两边都不动 —— 这是已知边界，不是漏做。
   */
  sinkAboveBytes: 0,
  contentEndpoint: null
}

let authority = null
let server = null
let tlsTerminator = null
let innerHttp = null
let agentHttp = null
let agentHttps = null
let flowSeq = 0
const flows = []
/**
 * 还没结束的 flow。SSE / 流式响应会一直挂着，等不到响应结束就永远不进 flows ——
 * 收工时要 drain 一次，把它们按「已知的头、TTFB、上游 IP」补成 flow，
 * 否则这类请求在代理侧完全不可见，CDP 那条只能孤零零地标成 cdp-only。
 */
const openFlows = new Set()
const rules = []

const say = (obj) => { process.stdout.write(JSON.stringify(obj) + '\n') }

/** rewriteBody 脚本的沙箱。和主进程用的是同一份实现（proxy/rule-sandbox.mjs） */
const sandbox = new ScriptSandbox()
const log = (level, msg, extra) => say({ ev: 'log', data: { level, msg, t: Date.now(), ...(extra ?? {}) } })

// ---------------------------------------------------------------- 规则（代理层）

/**
 * 只做「CDP 那条路做不动」的事：大 body 改写（§6.3 第 2 条）。
 * 规则形状（由主进程下发，映射见 src/main/proxy/rules.ts）：
 *   { id, enabled, urlRegex, urlFlags?, methods?, statuses?,
 *     bodyScript?: string,                      // rewriteBody 动作的脚本
 *     replaceInBody?: [{find, replace, all?}],  // 老的简化形状，测试用
 *     setResponseHeader?: {name,value}, removeResponseHeader?: [name] }
 * urlRegex 是主进程把 urlPattern（glob 或 re: 正则）编译之后下来的完整正则 ——
 * 两个执行方必须用同一套匹配语义，否则同一条规则在两边行为不一致。
 * 优先级也由主进程保证：下发的列表已按 priority 降序、同号按原顺序，
 * 所以这里「取第一条命中的」就等价于主进程的「每阶段只应用优先级最高的一条」。
 */
/** 编译好的正则按 source 缓存：匹配路径上每条请求都要跑，别每次 new RegExp */
const urlRegexCache = new Map()
function urlMatches(rule, url) {
  if (rule.urlRegex) {
    // key 里必须带上 flags：同 source 不同 flags 是两个不同的正则
    const key = rule.urlRegex + '\u0000' + (rule.urlFlags || '')
    let re = urlRegexCache.get(key)
    if (re === undefined) {
      try { re = new RegExp(rule.urlRegex, rule.urlFlags || '') } catch { re = null }
      urlRegexCache.set(key, re)
    }
    return re ? re.test(url) : false
  }
  // 没给正则时的兜底：子串匹配（老的规则形状）
  if (!rule.urlPattern) return false
  return url.includes(rule.urlPattern)
}

function ruleMatches(rule, flow) {
  if (rule.enabled === false) return false
  if (!urlMatches(rule, flow.url)) return false
  if (rule.methods && rule.methods.length && !rule.methods.includes(String(flow.method).toUpperCase())) {
    return false
  }
  if (rule.statuses && rule.statuses.length && !rule.statuses.includes(flow.status)) return false
  return true
}

/**
 * §6.2：每个阶段只应用**优先级最高的一条**命中规则。
 * 规则由主进程按 priority 降序下发，所以这里取第一条命中的就等价 ——
 * 多条叠加会让「到底哪条生效」没法推理（和主进程那边的语义必须一致）。
 */
function pickRules(flow) {
  for (const rule of rules) {
    if (ruleMatches(rule, flow)) return [rule]
  }
  return []
}

function appliesToBody(rule) {
  return (
    (Array.isArray(rule.replaceInBody) && rule.replaceInBody.length > 0) ||
    typeof rule.bodyScript === 'string'
  )
}

/**
 * 只看 content-type，不猜字节 —— 二进制响应走 utf8 往返会把字节改坏。
 * 判据和主进程 CDP 那条路（src/main/browser/body-capture.ts 的 isTexty）一模一样：
 * 宁可漏改一个没写 content-type 的文本，也不毁一个没写 content-type 的图片。
 */
const TEXTY = /(^text\/|json|javascript|ecmascript|xml|html|x-www-form-urlencoded|graphql|svg)/i

/**
 * 这条响应该不该在代理层被改写。只认**声明长度**（见 config.sinkAboveBytes 的说明），
 * 和 CDP 那条路的分界判据完全相同 —— 两边正好互补，绝不重叠。
 * 返回 null = 该下沉；返回字符串 = 不该的原因（记进 ruleHits，便于排查）
 */
function sinkDecision(headers) {
  const raw = headers['content-length']
  const declared = raw === undefined ? NaN : Number(raw)
  if (!Number.isFinite(declared)) return '没有 content-length（chunked/流式），按约定不在代理层改写'
  if (!(declared > config.sinkAboveBytes)) {
    return '声明长度 ' + declared + ' 没超过下沉阈值 ' + config.sinkAboveBytes + '（这条归 CDP 那条路）'
  }
  const contentType = headers['content-type']
  if (contentType !== undefined && !TEXTY.test(contentType)) {
    return '二进制响应 (content-type=' + contentType + ')，和 CDP 那条路一样跳过改写'
  }
  return null
}

// ---------------------------------------------------------------- 时序工具

function makeTiming() {
  return { t: {}, out: {} }
}

function decodeBody(buf, encoding) {
  const enc = (encoding ?? '').toLowerCase()
  if (enc === '' || enc === 'identity') return buf
  try {
    if (enc === 'gzip') return zlib.gunzipSync(buf)
    if (enc === 'deflate') return zlib.inflateSync(buf)
    if (enc === 'br') return zlib.brotliDecompressSync(buf)
  } catch { return null }
  return null
}

const HOP_BY_HOP = new Set([
  'connection', 'proxy-connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'
])

function stripHopByHop(headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue
    out[k] = v
  }
  return out
}

// ---------------------------------------------------------------- 上游请求

function proxyRequest(clientReq, clientRes, target, reqBody) {
  const flow = {
    flowId: 'f' + (++flowSeq),
    startedAt: Date.now(),
    scheme: target.scheme,
    host: target.host,
    port: target.port,
    method: clientReq.method,
    url: target.scheme + '://' + target.host + (target.port === 80 || target.port === 443 ? '' : ':' + target.port) + target.path,
    path: target.path,
    requestHeaders: clientReq.headers,
    requestBytes: reqBody ? reqBody.length : 0,
    timings: {},
    ruleHits: [],
    mergeState: 'proxy-only'
  }
  openFlows.add(flow)
  const t = makeTiming()
  const isTls = target.scheme === 'https'
  const agent = isTls ? agentHttps : agentHttp

  /**
   * 自己解析是为了量 DNS 耗时（CDP 给不了这个）。
   * 注意 Node 20+ 的 autoSelectFamily 会用 all:true 调过来、并且要一个数组回去 ——
   * 只回单地址的话 net 会拿 undefined 当 IP 用，报 "Invalid IP address: undefined"，
   * 所有 hostname 上游全连不上（踩过）。
   */
  const lookup = (hostname, opts, cb) => {
    const all = !!(opts && opts.all)
    t.dnsStart = now()
    dns.lookup(hostname, {
      family: opts && opts.family ? opts.family : 0,
      verbatim: true,
      all
    }, (err, address, family) => {
      flow.timings.dns = ms(now() - t.dnsStart)
      if (!err) flow.upstreamIp = all ? (address[0] && address[0].address) : address
      cb(err, address, family)
    })
  }

  const headers = stripHopByHop(clientReq.headers)
  // 让上游别压缩，代理层改写要的是明文；Chrome 自己也会因为这是个代理而正常处理
  if (config.rewriteUpstreamNoCompression) delete headers['accept-encoding']

  const options = {
    host: target.host,
    port: target.port,
    method: clientReq.method,
    path: target.path,
    headers,
    agent,
    lookup
  }
  if (isTls) {
    // IP 字面量不能做 SNI（RFC 6066），设了只会换来一条 DEP0123 警告
    options.servername = net.isIP(target.host) ? undefined : target.host
    options.rejectUnauthorized = config.upstreamRejectUnauthorized
  }

  const proto = isTls ? https : http
  const upReq = proto.request(options)

  upReq.on('socket', (sock) => {
    if (sock.__monitorSeen) return
    sock.__monitorSeen = true
    t.sockAt = now()
    sock.once('connect', () => {
      t.connectAt = now()
      flow.timings.connect = ms(t.connectAt - t.sockAt)
    })
    sock.once('secureConnect', () => {
      t.tlsAt = now()
      flow.timings.tls = ms(t.tlsAt - (t.connectAt ?? t.sockAt))
      flow.tlsVersion = sock.getProtocol ? sock.getProtocol() : undefined
      flow.tlsCipher = sock.getCipher ? (sock.getCipher() || {}).name : undefined
      flow.upstreamAlpn = sock.alpnProtocol || undefined
    })
    sock.once('error', (err) => { flow.error = String(err && err.message || err) })
  })

  upReq.on('error', (err) => {
    flow.error = String(err && err.message || err)
    flow.finishedAt = Date.now()
    finish(flow)
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      clientRes.end('proxy upstream error: ' + flow.error)
    } else {
      clientRes.destroy()
    }
  })

  upReq.on('response', (upRes) => {
    flow.timings.ttfb = ms(now() - t.sentAt)
    flow.status = upRes.statusCode
    flow.statusText = upRes.statusMessage
    flow.responseHeaders = { ...upRes.headers }
    const enc = (upRes.headers['content-encoding'] ?? '').toLowerCase() || 'identity'
    const baseHeaders = stripHopByHop(upRes.headers)

    const active = pickRules(flow)
    /**
     * §6.3 第 2 条的分界：声明长度超过 sinkAboveBytes 的响应才在代理层改 body，
     * 其余（含拿不到 content-length 的 chunked/流式、以及二进制）留给 CDP 那条路。
     * 不下沉的原因如实记进 ruleHits —— 漏改要能看出来，不许静默。
     */
    const bodyRules = active.filter(appliesToBody)
    const sinkBlocked = bodyRules.length > 0 ? sinkDecision(upRes.headers) : null
    if (sinkBlocked !== null) {
      for (const r of bodyRules) {
        flow.ruleHits.push({ id: r.id, applied: false, kind: 'bodyRewrite', reason: sinkBlocked })
      }
    }
    const wantsBody = bodyRules.length > 0 && sinkBlocked === null

    let bytes = 0
    let firstByteAt = null
    let captured = []          // 只为回报采样，不参与回给浏览器
    let capturedBytes = 0
    const takeSample = (c) => {
      if (!config.captureBodies) return
      if (capturedBytes < config.bodyMaxBytes) {
        captured.push(c.subarray(0, config.bodyMaxBytes - capturedBytes))
        capturedBytes += Math.min(c.length, config.bodyMaxBytes - capturedBytes)
      }
    }

    /** 把规则里的响应头动作落到 baseHeaders 上（与 body 是否改写无关） */
    const applyHeaderRules = () => {
      for (const r of active) {
        if (r.setResponseHeader) {
          baseHeaders[r.setResponseHeader.name.toLowerCase()] = r.setResponseHeader.value
          flow.ruleHits.push({ id: r.id, applied: true, kind: 'setResponseHeader' })
        }
        if (Array.isArray(r.removeResponseHeader)) {
          for (const n of r.removeResponseHeader) delete baseHeaders[n.toLowerCase()]
          flow.ruleHits.push({ id: r.id, applied: true, kind: 'removeResponseHeader' })
        }
      }
    }

    // ---- 路径 1：没有规则要动 body，纯透传，延迟零增加
    if (!wantsBody) {
      applyHeaderRules()
      flow.bodyEncodedUpstream = enc
      flow.lane = 'pass'
      // Tee raw upstream bytes to the local content service. The browser pipe is
      // independent; slow disk only pauses the upstream on socket backpressure.
      let sink = null
      const mediaType = String(upRes.headers['content-type'] ?? '').toLowerCase()
      const indefinitelyStreaming = mediaType.includes('text/event-stream') || mediaType.includes('multipart/x-mixed-replace') || mediaType.includes('application/grpc')
      if (config.contentEndpoint && !indefinitelyStreaming && flow.status !== 204 && flow.status !== 304) {
        const endpoint = config.contentEndpoint
        sink = http.request({ hostname: endpoint.host, port: endpoint.port, method: 'PUT', path: '/object',
          headers: { authorization: `Bearer ${endpoint.token}`,
            ...(upRes.headers['content-length'] ? { 'x-expected-bytes': String(upRes.headers['content-length']) } : {}) } }, response => {
          const parts = []
          response.on('data', part => parts.push(part))
          response.on('end', () => {
            if (response.statusCode === 200) {
              try { flow.contentRef = JSON.parse(Buffer.concat(parts).toString('utf8')) }
              catch { flow.contentError = 'invalid content service reply' }
            } else flow.contentError = `content service HTTP ${response.statusCode}`
          })
        })
        sink.on('error', error => { flow.contentError = error.message; sink = null; upRes.resume() })
      }
      upRes.on('data', (c) => {
        if (firstByteAt === null) firstByteAt = now()
        bytes += c.length
        takeSample(c)
        if (sink && !sink.write(c)) upRes.pause()
      })
      sink?.on('drain', () => upRes.resume())
      upRes.on('close', () => { if (!flow.finishedAt) sink?.destroy() })
      clientRes.on('close', () => { if (!flow.finishedAt) sink?.destroy() })
      upRes.on('end', async () => {
        // Upstream request emits 'close' as soon as its response ends. Mark the
        // flow terminal before awaiting the content ACK, or close will publish a
        // premature no-ref flow and steal the CDP correlation slot.
        flow.finishedAt = Date.now()
        if (sink) {
          sink.end()
          // Finish event must not claim complete before the content service ACK.
          await new Promise(resolve => {
            if (sink.writableFinished && sink.destroyed) return resolve()
            sink.once('response', response => response.once('end', resolve))
            sink.once('error', resolve)
            setTimeout(resolve, 15000).unref()
          })
        }
        const last = now()
        flow.timings.download = ms(last - (firstByteAt ?? last))
        flow.responseBytes = bytes
        if (config.captureBodies) {
          flow.responseBodyRef = {
            encoding: enc,
            size: bytes,
            capturedBytes,
            truncated: capturedBytes < bytes,
            base64: Buffer.concat(captured).toString('base64')
          }
        }
        if (reqBody && config.captureBodies) {
          flow.requestBodyRef = {
            size: reqBody.length,
            truncated: reqBody.length > config.bodyMaxBytes,
            base64: reqBody.subarray(0, config.bodyMaxBytes).toString('base64')
          }
        }
        finish(flow)
      })
      flow.sentHeaders = baseHeaders
      if (!clientRes.headersSent) clientRes.writeHead(flow.status, baseHeaders)
      upRes.pipe(clientRes)
      return
    }

    // ---- 路径 2：要改 body。先攒着，超限就退化成流式把已缓冲的先吐出去
    let mode = 'buffer'
    const buffered = []
    const fallback = () => {
      mode = 'pass'
      flow.lane = 'pass-oversize'
      flow.ruleHits.push({ id: '(skip)', applied: false, reason: '响应体超过 rewriteMaxBytes=' + config.rewriteMaxBytes })
      applyHeaderRules()
      if (!clientRes.headersSent) clientRes.writeHead(flow.status, baseHeaders)
      flow.sentHeaders = baseHeaders
      for (const x of buffered) clientRes.write(x)
      buffered.length = 0
    }

    upRes.on('data', (c) => {
      if (firstByteAt === null) firstByteAt = now()
      bytes += c.length
      takeSample(c)
      if (mode === 'buffer') {
        buffered.push(c)
        if (bytes > config.rewriteMaxBytes) fallback()
      } else {
        clientRes.write(c)
      }
    })

    upRes.on('end', () => {
      const last = now()
      flow.timings.download = ms(last - (firstByteAt ?? last))
      flow.responseBytes = bytes
      flow.finishedAt = Date.now()

      if (mode === 'pass') { finish(flow); clientRes.end(); return }

      // 到这里说明整个响应体都在 buffered 里
      const raw = Buffer.concat(buffered)
      const decoded = decodeBody(raw, enc)
      let outBody = raw
      let outHeaders = { ...baseHeaders }

      if (decoded === null) {
        flow.ruleHits.push({ id: '(skip)', applied: false, reason: '响应体不是可解码的文本 (content-encoding=' + enc + ')' })
      } else {
        let text = decoded.toString('utf8')
        let changed = false
        for (const r of bodyRules) {
          for (const op of r.replaceInBody ?? []) {
            const before = text
            text = op.all === false ? text.replace(op.find, op.replace) : text.split(op.find).join(op.replace)
            if (text !== before) { changed = true; flow.ruleHits.push({ id: r.id, applied: true, kind: 'replaceInBody' }) }
            else flow.ruleHits.push({ id: r.id, applied: false, kind: 'replaceInBody', reason: '未命中' })
          }
          if (typeof r.bodyScript === 'string') {
            // 和主进程的 CDP 那条路是同一份沙箱实现（proxy/rule-sandbox.mjs）
            const result = sandbox.run(r.bodyScript, text, {
              url: flow.url,
              method: flow.method,
              status: flow.status,
              headers: flow.responseHeaders ?? {},
              isBinary: false
            })
            if (!result.ok) {
              flow.ruleHits.push({ id: r.id, applied: false, kind: 'bodyScript', reason: result.error })
            } else if (result.noop || typeof result.body !== 'string') {
              flow.ruleHits.push({ id: r.id, applied: false, kind: 'bodyScript', reason: '脚本没返回字符串，按不改处理' })
            } else if (result.body !== text) {
              text = result.body
              changed = true
              flow.ruleHits.push({ id: r.id, applied: true, kind: 'bodyScript' })
            } else {
              flow.ruleHits.push({ id: r.id, applied: false, kind: 'bodyScript', reason: '未命中' })
            }
          }
        }
        if (changed) {
          outBody = Buffer.from(text, 'utf8')
          flow.bodyRewritten = true
          flow.lane = 'rewrite'
          // 已解码成明文：gzip/br 相关的头必须清掉，否则浏览器拿压缩头去解明文
          delete outHeaders['content-encoding']
          delete outHeaders['content-md5']
        } else {
          flow.lane = 'buffer-nomatch'
        }
      }

      applyHeaderRules()
      delete outHeaders['content-length']
      outHeaders['content-length'] = String(outBody.length)
      flow.bodyEncodedUpstream = enc

      if (config.captureBodies) {
        flow.responseBodyRef = {
          encoding: enc,
          size: bytes,
          capturedBytes: capturedBytes,
          truncated: capturedBytes < bytes,
          base64: Buffer.concat(captured).toString('base64')
        }
      }
      if (reqBody && config.captureBodies) {
        flow.requestBodyRef = {
          size: reqBody.length,
          truncated: reqBody.length > config.bodyMaxBytes,
          base64: reqBody.subarray(0, config.bodyMaxBytes).toString('base64')
        }
      }

      finish(flow)
      flow.sentHeaders = outHeaders
      flow.sentBodyBytes = outBody.length
      if (!clientRes.headersSent) clientRes.writeHead(flow.status, outHeaders)
      clientRes.end(outBody)
    })
  })

  upReq.on('close', () => {
    if (!flow.finishedAt) {
      flow.error = flow.error ?? '上游连接提前关闭'
      flow.finishedAt = Date.now()
      finish(flow)
      if (!clientRes.headersSent) { clientRes.writeHead(502); clientRes.end('proxy: upstream closed early') }
      else clientRes.destroy()
    }
  })

  if (reqBody && reqBody.length) upReq.end(reqBody)
  else upReq.end()
  t.sentAt = now()
  return flow
}

function finish(flow) {
  openFlows.delete(flow)
  flows.push(flow)
  while (flows.length > config.flowBuffer) flows.shift()
  say({ ev: 'flow', data: flow })
}

// ---------------------------------------------------------------- 服务端

function contextFor(host) {
  const c = authority.forHost(host)
  return tls.createSecureContext({ key: c.keyPem, cert: c.certPem })
}

const ctxCache = new Map()
function contextCached(host) {
  let c = ctxCache.get(host)
  if (!c) { c = contextFor(host); ctxCache.set(host, c) }
  return c
}

function handleRequest(meta) {
  return (req, res) => {
    let target = meta
    if (/^https?:\/\//i.test(req.url)) {
      // 明文代理：请求行里是绝对 URL
      const u = new URL(req.url)
      target = {
        scheme: u.protocol.replace(':', ''),
        host: u.hostname,
        port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)),
        path: u.pathname + u.search
      }
    } else if (meta) {
      // CONNECT 隧道内：请求行是 origin-form，路径只能从 req.url 拿。
      // 这里如果偷懒用 meta.path（'/'），所有 https 请求都会被打到根路径（踩过）。
      target = { ...meta, path: req.url }
    }
    const chunks = []
    let bodyBytes = 0
    let aborted = false
    req.on('data', (c) => {
      bodyBytes += c.length
      if (config.captureBodies && bodyBytes <= config.bodyMaxBytes) chunks.push(c)
      else if (!config.captureBodies) req.pause(), req.resume()
    })
    req.on('error', () => { aborted = true })
    req.on('end', () => {
      if (aborted) return
      try {
        const flow = proxyRequest(req, res, target, Buffer.concat(chunks))
        flow.requestBytes = bodyBytes
      } catch (e) {
        log('error', 'proxyRequest 抛异常: ' + String(e && e.message || e))
        if (!res.headersSent) { res.writeHead(500); res.end('proxy error') }
      }
    })
  }
}

function ensureInner() {
  if (innerHttp) return innerHttp
  innerHttp = http.createServer((req, res) => {
    const meta = req.socket.__target
    if (!meta) { res.writeHead(500); return res.end('no target') }
    handleRequest(meta)(req, res)
  })
  innerHttp.on('clientError', (err, sock) => {
    log('warn', '客户端 HTTP 解析错误: ' + String(err && err.message || err))
    try { sock.destroy() } catch {}
  })
  return innerHttp
}

async function start(args = {}) {
  config.port = args.port ?? 0
  config.host = args.host ?? '127.0.0.1'
  if (args.keyFile) {
    authority = createAuthority({ keyFile: args.keyFile })
    log('info', 'CA 复用已有密钥 ' + args.keyFile)
  } else {
    authority = createAuthority({})
  }

  agentHttp = new http.Agent({ keepAlive: true, maxSockets: 64 })
  agentHttps = new https.Agent({ keepAlive: true, maxSockets: 64, rejectUnauthorized: config.upstreamRejectUnauthorized })

  // 证书按 host 现签，建一次缓存住
  authority.forHost('localhost')

  server = http.createServer((req, res) => handleRequest(null)(req, res))
  server.on('connect', (req, clientSocket, head) => {
    const [host, portStr] = req.url.split(':')
    const port = Number(portStr || 443)
    clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: monitor-proxy\r\n\r\n')
    if (head && head.length) clientSocket.unshift(head)
    // MITM 的 TLS 终点。注意：__target 必须挂在 TLSSocket 上 —— 内层 http 解析器
    // 拿到的就是它，挂到原始 socket 上会取不到目标（踩过）。
    let tlsSock
    try {
      tlsSock = new tls.TLSSocket(clientSocket, {
        isServer: true,
        secureContext: contextCached(host),
        ALPNProtocols: ['http/1.1']
      })
    } catch (e) {
      log('error', '建 TLS 终点失败 ' + host + ': ' + String(e && e.message || e))
      try { clientSocket.destroy() } catch {}
      return
    }
    tlsSock.__target = { scheme: 'https', host, port, path: '/' }
    tlsSock.on('error', (err) => log('warn', 'TLS 客户端错误 (' + host + '): ' + String(err && err.message || err)))
    ensureInner().emit('connection', tlsSock)
  })
  server.on('clientError', (err, sock) => {
    log('warn', '代理客户端错误: ' + String(err && err.message || err))
    try { sock.destroy() } catch {}
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, resolve)
  })
  config.port = server.address().port
  log('info', '代理已监听 ' + config.host + ':' + config.port + ' SPKI=' + authority.spki)
  return { port: config.port, host: config.host, spki: authority.spki, keyPem: authority.keyPem }
}

function stop() {
  for (const s of [server, innerHttp]) { try { s && s.close() } catch {} }
  server = null; innerHttp = null
  return { stopped: true }
}

const OPS = {
  start,
  stop,
  async setRules(args) { rules.length = 0; for (const r of args.rules ?? []) rules.push(r); return { count: rules.length } },
  async setConfig(args) {
    Object.assign(config, args)
    if (args.upstreamRejectUnauthorized !== undefined && agentHttps) {
      agentHttps.destroy()
      agentHttps = new https.Agent({ keepAlive: true, maxSockets: 64, rejectUnauthorized: config.upstreamRejectUnauthorized })
    }
    return { config: { ...config } }
  },
  async status() {
    return {
      running: !!server, port: config.port, host: config.host,
      spki: authority ? authority.spki : null,
      flows: flows.length, rules: rules.length,
      certs: authority ? authority.cached : 0,
      config: { ...config }
    }
  },
  /** 测试用：把环缓冲里的 flow 一次性取走 */
  async getFlows(args) {
    const n = args && args.limit ? args.limit : flows.length
    return { flows: flows.slice(-n) }
  },
  async clearFlows() { flows.length = 0; return { cleared: true } },
  /**
   * 收工时把还在飞的请求补报出去。只报一次（报完就清空 openFlows），
   * 并且带 open:true 标明「响应没结束，download 这类字段本来就不存在」——
   * 不能假装它有完整时序，也不能因为不完整就把它整条丢掉。
   */
  async drain() {
    const pending = [...openFlows]
    openFlows.clear()
    for (const flow of pending) finish({ ...flow, open: true })
    return { drained: pending.length }
  }
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { log('warn', '非法 JSON: ' + line.slice(0, 200)); continue }
    const fn = OPS[msg.op]
    if (!fn) { say({ id: msg.id, ok: false, error: '未知 op: ' + msg.op }); continue }
    Promise.resolve()
      .then(() => fn(msg.args ?? {}))
      .then((result) => say({ id: msg.id, ok: true, result }))
      .catch((e) => say({ id: msg.id, ok: false, error: String(e && e.stack || e) }))
  }
})
process.stdin.on('end', () => { stop(); process.exit(0) })

// 自检：直接 node proxy/server.mjs --selftest
if (process.argv.includes('--selftest')) {
  // 注意：顶层 await 不能出现在 if 块里，包一层
  ;(async () => {
    const r = await start({ port: 0 })
    console.log('start ->', JSON.stringify({ port: r.port, spki: r.spki }))
    console.log(JSON.stringify(await OPS.status(), null, 2))
    stop()
    process.exit(0)
  })()
}
