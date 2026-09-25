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
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
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
route('GET', '/workspaces', () => call('workspaces.list', {}))
route('GET', '/workspaces/content-stats', () => call('action.execute', { request: { action: 'workspaces.contentStats', input: {}, target: { kind: 'workspace-collection' } } }))
route('GET', '/workspaces/:id/auth', (_req, { params }) => call('action.execute', { request: { action: 'auth.summary', input: {}, target: { kind: 'workspace', workspaceId: params.id } } }))
route('GET', '/workspaces/:id/extensions', (_req, { params }) => call('action.execute', { request: { action: 'extensions.summary', input: {}, target: { kind: 'workspace', workspaceId: params.id } } }))
route('GET', '/workspaces/:id/rules', (_req, { params }) => call('action.execute', { request: { action: 'rules.get', input: {}, target: { kind: 'workspace', workspaceId: params.id } } }))
route('GET', '/workspaces/:id/capture/summary', (_req, { params }) => call('action.execute', { request: { action: 'capture.summary', input: {}, target: { kind: 'workspace', workspaceId: params.id } } }))
route('GET', '/workspaces/:id/requests/:seq/body-evidence', (_req, { params }) => call('action.execute', { request: { action: 'capture.evidence', input: { seq: Number(params.seq) }, target: { kind: 'workspace', workspaceId: params.id } } }))
route('GET', '/workspaces/:id/content/:hash/verify', (_req, { params }) => call('action.execute', { request: { action: 'content.verify', input: { hash: params.hash }, target: { kind: 'workspace', workspaceId: params.id } } }))
route('GET', '/workspaces/:id/content/:hash/range', (_req, { params, query }) => call('action.execute', { request: { action: 'content.readRange', input: { hash: params.hash, start: Number(query.get('start') ?? 0), end: Number(query.get('end')) }, target: { kind: 'workspace', workspaceId: params.id } } }))
route('GET', '/actions/catalog', () => call('actions.catalog', {}))
route('GET', '/tasks/diagnostics', () => call('tasks.diagnostics', {}))
route('GET', '/tasks/events', (_req, { query }) => call('task.events', { after: num(query.get('after'), 0), limit: num(query.get('limit'), 200) }))
route('GET', '/tasks/:id', (_req, { params }) => call('task.get', { taskId: params.id }))
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
route('POST', '/rules', async (_req, { body }) => call('action.execute', { request: { action: 'rules.save', input: { set: body?.set }, ...(body?.workspaceId ? { target: { kind: 'workspace', workspaceId: body.workspaceId } } : {}), ...(body?.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}) } }, 120000), { mutating: true })
route('POST', '/sessions/profile', async (_req, { body }) => call('sessions.switchProfile', { profile: body?.profile === 'H' ? 'H' : 'L' }, 180000), { mutating: true })
route('POST', '/workspaces', async (_req, { body }) =>
  call('workspace.create', {
    name: String(body?.name ?? ''), profile: body?.profile === 'H' ? 'H' : 'L',
    ...(body?.target ? { target: body.target } : {}),
    ...(typeof body?.idempotencyKey === 'string' ? { idempotencyKey: body.idempotencyKey } : {})
  }),
  { mutating: true }
)
route('POST', '/workspaces/:id/open', async (_req, { params }) =>
  call('workspace.open', { id: params.id }, 180000),
  { mutating: true }
)
route('POST', '/workspaces/:id/suspend', async (_req, { params }) =>
  call('workspace.suspend', { id: params.id }, 180000),
  { mutating: true }
)
route('POST', '/workspaces/:id/rules', (_req, { params, body }) => call('action.execute', { request: { action: 'rules.save', input: { set: body?.set }, target: { kind: 'workspace', workspaceId: params.id, ...(Number.isSafeInteger(body?.expectedVersion) ? { expectedVersion: body.expectedVersion } : {}) }, ...(body?.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}) } }), { mutating: true })
route('POST', '/workspaces/:id/content/:hash/revoke', (_req, { params, body }) => call('action.execute', { request: { action: 'content.revoke', input: { hash: params.hash, reason: String(body?.reason ?? '') }, target: { kind: 'workspace', workspaceId: params.id }, ...(body?.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}) } }), { mutating: true })
route('POST', '/workspaces/:id/auth/verify-fixture', (_req, { params, body }) => call('action.execute', { request: { action: 'auth.verifyFixture', input: { origin: String(body?.origin ?? '') }, target: { kind: 'workspace', workspaceId: params.id }, ...(body?.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}) } }), { mutating: true })
route('POST', '/workspaces/:id/extensions/desired', (_req, { params, body }) => call('action.execute', { request: { action: 'extensions.setDesired', input: { extensionId: body?.extensionId, version: body?.version, permissions: body?.permissions }, target: { kind: 'workspace', workspaceId: params.id }, ...(body?.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}) } }), { mutating: true })
route('POST', '/actions/execute', async (_req, { body }) => call('action.execute', { request: body ?? {} }, 180000), { mutating: true })
route('POST', '/actions/start', async (_req, { body }) => call('action.start', { request: body ?? {} }), { mutating: true })
route('POST', '/tasks/:id/cancel', async (_req, { params }) => call('task.cancel', { taskId: params.id }), { mutating: true })
route('POST', '/clear', async () => call('clear', {}), { mutating: true })
route('POST', '/console/clear', async () => call('console.clear', {}), { mutating: true })


/* -------------------------------------------------- 路由：分析层（读） */

/** 逗号分隔的列表参数，顺手把空串去掉 */
function csv(value) {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

/** 可选数字：缺省就是「没传」，别拿 0 冒充 */
function numOpt(value) {
  if (value === null || value === undefined || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function eventQueryOf(query) {
  const out = { since: numOpt(query.get('since')), limit: numOpt(query.get('limit')) }
  const until = numOpt(query.get('until'))
  if (until !== undefined) out.until = until
  const kinds = csv(query.get('kinds') ?? query.get('kind'))
  if (kinds.length > 0) out.kinds = kinds
  const level = query.get('level')
  if (level) out.level = level
  const targetType = query.get('targetType')
  if (targetType) out.targetType = targetType
  const search = query.get('search') ?? query.get('q')
  if (search) out.search = search
  const order = query.get('order')
  if (order) out.order = order
  return out
}

function wsQueryOf(query) {
  return {
    since: numOpt(query.get('since')),
    limit: numOpt(query.get('limit')),
    direction: query.get('direction') ?? undefined,
    requestId: query.get('requestId') ?? undefined,
    opcode: numOpt(query.get('opcode')),
    search: query.get('search') ?? undefined,
    order: query.get('order') ?? undefined
  }
}

function exportArgsOf(body) {
  const out = { query: body.query ?? {}, includeBodies: body.includeBodies !== false }
  const maxRows = numOpt(body.maxRows)
  if (maxRows !== undefined) out.maxRows = maxRows
  if (body.dir) out.dir = String(body.dir)
  return out
}

route('GET', '/events', (_req, { query }) => call('events.query', { query: eventQueryOf(query) }, 120000))
route('GET', '/events/stats', () => call('eventStats', {}, 120000))
route('GET', '/ws', (_req, { query }) => call('ws.query', { query: wsQueryOf(query) }, 120000))
route('GET', '/ws/connections', (_req, { query }) =>
  call('ws.connections', { limit: numOpt(query.get('limit')) }, 120000)
)
route('GET', '/endpoints', (_req, { query }) =>
  call(
    'endpoints.profiles',
    {
      query: toRequestQuery(query),
      sort: query.get('sort') ?? 'calls',
      minCalls: numOpt(query.get('minCalls')),
      limit: numOpt(query.get('limit')),
      maxRows: numOpt(query.get('maxRows'))
    },
    120000
  )
)
route('GET', '/endpoints/detail', (_req, { query }) =>
  call(
    'endpoint.detail',
    {
      key: query.get('key') ?? '',
      query: toRequestQuery(query),
      sampleLimit: numOpt(query.get('sampleLimit')),
      callLimit: numOpt(query.get('callLimit')),
      maxRows: numOpt(query.get('maxRows'))
    },
    120000
  )
)
route('GET', '/graph', (_req, { query }) =>
  call(
    'graph',
    {
      query: toRequestQuery(query),
      maxRows: numOpt(query.get('maxRows')),
      maxNodes: numOpt(query.get('maxNodes'))
    },
    120000
  )
)
route('GET', '/relations', (_req, { query }) =>
  call(
    'relations',
    {
      query: toRequestQuery(query),
      maxRows: numOpt(query.get('maxRows')),
      limit: numOpt(query.get('limit'))
    },
    120000
  )
)
// 契约列表也要跟其它列表接口一个形状（{rows,total}）。裸数组会让「列表都返回 rows」
  // 这条通用规则在本接口上破功，agent 每次都得特判
  route(
    'GET',
    '/contracts',
    async (_req, { query }) => {
      const rows = (await call('contract.list', { limit: numOpt(query.get('limit')) ?? 100 }, 120000)) ?? []
      return { rows, total: rows.length }
    }
  )
route('GET', '/contracts/:id', (_req, { params, query }) =>
  call('contract.get', { id: num(params.id, 0), withSchema: query.get('withSchema') !== '0' }, 120000)
)
route('GET', '/contracts/:id/diff', (_req, { params, query }) =>
  call(
    'contract.diff',
    {
      baseId: num(params.id, 0),
      query: toRequestQuery(query),
      sampleLimit: numOpt(query.get('sampleLimit'))
    },
    120000
  )
)

/* -------------------------------------------------- 路由：站点资源（读） */

function cookieQueryOf(query) {
  const out = {}
  for (const [key, value] of query) {
    if (key === 'token') continue
    if (['session', 'crossSite', 'secure', 'httpOnly', 'partitioned'].includes(key)) {
      out[key] = value !== '0' && value !== 'false'
    } else if (key === 'limit' || key === 'offset') {
      const n = Number(value)
      if (Number.isFinite(n)) out[key] = n
    } else if (key === 'order') {
      out[key] = value
    } else if (value !== '') {
      out[key] = value
    }
  }
  return out
}

route('GET', '/cookies', (_req, { query }) => call('cookie.list', { query: cookieQueryOf(query) }, 120000))
route('GET', '/cookies/stats', () => call('cookie.stats', {}, 120000))
route('GET', '/sites', (_req, { query }) =>
  call(
    'site.origins',
    { limit: numOpt(query.get('limit')), onlyScanned: query.get('onlyScanned') === '1' },
    120000
  )
)
route('GET', '/sites/detail', (_req, { query }) => call('site.detail', { origin: query.get('origin') ?? '' }, 120000))
route('GET', '/sites/snapshots', (_req, { query }) => {
  // 列表接口统一 { rows, total }：裸数组会让 agent 每次都得特判
  return call('site.snapshots', { limit: numOpt(query.get('limit')) }, 120000).then((rows) => ({
    rows: rows ?? [],
    total: (rows ?? []).length
  }))
})
route('GET', '/sites/snapshots/:id/diff', (_req, { params }) =>
  call('site.snapshotDiff', { baseId: num(params.id, 0) }, 120000)
)

/* -------------------------------------------------- 路由：站点资源（写） */

route('POST', '/sites/scan', (_req, { body }) =>
  call(
    'site.scan',
    {
      origin: body?.origin === undefined ? undefined : String(body.origin),
      limit: numOpt(body?.limit),
      cookies: body?.cookies !== false
    },
    180000
  ), { mutating: true })
route('POST', '/cookies', (_req, { body }) => call('cookie.set', { cookie: body ?? {} }, 60000), { mutating: true })
route('DELETE', '/cookies', (_req, { query }) => {
  // 走 query 传条件：DELETE 带 JSON body 在 fetch 里是灰色地带，别让 agent 每次都得踩
  const filter = {}
  for (const key of ['name', 'domain', 'path', 'url', 'host']) {
    const value = query.get(key)
    if (value) filter[key] = value
  }
  if (query.get('crossSite') === '1') filter.crossSiteOnly = true
  return call('cookie.delete', { filter }, 120000)
}, { mutating: true })
route('POST', '/sites/clear', (_req, { body }) =>
  call('site.clear', { origin: String(body?.origin ?? ''), types: body?.types ?? [] }, 180000), { mutating: true })
route('POST', '/sites/storage', (_req, { body }) => call('site.storage', { input: body ?? {} }, 120000), { mutating: true })
route('POST', '/sites/idb/delete', (_req, { body }) =>
  call('site.idbDelete', { origin: String(body?.origin ?? ''), name: String(body?.name ?? '') }, 120000), { mutating: true })
route('POST', '/sites/cache/delete', (_req, { body }) =>
  call(
    'site.cacheDelete',
    { origin: String(body?.origin ?? ''), name: String(body?.name ?? ''), url: body?.url },
    120000
  ), { mutating: true })
route('POST', '/sites/sw/unregister', (_req, { body }) =>
  call('site.swUnregister', { scopeURL: String(body?.scopeURL ?? '') }, 120000), { mutating: true })
route('POST', '/sites/snapshots', (_req, { body }) => call('site.snapshot', { label: body?.label }, 180000), { mutating: true })
route('DELETE', '/sites/snapshots/:id', (_req, { params }) => call('site.snapshotDelete', { id: num(params.id, 0) }), {
  mutating: true
})

/* -------------------------------------------------- 路由：分析层（写） */

route('DELETE', '/contracts/:id', (_req, { params }) => call('contract.delete', { id: num(params.id, 0) }), {
  mutating: true
})
route('POST', '/contracts', (_req, { body }) =>
  call(
    'contract.snapshot',
    {
      label: body?.label === undefined ? undefined : String(body.label),
      query: body?.query ?? {},
      sampleLimit: numOpt(body?.sampleLimit)
    },
    120000
  ), { mutating: true }
)
route('POST', '/export/har', (_req, { body }) => call('export.har', exportArgsOf(body ?? {}), 180000), { mutating: true })
route('POST', '/export/jsonl', (_req, { body }) => call('export.jsonl', exportArgsOf(body ?? {}), 180000), { mutating: true })
route('POST', '/export/bodies', (_req, { body }) => call('export.bodies', exportArgsOf(body ?? {}), 180000), { mutating: true })
// 对话框要能应答：不响应的话页面会一直卡着（渲染进程被挂住，采集也停）
route('POST', '/dialog', (_req, { body }) =>
  call('dialog.handle', { accept: body?.accept !== false, promptText: body?.promptText }, 60000), { mutating: true }
)

/**
 * 事件流的 SSE 通道。
 *
 * 为什么要有它：agent 想要的往往是「页面一动我立刻知道」，而不是自己掐表轮询。
 * 上游是请求/应答模型、没有推送能力，所以这里用 since 游标做增量拉取，
 * 再转成 SSE 推给下游 —— 对下游是推、对上游是拉，两边都不用改协议。
 */
function streamEvents(req, res, url) {
  const intervalMs = Math.min(Math.max(num(url.searchParams.get('interval'), 500), 100), 5000)
  const kinds = csv(url.searchParams.get('kinds'))
  const level = url.searchParams.get('level') || undefined
  let since = num(url.searchParams.get('since'), 0)
  let busy = false
  let closed = false
  let ticks = 0

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive'
  })
  res.write(': monitor events stream\n\n')

  const write = (text) => {
    if (closed) return
    try {
      res.write(text)
    } catch {
      /* 下游断了，close 事件会收尾 */
    }
  }

  const timer = setInterval(async () => {
    if (busy || closed) return
    busy = true
    ticks += 1
    try {
      const query = { since, limit: 200, order: 'asc' }
      if (kinds.length > 0) query.kinds = kinds
      if (level) query.level = level
      const result = await call('events.query', { query }, 30000)
      const rows = result?.rows ?? []
      if (rows.length > 0) {
        since = result.nextSince ?? rows[rows.length - 1].id
        write(`event: events\ndata: ${JSON.stringify({ rows, latest: result.latest })}\n\n`)
      } else if (ticks % 20 === 0) {
        // 心跳：每 20 拍一次就够了，别把连接灌成注释流
        write(': keep-alive\n\n')
      }
    } catch (err) {
      write(`event: error\ndata: ${JSON.stringify({ message: err instanceof Error ? err.message : String(err) })}\n\n`)
    } finally {
      busy = false
    }
  }, intervalMs)

  const done = () => {
    if (closed) return
    closed = true
    clearInterval(timer)
  }
  req.on('close', done)
  req.on('error', done)
  res.on('close', done)
}
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

  // SSE 与文件下载要先于路由匹配：它们自己写响应头，不走 send() 那套 JSON 包装
  if (pathname === '/events/stream' && req.method === 'GET') return streamEvents(req, res, url)
  if (pathname === '/exports/download' && req.method === 'GET') {
    // 导出目录里的纯文件名。这个口是给 agent 取 HAR / 资源包的，
    // 不能因为图省事变成任意文件读取 —— 分隔符与 .. 一律拒绝
    const name = url.searchParams.get('name') ?? ''
    const base = join(DATA_DIR, 'exports')
    const file = join(base, name)
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..') || !file.startsWith(base)) {
      return send(res, 400, { ok: false, error: 'name 只能是导出目录下的文件名' })
    }
    try {
      const data = readFileSync(file)
      res.writeHead(200, {
        'content-type': name.endsWith('.har') ? 'application/json; charset=utf-8' : 'application/octet-stream',
        'content-length': data.length,
        'cache-control': 'no-store'
      })
      return res.end(data)
    } catch {
      return send(res, 404, { ok: false, error: '没有这个导出文件：' + name })
    }
  }

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
