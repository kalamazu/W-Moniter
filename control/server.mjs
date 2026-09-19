#!/usr/bin/env node
/**
 * 控制服务（AI 友好面的后端）。
 *
 * 职责有两层：
 *   1. HTTP JSON API：给 agent / 脚本用，绑 127.0.0.1，全部要 Bearer token。
 *   2. 上游桥：把请求转给 Electron 主进程（走 stdin/stdout 上的 NDJSON RPC）。
 *
 * 为什么不把 HTTP 直接开在主进程里：与存储、代理保持一致 —— 主进程只做编排，
 * 不把 Web 服务器和长连接塞进 UI 进程。控制进程崩了不影响采集。
 *
 * 启动时把 { port, token, pid } 写到 <dataDir>/control.json，
 * 让 agent 和 mcp/server.mjs 自己发现地址（端口可以传 0 让系统分配）。
 */
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
function argOf(name, fallback) {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const DATA_DIR = argOf('data-dir', process.env['MONITOR_DATA_DIR'] ?? '.')
const PORT = Number(argOf('port', process.env['MONITOR_API_PORT'] ?? '0'))
const HOST = '127.0.0.1'
const TOKEN = process.env['MONITOR_API_TOKEN'] || randomBytes(24).toString('hex')

mkdirSync(DATA_DIR, { recursive: true })
const INFO_PATH = join(DATA_DIR, 'control.json')

/* ------------------------------------------------------------- 上游 RPC */

let nextId = 1
const pending = new Map()

function call(method, params, timeoutMs = 60000) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`upstream timeout: ${method}`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    process.stdout.write(JSON.stringify({ id, method, params }) + '\n')
  })
}

function settle(msg) {
  const slot = pending.get(msg.id)
  if (!slot) return
  pending.delete(msg.id)
  clearTimeout(slot.timer)
  if (msg.error) slot.reject(new Error(msg.error))
  else slot.resolve(msg.result)
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let nl
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl)
    buffer = buffer.slice(nl + 1)
    if (!line.trim()) continue
    try {
      settle(JSON.parse(line))
    } catch {
      /* 坏行忽略：上游是我们自己的主进程，但也不能让一行脏数据拖垮服务 */
    }
  }
})

function emit(event, payload) {
  process.stdout.write(JSON.stringify({ event, payload }) + '\n')
}

/* ------------------------------------------------------------- 工具函数 */

function send(res, status, body) {
  const text = JSON.stringify(body === undefined ? null : body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store'
  })
  res.end(text)
}

function readBody(req, limitBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limitBytes) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function authorized(req) {
  const header = req.headers['authorization'] ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  const qs = new URL(req.url, 'http://127.0.0.1').searchParams.get('token')
  return token === TOKEN || qs === TOKEN
}

function num(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * 把 URL 查询串翻译成引擎的 RequestQuery。
 * 引擎认的字段（见 shared/types.ts 的 RequestQuery）：search / url / host / path /
 * resourceType / status / method / scheme / statusMin / statusMax …
 * 对外的 API 用更顺手的别名（urlPattern / domain），在这里收敛成一套。
 */
const QUERY_ALIASES = {
  urlPattern: 'url',
  domain: 'host',
  type: 'resourceType',
  q: 'search',
  initiator: 'initiatorType'
}
const QUERY_NUMERIC = new Set(['status', 'statusMin', 'statusMax', 'since', 'until', 'minSize', 'maxSize'])

function toRequestQuery(searchParams) {
  const out = {}
  for (const [key, value] of searchParams) {
    if (key === 'limit' || key === 'offset' || key === 'order' || key === 'token') continue
    const field = QUERY_ALIASES[key] ?? key
    if (QUERY_NUMERIC.has(field)) {
      const n = Number(value)
      if (Number.isFinite(n)) out[field] = n
    } else {
      out[field] = value
    }
  }
  return out
}

/* ------------------------------------------------- 路由：读 */

const ROUTES = []
function route(method, pattern, handler, options = {}) {
  // raw: 原样返回（结果本身就是响应体）；否则包一层 { ok: true, data }
  ROUTES.push({ method, pattern, handler, mutating: Boolean(options.mutating), raw: options.raw !== false })
}

// 注意：/health 在下面被特殊处理（免鉴权），注册成路由反而会被绕过 ——
// 之前这里留过一份「永远不会被执行」的同名路由，形状还和真跑的那份不一样。
route('GET', '/status', () => call('status', {}))
route('GET', '/capabilities', () => call('capabilities', {}))
route('GET', '/requests', (req, { query }) =>
  call('requests.query', {
    query: toRequestQuery(query),
    limit: num(query.get('limit'), 100),
    offset: num(query.get('offset'), 0),
    order: query.get('order') ?? 'time_desc'
  }, 120000)
)
route('GET', '/requests/:seq', (_req, { params }) => call('request.detail', { seq: num(params.seq, 0) }))
route('GET', '/requests/:seq/body', (_req, { params, query }) =>
  call('body.get', { hash: params.seq, withData: query.get('withData') !== '0' })
)
route('GET', '/requests/:seq/body-live', (_req, { params }) =>
  call('body.fetchNow', { seq: num(params.seq, 0) }, 120000)
)
route('GET', '/stats', () => call('stats', {}, 120000))
route('GET', '/timeline', (_req, { query }) =>
  call('timeline', {
    query: toRequestQuery(query),
    limit: num(query.get('limit'), 200)
  }, 120000)
)
route('GET', '/scripts', (_req, { query }) =>
  call('scripts.query', {
    query: toRequestQuery(query),
    limit: num(query.get('limit'), 100),
    offset: num(query.get('offset'), 0),
    order: query.get('order') ?? 'time_desc'
  }, 120000)
)
route('GET', '/scripts/stats', () => call('scriptStats', {}, 120000))
route('GET', '/scripts/:hash', (_req, { params }) => call('script.source', { hash: params.hash }, 120000))

route('GET', '/rules', () => call('rules.get', {}))
route('GET', '/rules/stats', () => call('rules.stats', {}))
route('GET', '/console', () => call('console.list', {}))
route('GET', '/instances', () => call('instances', {}, 120000))
route('GET', '/sessions', () => call('sessions', {}, 120000))
route('GET', '/dom/tree', (_req, { query }) =>
  call('dom.tree', { nodeId: query.has('nodeId') ? num(query.get('nodeId'), 0) : undefined, depth: query.has('depth') ? num(query.get('depth'), 1) : undefined }, 120000)
)
route('GET', '/dom/inspect', (_req, { query }) =>
  // 上游的 dom.inspect 约定参数是 { target }；直接把目标对象当 params 传会被读成「没给选择器」
  call(
    'dom.inspect',
    { target: query.has('selector') ? { selector: query.get('selector') } : { nodeId: num(query.get('nodeId'), 0) } },
    120000
  )
)

/* ------------------------------------------------- 路由：写 */

route('POST', '/navigate', async (_req, { body }) => call('navigate', { url: String(body?.url ?? '') }, 60000), { mutating: true })
// 截图本身不改页面状态（只读），放写区只是因为它要一个 JSON body 挑取景方式
route('POST', '/screenshot', (_req, { body }) =>
  call('screenshot', { options: body ?? {} }, 120000)
)
route('POST', '/evaluate', async (_req, { body }) => call('evaluate', { expression: String(body?.expression ?? '') }, 120000), { mutating: true })
route('POST', '/probe', async (_req, { body }) => call('probe.run', { options: body?.options ?? {} }, 180000), { mutating: true })
route('POST', '/input', async (_req, { body }) => call('input.run', { action: body ?? {} }, 120000), { mutating: true })
route('POST', '/dom/highlight', async (_req, { body }) => call('dom.highlight', { nodeId: num(body?.nodeId, 0), on: body?.on !== false }, 120000), { mutating: true })
route('POST', '/rules', async (_req, { body }) => call('rules.save', { set: body }, 120000), { mutating: true })
route('POST', '/sessions/profile', async (_req, { body }) => call('sessions.switchProfile', { profile: body?.profile === 'H' ? 'H' : 'L' }, 180000), { mutating: true })
route('POST', '/clear', async () => call('clear', {}), { mutating: true })
route('POST', '/console/clear', async () => call('console.clear', {}), { mutating: true })

/* ------------------------------------------------------------- 匹配与分发 */

function matchRoute(method, pathname) {
  for (const entry of ROUTES) {
    if (entry.method !== method) continue
    const parts = entry.pattern.split('/').filter(Boolean)
    const given = pathname.split('/').filter(Boolean)
    if (parts.length !== given.length) continue
    const params = {}
    let ok = true
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(':')) params[parts[i].slice(1)] = decodeURIComponent(given[i])
      else if (parts[i] !== given[i]) { ok = false; break }
    }
    if (ok) return { entry, params }
  }
  return null
}

const server = createServer(async (req, res) => {
  let url
  try {
    url = new URL(req.url, 'http://127.0.0.1')
  } catch {
    return send(res, 400, { ok: false, error: 'bad url' })
  }
  const pathname = url.pathname.replace(/\/+$/, '') || '/'

  if (pathname === '/health' && req.method === 'GET') {
    // 免鉴权探活。ok = 控制服务活着；upstream = 上游 Controller 连得上（文档就是这么写的）。
    const upstream = await call('status', {})
      .then(() => true)
      .catch(() => false)
    return send(res, 200, { ok: true, service: 'monitor-control', version: 1, pid: process.pid, upstream })
  }
  if (!authorized(req)) return send(res, 401, { ok: false, error: '缺少或错误的 token（Bearer）' })

  const hit = matchRoute(req.method ?? 'GET', pathname)
  if (!hit) return send(res, 404, { ok: false, error: `没有这个接口：${req.method} ${pathname}` })

  try {
    const bodyText = req.method === 'POST' ? await readBody(req) : ''
    const body = bodyText ? JSON.parse(bodyText) : undefined
    const result = await hit.entry.handler(req, { params: hit.params, query: url.searchParams, body })
    // 路由自己声明语义：raw 的原样返回，其余的包一层，避免「结果里恰好有 ok 字段」改变形状
    const payload = hit.entry.raw ? result : { ok: true, data: result }
    send(res, 200, payload === undefined ? null : payload)
  } catch (err) {
    send(res, 502, { ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})

server.on('error', (err) => {
  emit('fatal', { message: err.message })
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  const actualPort = server.address().port
  const info = {
    version: 1,
    service: 'monitor-control',
    port: actualPort,
    host: HOST,
    token: TOKEN,
    pid: process.pid,
    startedAt: Date.now()
  }
  try {
    writeFileSync(INFO_PATH, JSON.stringify(info, null, 2), 'utf8')
  } catch (err) {
    emit('log', `写 control.json 失败：${err.message}`)
  }
  process.stdout.write(JSON.stringify({ event: 'ready', payload: { port: actualPort, pid: process.pid } }) + '\n')
})

function shutdown() {
  try {
    rmSync(INFO_PATH, { force: true })
  } catch {
    /* 收工时删不掉就算了，下次启动会覆盖 */
  }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.stdin.on('end', shutdown)