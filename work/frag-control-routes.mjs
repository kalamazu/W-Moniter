
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
route('GET', '/contracts', (_req, { query }) => call('contract.list', { limit: numOpt(query.get('limit')) ?? 100 }, 120000))
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