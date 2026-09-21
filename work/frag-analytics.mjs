/* ==========================================================================
 * 分析层：事件流 / WebSocket / 接口画像 / 调用图 / 关联 / 导出 / 契约回归
 *
 * 三条共同约定：
 *   1) 只读。这一层不写业务表（契约快照除外，它有自己一张表）——
 *      分析结果坏了可以随时重算，不给它污染采集数据的机会。
 *   2) 上限显式。每次扫描都带 maxRows，超了如实报 truncated：
 *      「少看了一眼」和「看全了」必须在结果里分得清。
 *   3) 单位进字段名（*Ms / *Bytes / *Count）。agent 拿到的数字要能直接用。
 * ======================================================================== */

/** 一次分析默认扫多少行。它同时是「这次 RPC 要花多久」的总闸门 */
const ANALYZE_ROWS_DEFAULT = 20000
const ANALYZE_ROWS_MAX = 100000
/** 路径模板最多保留几段，超长路径只做前缀 */
const TEMPLATE_MAX_SEGMENTS = 8
/** 每个 query / body 字段最多留几个样本取值 */
const VALUE_SAMPLES_PER_KEY = 6
/** 一次返回的端点 / 节点上限 */
const LIST_LIMIT_MAX = 1000
/** 参与 schema 推断的单条 body 上限 */
const SCHEMA_SAMPLE_BYTES = 256 * 1024
/** 导出目录：放在库文件旁边，跟着数据目录一起被备份或清理 */
const EXPORT_DIR_NAME = 'exports'
/** HAR 里的 creator 字段。写死成常量，是给下游工具认「这是谁导的」 */
const EXPORT_CREATOR = { name: 'chromium-monitor', version: '0.1.0' }

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.trunc(n), min), max)
}

function bumpMap(map, key, amount = 1) {
  if (key === undefined || key === null || key === '') return
  map.set(key, (map.get(key) ?? 0) + amount)
}

/** Map 计数 → 排序后的行。排序稳定（同计数按名字），两次调用结果不会飘 */
function mapRows(map, limit = 30) {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)))
    .slice(0, limit)
}

function decodeLoose(text) {
  try {
    return decodeURIComponent(String(text).replace(/\+/g, ' '))
  } catch {
    return String(text)
  }
}

/**
 * 路径模板化。
 *
 * 接口画像要按「同一个接口」聚合，而 REST 路径里带的是实例 id；
 * 不归一化的话每个用户、每条消息都是一个独立端点，画像就散了。
 * 只做保守替换：宁可少归一（多出两个模板），也不要错归一
 * （把 /users/me 和 /users/1 并成一个，那种分析结论是错的）。
 */
function templateSegment(segment) {
  if (!segment) return segment
  if (/^[0-9]+$/.test(segment)) return '{int}'
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(segment)) return '{uuid}'
  if (/^[0-9a-fA-F]{16,}$/.test(segment)) return '{hex}'
  if (/^[0-9]{4}-[0-9]{2}(-[0-9]{2})?/.test(segment)) return '{date}'
  if (segment.length >= 20 && /^[A-Za-z0-9_~+=-]+$/.test(segment)) return '{token}'
  // bundle.8f3a2b1c.js 这类：只把中间那段 hash 换掉
  return segment.replace(/\.([0-9a-fA-F]{8,})\./, '.{hash}.')
}

function templatePath(pathname) {
  const raw = pathname || '/'
  const parts = raw.split('/')
  const out = []
  for (let i = 0; i < parts.length && i < TEMPLATE_MAX_SEGMENTS; i++) out.push(templateSegment(parts[i]))
  if (parts.length > out.length) out.push('...')
  return out.join('/') || '/'
}

function endpointKeyOf(method, host, template) {
  return String(method || 'GET').toUpperCase() + ' ' + (host || '') + template
}

function parseQueryPairs(query) {
  const out = []
  if (!query) return out
  for (const pair of String(query).split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    out.push([
      decodeLoose(eq === -1 ? pair : pair.slice(0, eq)),
      eq === -1 ? '' : decodeLoose(pair.slice(eq + 1))
    ])
  }
  return out
}

function isJsonMime(mime) {
  return typeof mime === 'string' && mime.toLowerCase().includes('json')
}

/** 百分位。durations 必须已排序；空数组给 null，别用 0 冒充「很快」 */
function percentile(sorted, p) {
  if (!sorted || sorted.length === 0) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

/* ------------------------------------------------------------ 形状推断 */

/**
 * JSON → 结构化形状。画像要回答的是「这个接口返回的结构稳不稳」，
 * 所以数组只看元素形状的合并，对象只记字段名与类型的合并 + 出现次数。
 * 深度和宽度都设上限：一份 5MB 的响应不能把一次 RPC 拖成秒级。
 */
function inferSchema(value, depth = 0) {
  if (value === null) return { t: 'null' }
  if (Array.isArray(value)) {
    let items = null
    if (depth < 6) {
      for (const item of value.slice(0, 16)) {
        const one = inferSchema(item, depth + 1)
        items = items ? mergeSchema(items, one) : one
      }
    }
    return { t: 'array', items, len: value.length }
  }
  const kind = typeof value
  if (kind === 'object') {
    const fields = {}
    if (depth < 6) {
      for (const [key, item] of Object.entries(value)) {
        fields[key] = { ...inferSchema(item, depth + 1), seen: 1 }
      }
    }
    return { t: 'object', count: 1, fields }
  }
  if (kind === 'number') return { t: Number.isInteger(value) ? 'int' : 'float' }
  if (kind === 'boolean') return { t: 'bool' }
  if (kind === 'string') return { t: 'string' }
  return { t: 'unknown' }
}

/** 两份形状合并。类型不同退化成 union，而不是随便挑一个 —— 类型漂移是重要信号 */
function mergeSchema(a, b) {
  if (!a) return b
  if (!b) return a
  if (a.t !== b.t) {
    const of = []
    for (const one of [a, b]) {
      if (one.t === 'union') for (const item of one.of) of.push(item)
      else of.push(one)
    }
    const uniq = []
    for (const item of of) if (!uniq.some((other) => other.t === item.t)) uniq.push(item)
    return { t: 'union', of: uniq.sort((x, y) => x.t.localeCompare(y.t)) }
  }
  if (a.t === 'object') {
    const fields = {}
    const keys = new Set([...Object.keys(a.fields || {}), ...Object.keys(b.fields || {})])
    for (const key of keys) {
      const left = a.fields?.[key]
      const right = b.fields?.[key]
      const merged = { ...(left && right ? mergeSchema(left, right) : left || right) }
      merged.seen = (left?.seen ?? 0) + (right?.seen ?? 0)
      fields[key] = merged
    }
    return { t: 'object', count: (a.count ?? 1) + (b.count ?? 1), fields }
  }
  if (a.t === 'array') {
    return {
      t: 'array',
      items: a.items && b.items ? mergeSchema(a.items, b.items) : a.items || b.items || null,
      len: Math.max(a.len ?? 0, b.len ?? 0)
    }
  }
  return { ...a }
}
/** 形状 → 扁平路径表。契约回归比对的就是这张表（字段增删 / 类型变化） */
function schemaToPaths(schema, prefix = '', out = []) {
  if (!schema) return out
  if (schema.t === 'object') {
    for (const [key, child] of Object.entries(schema.fields || {})) {
      const path = prefix ? prefix + '.' + key : key
      out.push({
        path,
        type: child.t,
        // seen 少于样本数 = 不是每次都有。契约里「必现字段」和「可选字段」是两回事
        optional: (child.seen ?? 0) < (schema.count ?? 1)
      })
      schemaToPaths(child, path, out)
    }
    return out
  }
  if (schema.t === 'array') {
    const path = prefix ? prefix + '[]' : '[]'
    out.push({ path, type: 'array' })
    if (schema.items) schemaToPaths(schema.items, path, out)
    return out
  }
  const path = prefix || '(root)'
  out.push({ path, type: schema.t })
  return out
}

/** 两份形状比出增删与类型漂移。这是契约回归的核心判据 */
function diffSchema(base, current) {
  const before = new Map(schemaToPaths(base).map((item) => [item.path, item]))
  const after = new Map(schemaToPaths(current).map((item) => [item.path, item]))
  const added = []
  const removed = []
  const typeChanged = []
  for (const [path, item] of after) {
    if (!before.has(path)) added.push(item)
    else if (before.get(path).type !== item.type) {
      typeChanged.push({ path, from: before.get(path).type, to: item.type })
    }
  }
  for (const [path, item] of before) if (!after.has(path)) removed.push(item)
  return { added, removed, typeChanged }
}

/* -------------------------------------------------------- 画像的原料 */

/**
 * req_body 是一段字符串。只做三种识别：JSON、表单、原样。
 * 认不出来本身也是信息，记成 (raw) —— 不能因为解析失败就当没这个 body。
 */
function bodyFieldKind(text) {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json'
  if (trimmed.length > 0 && trimmed.length < 8192 && /^[^=&]+=([^&]*)(&[^=&]+=([^&]*))*$/.test(trimmed)) {
    return 'form'
  }
  return 'raw'
}

/** 字段取值分布。样本只留前几个不同值 —— 画像看的是「长什么样」，不是全量数据 */
function bumpField(fields, name, value, total) {
  let slot = fields.get(name)
  if (!slot) {
    slot = { count: 0, seen: 0, values: [] }
    fields.set(name, slot)
  }
  slot.count += 1
  const text = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value)
  if (text !== undefined && text !== '') {
    const clipped = text.length > 120 ? text.slice(0, 120) + '…' : text
    if (slot.values.length < VALUE_SAMPLES_PER_KEY && !slot.values.includes(clipped)) slot.values.push(clipped)
  }
}

function fieldsToRows(fields, sampleTotal, limit = 40) {
  return [...fields.entries()]
    .map(([name, slot]) => ({
      name,
      count: slot.count,
      // 必填 = 每一次「有 body/query 的样本」里都出现
      required: sampleTotal > 0 && slot.count >= sampleTotal,
      values: slot.values
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit)
}

/** 扫一批请求行。maxRows 之外的行数会如实报出来 */
function scanRequests(inst, filter, columns, maxRows) {
  const where = buildWhere({ ...(filter || {}), inst })
  const limit = clampInt(maxRows, ANALYZE_ROWS_DEFAULT, 1, ANALYZE_ROWS_MAX)
  const total = db.prepare('SELECT COUNT(*) AS c FROM requests ' + where.sql).get(...where.params).c
  const rows = db
    .prepare(
      'SELECT ' + columns.join(', ') + ' FROM requests ' + where.sql +
        ' ORDER BY start_ts DESC, seq DESC LIMIT ?'
    )
    .all(...where.params, limit)
  // 上面按时间倒序取「最近的 N 行」，这里翻回时间正序 —— 调用方按时间累积状态才自然
  rows.reverse()
  return { rows, total, truncated: total > rows.length }
}

const ENDPOINT_SCAN_COLUMNS = [
  'seq', 'method', 'host', 'path', 'query', 'status', 'duration_ms', 'ttfb_ms',
  'encoded_len', 'decoded_len', 'mime_type', 'resource_type', 'url', 'from_cache',
  'from_sw', 'failed', 'req_body', 'body_hash', 'body_state', 'body_size',
  'start_ts', 'target_type', 'frame_url', 'initiator_stack', 'initiator_type'
]

const EXPORT_SCAN_COLUMNS = ENDPOINT_SCAN_COLUMNS.concat([
  'inst', 'request_id', 'session_id', 'protocol', 'remote_ip', 'remote_port',
  'status_text', 'req_headers', 'resp_headers', 'end_ts', 'canceled', 'body_trunc',
  'merge_state', 'proxy_flow_id', 'net_dns_ms', 'net_connect_ms', 'net_tls_ms',
  'upstream_ip', 'tls_version', 'tls_cipher', 'upstream_alpn', 'scheme'
])

function newEndpointSlot(key) {
  return {
    key,
    calls: 0,
    urls: new Set(),
    statuses: new Map(),
    mimeTypes: new Map(),
    resourceTypes: new Map(),
    targetTypes: new Map(),
    durations: [],
    bytes: 0,
    decodedBytes: 0,
    failed: 0,
    cached: 0,
    fromSw: 0,
    withBody: 0,
    queryFields: new Map(),
    querySamples: 0,
    bodyFields: new Map(),
    bodySamples: 0,
    bodyKinds: new Map(),
    intervals: [],
    lastTs: null,
    firstTs: null,
    samples: []
  }
}

function addRowToSlot(slot, row) {
  slot.calls += 1
  if (row.url) slot.urls.add(row.url)
  bumpMap(slot.statuses, row.status === null || row.status === undefined ? '(pending)' : String(row.status))
  if (row.mime_type) bumpMap(slot.mimeTypes, row.mime_type)
  if (row.resource_type) bumpMap(slot.resourceTypes, row.resource_type)
  if (row.target_type) bumpMap(slot.targetTypes, row.target_type)
  if (typeof row.duration_ms === 'number') slot.durations.push(row.duration_ms)
  slot.bytes += Number(row.encoded_len) || 0
  slot.decodedBytes += Number(row.decoded_len) || 0
  if (row.failed) slot.failed += 1
  if (row.from_cache) slot.cached += 1
  if (row.from_sw) slot.fromSw += 1
  if (row.body_state === 'stored') slot.withBody += 1

  const pairs = parseQueryPairs(row.query)
  if (pairs.length > 0) {
    slot.querySamples += 1
    for (const [name, value] of pairs) bumpField(slot.queryFields, name, value)
  }

  const slot2 = row.req_body ? String(row.req_body) : ''
  if (slot2) {
    const kind = bodyFieldKind(slot2)
    bumpMap(slot.bodyKinds, kind)
    try {
      if (kind === 'json') {
        const parsed = JSON.parse(slot2)
        slot.bodySamples += 1
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [key, value] of Object.entries(parsed)) bumpField(slot.bodyFields, key, value)
        } else {
          bumpField(slot.bodyFields, Array.isArray(parsed) ? '(数组)' : '(标量)', Array.isArray(parsed) ? parsed.length + ' 项' : parsed)
        }
      } else if (kind === 'form') {
        slot.bodySamples += 1
        for (const [name, value] of parseQueryPairs(slot2)) bumpField(slot.bodyFields, name, value)
      } else {
        bumpField(slot.bodyFields, '(raw)', slot2.slice(0, 120))
      }
    } catch {
      bumpField(slot.bodyFields, '(raw)', slot2.slice(0, 120))
    }
  }

  if (typeof row.start_ts === 'number') {
    if (slot.firstTs === null || row.start_ts < slot.firstTs) slot.firstTs = row.start_ts
    if (slot.lastTs === null || row.start_ts > slot.lastTs) slot.lastTs = row.start_ts
    slot.intervals.push(row.start_ts)
  }
  if (slot.samples.length < 20) slot.samples.push(row.seq)
}

/**
 * 调用节奏：看的是「这个接口是不是在被轮询」。
 * 用中位间隔而不是平均间隔 —— 平均值会被一次长暂停彻底带偏。
 */
function callRhythm(intervals) {
  if (!intervals || intervals.length < 3) return null
  const sorted = intervals.slice().sort((a, b) => a - b)
  const gaps = []
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i] - sorted[i - 1])
  if (gaps.length === 0) return null
  gaps.sort((a, b) => a - b)
  const median = gaps[Math.floor(gaps.length / 2)]
  return { medianGapMs: Math.round(median), spanMs: Math.round(sorted[sorted.length - 1] - sorted[0]) }
}

function finalizeEndpointSlot(slot) {
  const durations = slot.durations.slice().sort((a, b) => a - b)
  return {
    key: slot.key,
    calls: slot.calls,
    distinctUrls: slot.urls.size,
    sampleUrls: [...slot.urls].slice(0, 3),
    samples: slot.samples.slice(0, 5),
    statuses: mapRows(slot.statuses),
    mimeTypes: mapRows(slot.mimeTypes, 5),
    resourceTypes: mapRows(slot.resourceTypes, 5),
    targetTypes: mapRows(slot.targetTypes, 5),
    durationMs: {
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
      min: durations.length ? durations[0] : null,
      max: durations.length ? durations[durations.length - 1] : null
    },
    bytes: slot.bytes,
    decodedBytes: slot.decodedBytes,
    failed: slot.failed,
    cached: slot.cached,
    fromSw: slot.fromSw,
    withBody: slot.withBody,
    query: fieldsToRows(slot.queryFields, slot.querySamples),
    requestBody: { samples: slot.bodySamples, kinds: mapRows(slot.bodyKinds, 5), fields: fieldsToRows(slot.bodyFields, slot.bodySamples) },
    rhythm: callRhythm(slot.intervals),
    firstTs: slot.firstTs,
    lastTs: slot.lastTs
  }
}

/** 一批行 → 端点画像。所有画像类操作都从这里出，保证口径一致 */
function buildEndpointSlots(rows) {
  const slots = new Map()
  for (const row of rows) {
    const key = endpointKeyOf(row.method, row.host, templatePath(row.path))
    let slot = slots.get(key)
    if (!slot) {
      slot = newEndpointSlot(key)
      slots.set(key, slot)
    }
    addRowToSlot(slot, row)
  }
  return slots
}
/* ============================================================ 事件流查询 */

/** detail 列存的是字符串；能解析成结构就交结构出去，agent 少一层解析 */
function parseDetail(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return raw ?? null
  const first = raw[0]
  if (first !== '{' && first !== '[') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function toEventRow(row) {
  return {
    id: row.id,
    ts: row.ts,
    kind: row.kind,
    level: row.level ?? 'info',
    targetType: row.target_type ?? null,
    url: row.url ?? null,
    detail: parseDetail(row.detail)
  }
}

function eventFilter(args) {
  const clauses = ['inst = ?']
  const params = [norm(args.inst)]
  const since = Number(args.since)
  if (Number.isFinite(since)) {
    clauses.push('id > ?')
    params.push(since)
  }
  const until = Number(args.until)
  if (Number.isFinite(until)) {
    clauses.push('id <= ?')
    params.push(until)
  }
  const kinds = Array.isArray(args.kinds) ? args.kinds.filter(Boolean) : args.kind ? [args.kind] : []
  if (kinds.length > 0) {
    clauses.push('kind IN (' + kinds.map(() => '?').join(',') + ')')
    params.push(...kinds.map((kind) => String(kind)))
  }
  if (args.level) {
    clauses.push('level = ?')
    params.push(String(args.level))
  }
  if (args.targetType) {
    clauses.push('target_type = ?')
    params.push(String(args.targetType))
  }
  if (args.search) {
    const like = '%' + args.search + '%'
    clauses.push('(url LIKE ? OR detail LIKE ? OR kind LIKE ?)')
    params.push(like, like, like)
  }
  return { sql: 'WHERE ' + clauses.join(' AND '), params }
}

/**
 * 事件流查询。增量拉取的契约是 `since` = 上一次拿到的最后一条 id：
 * id 是自增主键，天然单调 + 不会因为时钟回拨而乱序 —— 时间戳做不到这一点。
 */
function queryEvents(args) {
  const where = eventFilter(args)
  const limit = clampInt(args.limit, 200, 1, 5000)
  const desc = args.order === 'desc'
  const rows = db
    .prepare(
      'SELECT id, ts, kind, level, target_type, url, detail FROM events ' + where.sql +
        ' ORDER BY id ' + (desc ? 'DESC' : 'ASC') + ' LIMIT ?'
    )
    .all(...where.params, limit)
  // 统一按 id 升序交出去：调用方拿到的批次不该因为 order 改变行的顺序语义
  rows.sort((a, b) => a.id - b.id)
  const inst = norm(args.inst)
  const latest = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events WHERE inst = ?').get(inst).id
  return {
    rows: rows.map(toEventRow),
    latest,
    nextSince: rows.length > 0 ? rows[rows.length - 1].id : Number(args.since) || 0,
    total: db.prepare('SELECT COUNT(*) AS c FROM events WHERE inst = ?').get(inst).c
  }
}

function eventStats(args) {
  const inst = norm(args.inst)
  return {
    rows: db
      .prepare(
        'SELECT kind, level, COUNT(*) AS count, MIN(ts) AS firstTs, MAX(ts) AS lastTs, ' +
          'MAX(id) AS latestId FROM events WHERE inst = ? GROUP BY kind, level ORDER BY count DESC'
      )
      .all(inst),
    latest: db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events WHERE inst = ?').get(inst).id,
    total: db.prepare('SELECT COUNT(*) AS c FROM events WHERE inst = ?').get(inst).c
  }
}

/* ========================================================= WebSocket 帧 */

const OPCODE_NAMES = {
  0: 'continuation',
  1: 'text',
  2: 'binary',
  8: 'close',
  9: 'ping',
  10: 'pong'
}

function queryWsFrames(args) {
  const clauses = ['inst = ?']
  const params = [norm(args.inst)]
  const since = Number(args.since)
  if (Number.isFinite(since)) {
    clauses.push('id > ?')
    params.push(since)
  }
  if (args.direction) {
    clauses.push('direction = ?')
    params.push(String(args.direction))
  }
  if (args.requestId) {
    clauses.push('request_id = ?')
    params.push(String(args.requestId))
  }
  const opcode = Number(args.opcode)
  if (Number.isFinite(opcode)) {
    clauses.push('opcode = ?')
    params.push(opcode)
  }
  if (args.search) {
    const like = '%' + args.search + '%'
    clauses.push('(url LIKE ? OR payload LIKE ?)')
    params.push(like, like)
  }
  const where = 'WHERE ' + clauses.join(' AND ')
  const limit = clampInt(args.limit, 200, 1, 5000)
  const rows = db
    .prepare(
      'SELECT id, seq, ts, request_id, url, direction, opcode, payload, size, truncated, binary ' +
        'FROM ws_frames ' + where + ' ORDER BY id ' + (args.order === 'desc' ? 'DESC' : 'ASC') + ' LIMIT ?'
    )
    .all(...params, limit)
  rows.sort((a, b) => a.id - b.id)
  const inst = norm(args.inst)
  const latest = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM ws_frames WHERE inst = ?').get(inst).id
  return {
    rows: rows.map((row) => ({
      id: row.id,
      seq: row.seq,
      ts: row.ts,
      requestId: row.request_id,
      url: row.url,
      direction: row.direction,
      opcode: row.opcode,
      opcodeName: OPCODE_NAMES[row.opcode] ?? String(row.opcode),
      binary: Boolean(row.binary),
      size: row.size,
      truncated: Boolean(row.truncated),
      payload: row.payload
    })),
    latest,
    nextSince: rows.length > 0 ? rows[rows.length - 1].id : Number(args.since) || 0,
    total: db.prepare('SELECT COUNT(*) AS c FROM ws_frames WHERE inst = ?').get(inst).c
  }
}

/** 按连接汇总。面板先列连接、点开再看帧，几千帧的会话才不会一上来就糊一屏 */
function wsConnections(args) {
  const inst = norm(args.inst)
  const limit = clampInt(args.limit, 50, 1, 500)
  const rows = db
    .prepare(
      'SELECT request_id AS requestId, url, ' +
        'COUNT(*) AS frames, ' +
        "SUM(CASE WHEN direction = 'sent' THEN 1 ELSE 0 END) AS sent, " +
        "SUM(CASE WHEN direction = 'received' THEN 1 ELSE 0 END) AS received, " +
        'SUM(CASE WHEN binary = 1 THEN 1 ELSE 0 END) AS binaryFrames, ' +
        'SUM(CASE WHEN truncated = 1 THEN 1 ELSE 0 END) AS truncatedFrames, ' +
        'COALESCE(SUM(size), 0) AS bytes, ' +
        'MIN(ts) AS firstTs, MAX(ts) AS lastTs, MIN(seq) AS seq ' +
        'FROM ws_frames WHERE inst = ? GROUP BY request_id, url ORDER BY MAX(ts) DESC LIMIT ?'
    )
    .all(inst, limit)
  return { rows, total: rows.length }
}
/* ============================================================== 接口画像 */

const ENDPOINT_SORTS = {
  calls: (a, b) => b.calls - a.calls || a.key.localeCompare(b.key),
  p95: (a, b) => (b.durationMs.p95 ?? 0) - (a.durationMs.p95 ?? 0) || a.key.localeCompare(b.key),
  bytes: (a, b) => b.bytes - a.bytes || a.key.localeCompare(b.key),
  failed: (a, b) => b.failed - a.failed || a.key.localeCompare(b.key),
  recent: (a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0) || a.key.localeCompare(b.key),
  name: (a, b) => a.key.localeCompare(b.key)
}

/** 按「方法 + 主机 + 路径模板」聚类，给出调用次数/耗时分布/字段分布 */
function endpointProfiles(args) {
  const inst = norm(args.inst)
  const scan = scanRequests(inst, args.filter, ENDPOINT_SCAN_COLUMNS, args.maxRows)
  const minCalls = clampInt(args.minCalls, 1, 1, Number.MAX_SAFE_INTEGER)
  const list = [...buildEndpointSlots(scan.rows).values()]
    .map(finalizeEndpointSlot)
    .filter((item) => item.calls >= minCalls)
  list.sort(ENDPOINT_SORTS[args.sort] ?? ENDPOINT_SORTS.calls)
  const limit = clampInt(args.limit, 200, 1, LIST_LIMIT_MAX)
  return {
    endpoints: list.slice(0, limit),
    matched: list.length,
    scanned: scan.rows.length,
    total: scan.total,
    truncated: scan.truncated,
    sort: ENDPOINT_SORTS[args.sort] ? args.sort : 'calls'
  }
}

function readBodyBytes(hash) {
  const row = db.prepare('SELECT size, stored, blob FROM bodies WHERE hash = ?').get(norm(hash))
  if (!row || !row.stored || !row.blob) return null
  const bytes = row.blob instanceof Uint8Array ? row.blob : new Uint8Array(row.blob)
  return { bytes, size: row.size }
}

/**
 * 从最近的若干条响应体推一份合并形状。
 *
 * 只吃 JSON：HTML/JS 推出来的「形状」没有契约价值，二进制更不行 ——
 * 硬推只会得到一堆看着像字段的噪音。没样本时如实返回 null，别编一个 {}。
 */
function sampleResponseSchema(rows, limit) {
  const shapes = []
  let skipped = 0
  for (let i = rows.length - 1; i >= 0 && shapes.length < limit; i--) {
    const row = rows[i]
    if (!isJsonMime(row.mime_type) || !row.body_hash) continue
    const body = readBodyBytes(row.body_hash)
    if (!body) {
      skipped += 1
      continue
    }
    if (body.size > SCHEMA_SAMPLE_BYTES) {
      skipped += 1
      continue
    }
    let value
    try {
      value = JSON.parse(body.bytes.toString('utf8'))
    } catch {
      skipped += 1
      continue
    }
    shapes.push(inferSchema(value))
  }
  let schema = null
  for (const shape of shapes) schema = schema ? mergeSchema(schema, shape) : shape
  return { schema, samples: shapes.length, skipped }
}

/** 请求体的形状：直接吃 req_body 字符串（JSON 才推） */
function sampleRequestSchema(rows, limit) {
  const shapes = []
  for (let i = rows.length - 1; i >= 0 && shapes.length < limit; i--) {
    const text = rows[i].req_body
    if (!text || bodyFieldKind(String(text)) !== 'json') continue
    try {
      shapes.push(inferSchema(JSON.parse(String(text))))
    } catch {
      /* 声明是 JSON 但解析不了：不值得为它停下 */
    }
  }
  let schema = null
  for (const shape of shapes) schema = schema ? mergeSchema(schema, shape) : shape
  return { schema, samples: shapes.length }
}

function endpointDetail(args) {
  const inst = norm(args.inst)
  const key = String(args.key ?? '')
  if (!key) return { key, found: false, error: 'key 必填，形如 "GET api.example.com/api/user/{int}"（从 endpointProfiles 拿）' }
  // 这里必须扫全量而不是走 maxRows 的默认值：端点详情是「点进去看」的场景，
  // 少一行都可能让 p95 和字段分布对不上画像列表里的数字
  const scan = scanRequests(inst, args.filter, ENDPOINT_SCAN_COLUMNS, args.maxRows ?? ANALYZE_ROWS_MAX)
  const rows = []
  for (const row of scan.rows) {
    if (endpointKeyOf(row.method, row.host, templatePath(row.path)) === key) rows.push(row)
  }
  if (rows.length === 0) return { key, found: false, calls: 0, scanned: scan.rows.length, truncated: scan.truncated }

  const slots = buildEndpointSlots(rows)
  const profile = finalizeEndpointSlot(slots.get(key))
  const sampleLimit = clampInt(args.sampleLimit, 3, 1, 20)
  const response = sampleResponseSchema(rows, sampleLimit)
  const request = sampleRequestSchema(rows, sampleLimit)

  const callLimit = clampInt(args.callLimit, 30, 1, 200)
  const calls = []
  for (let i = rows.length - 1; i >= 0 && calls.length < callLimit; i--) {
    const row = rows[i]
    calls.push({
      seq: row.seq,
      ts: row.start_ts,
      url: row.url,
      status: row.status,
      durationMs: row.duration_ms,
      ttfbMs: row.ttfb_ms,
      bytes: row.encoded_len,
      fromCache: Boolean(row.from_cache),
      fromSw: Boolean(row.from_sw),
      bodyState: row.body_state,
      targetType: row.target_type,
      failed: row.failed ?? null
    })
  }

  return {
    key,
    found: true,
    calls: calls.length,
    totalCalls: rows.length,
    profile,
    recent: calls,
    responseSchema: response.schema,
    responseSamples: response.samples,
    responseSamplesSkipped: response.skipped,
    requestSchema: request.schema,
    requestSamples: request.samples,
    truncated: scan.truncated
  }
}

/* ================================================================ 调用图 */

function hostOf(url) {
  if (typeof url !== 'string' || url.length === 0) return null
  const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/.exec(url)
  return match ? match[1] : null
}

function shortUrl(url, max = 90) {
  if (typeof url !== 'string') return ''
  return url.length > max ? url.slice(0, max) + '…' : url
}

/**
 * 一条请求的「发起方」节点。
 *
 * 优先级：有 initiator.url（脚本或文档 URL）就用它；没有就用 frame_url；
 * 再没有就只能按 initiator.type 归一类。把 XHR 的 initiator.type=script 直接
 * 当节点会得到一个巨大的 "script" 中心节点 —— 那种图没有信息量。
 */
function initiatorNode(row) {
  let info = null
  if (row.initiator_stack) {
    try {
      info = JSON.parse(row.initiator_stack)
    } catch {
      info = null
    }
  }
  const type = row.initiator_type || info?.type || 'other'
  const frame = info?.frames?.[0]
  const url = info?.url || frame?.url || ''
  if (!url) {
    if (row.frame_url) {
      return { key: 'document|' + row.frame_url, kind: 'document', label: shortUrl(row.frame_url), url: row.frame_url }
    }
    return { key: 'kind|' + type, kind: type, label: '(' + type + ' 发起，无 URL)', url: null }
  }
  if (type === 'parser') {
    return { key: 'document|' + (row.frame_url || url), kind: 'document', label: shortUrl(row.frame_url || url), url: row.frame_url || url }
  }
  if (type === 'script' || /\.m?js(\?|$)/.test(url)) {
    return {
      key: 'script|' + url,
      kind: 'script',
      label: shortUrl(url),
      url,
      functionName: frame?.functionName ? String(frame.functionName) : null
    }
  }
  return { key: 'url|' + url, kind: type, label: shortUrl(url), url }
}

/** 并查集：把「谁触发谁」连成的无向连通分量当作一个功能簇 */
function findRoot(parents, key) {
  let root = key
  while (parents.get(root) !== root) root = parents.get(root)
  let cursor = key
  while (parents.get(cursor) !== root) {
    const next = parents.get(cursor)
    parents.set(cursor, root)
    cursor = next
  }
  return root
}

function requestGraph(args) {
  const inst = norm(args.inst)
  const scan = scanRequests(inst, args.filter, ENDPOINT_SCAN_COLUMNS, args.maxRows)
  const nodes = new Map()
  const edges = new Map()
  const ensure = (key, init) => {
    let node = nodes.get(key)
    if (!node) {
      node = {
        key,
        kind: init.kind,
        label: init.label,
        url: init.url ?? null,
        host: init.host ?? null,
        method: init.method ? String(init.method).toUpperCase() : null,
        functionName: init.functionName ?? null,
        outCalls: 0,
        inCalls: 0
      }
      nodes.set(key, node)
    }
    return node
  }

  for (const row of scan.rows) {
    const template = templatePath(row.path)
    const method = String(row.method || 'GET').toUpperCase()
    const targetKey = 'endpoint|' + endpointKeyOf(method, row.host, template)
    ensure(targetKey, { kind: 'endpoint', label: method + ' ' + (row.host || '') + template, host: row.host, method }).inCalls += 1

    const source = initiatorNode(row)
    ensure(source.key, source).outCalls += 1

    const edgeKey = source.key + '\u0000' + targetKey
    let edge = edges.get(edgeKey)
    if (!edge) {
      edge = { from: source.key, to: targetKey, count: 0, failures: 0, durations: [], kinds: new Map(), samples: [], firstTs: null, lastTs: null }
      edges.set(edgeKey, edge)
    }
    edge.count += 1
    if (row.failed) edge.failures += 1
    if (typeof row.duration_ms === 'number') edge.durations.push(row.duration_ms)
    bumpMap(edge.kinds, row.initiator_type || source.kind)
    if (edge.samples.length < 5) edge.samples.push(row.seq)
    if (typeof row.start_ts === 'number') {
      if (edge.firstTs === null || row.start_ts < edge.firstTs) edge.firstTs = row.start_ts
      if (edge.lastTs === null || row.start_ts > edge.lastTs) edge.lastTs = row.start_ts
    }
  }

  const maxNodes = clampInt(args.maxNodes, 300, 5, 5000)
  let droppedNodes = 0
  if (nodes.size > maxNodes) {
    const ranked = [...nodes.values()].sort((a, b) => b.inCalls + b.outCalls - (a.inCalls + a.outCalls))
    const keep = new Set(ranked.slice(0, maxNodes).map((node) => node.key))
    for (const key of [...nodes.keys()]) {
      if (!keep.has(key)) {
        nodes.delete(key)
        droppedNodes += 1
      }
    }
  }

  const finalEdges = []
  for (const edge of edges.values()) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue
    const durations = edge.durations.slice().sort((a, b) => a - b)
    finalEdges.push({
      from: edge.from,
      to: edge.to,
      count: edge.count,
      failures: edge.failures,
      avgMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
      p95Ms: percentile(durations, 95),
      initiatorTypes: mapRows(edge.kinds, 5),
      samples: edge.samples,
      firstTs: edge.firstTs,
      lastTs: edge.lastTs
    })
  }
  finalEdges.sort((a, b) => b.count - a.count)

  // 连通分量：把互相关联的端点/脚本归成「功能簇」，是「关联分析」的落点
  const parents = new Map()
  for (const node of nodes.values()) parents.set(node.key, node.key)
  for (const edge of finalEdges) {
    const left = findRoot(parents, edge.from)
    const right = findRoot(parents, edge.to)
    if (left !== right) parents.set(left, right)
  }
  const grouped = new Map()
  for (const node of nodes.values()) {
    const root = findRoot(parents, node.key)
    if (!grouped.has(root)) grouped.set(root, [])
    grouped.get(root).push(node.key)
  }
  const clusters = [...grouped.values()]
    .map((keys) => ({ size: keys.length, nodes: keys.slice(0, 40) }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 20)

  return {
    nodes: [...nodes.values()],
    edges: finalEdges,
    clusters,
    scanned: scan.rows.length,
    total: scan.total,
    truncated: scan.truncated,
    droppedNodes
  }
}
/* ============================================================== 关联分析 */

/**
 * 每刷新一次就变、又没有分析价值的 query 参数。不带这个名单的话
 * 「共享参数」会被缓存击穿参数淹没，全是噪音。
 */
const PARAM_NOISE = new Set(['_', '_t', '_v', 'ts', 'timestamp', 'rand', 'random', 'nonce', 'callback', 'cb', '__x'])

function relations(args) {
  const inst = norm(args.inst)
  const scan = scanRequests(inst, args.filter, ENDPOINT_SCAN_COLUMNS, args.maxRows)
  const limit = clampInt(args.limit, 30, 1, 200)
  const bodies = new Map()
  const chains = new Map()
  const links = new Map()
  const params = new Map()

  for (const row of scan.rows) {
    const endpoint = endpointKeyOf(row.method, row.host, templatePath(row.path))
    if (row.body_hash) {
      let slot = bodies.get(row.body_hash)
      if (!slot) {
        slot = { hash: row.body_hash, refs: 0, size: row.body_size ?? null, urls: new Set(), endpoints: new Set(), seqs: [] }
        bodies.set(row.body_hash, slot)
      }
      slot.refs += 1
      if (row.url) slot.urls.add(row.url)
      slot.endpoints.add(endpoint)
      if (slot.seqs.length < 5) slot.seqs.push(row.seq)
    }
    if (row.request_id) {
      let chain = chains.get(row.request_id)
      if (!chain) {
        chain = []
        chains.set(row.request_id, chain)
      }
      chain.push(row)
    }
    const frameHost = hostOf(row.frame_url)
    if (frameHost && row.host && frameHost !== row.host) {
      let byHost = links.get(frameHost)
      if (!byHost) {
        byHost = new Map()
        links.set(frameHost, byHost)
      }
      bumpMap(byHost, row.host)
    }
    for (const [name, value] of parseQueryPairs(row.query)) {
      if (PARAM_NOISE.has(name.toLowerCase()) || value.length === 0 || value.length > 128) continue
      const key = name + '=' + value
      let slot = params.get(key)
      if (!slot) {
        if (params.size >= 20000) continue
        slot = { name, value, endpoints: new Set(), hosts: new Set(), count: 0 }
        params.set(key, slot)
      }
      slot.count += 1
      slot.endpoints.add(endpoint)
      if (row.host) slot.hosts.add(row.host)
    }
  }

  const sharedBodies = [...bodies.values()]
    .filter((slot) => slot.refs > 1)
    .sort((a, b) => b.refs - a.refs)
    .slice(0, limit)
    .map((slot) => ({
      hash: slot.hash,
      refs: slot.refs,
      size: slot.size,
      distinctUrls: slot.urls.size,
      sampleUrls: [...slot.urls].slice(0, 5),
      endpoints: [...slot.endpoints].slice(0, 5),
      samples: slot.seqs
    }))

  const redirectChains = [...chains.values()]
    .filter((chain) => chain.length > 1)
    .sort((a, b) => b.length - a.length)
    .slice(0, limit)
    .map((chain) => ({
      requestId: chain[0].request_id,
      hops: chain.length,
      steps: chain.map((row) => ({ seq: row.seq, method: row.method, url: row.url, status: row.status }))
    }))

  const domainLinks = []
  for (const [frameHost, byHost] of links) {
    for (const [host, count] of byHost) domainLinks.push({ frameHost, host, count })
  }
  domainLinks.sort((a, b) => b.count - a.count)

  const sharedParams = [...params.values()]
    .filter((slot) => slot.endpoints.size >= 2 || slot.hosts.size >= 2)
    .sort((a, b) => b.endpoints.size - a.endpoints.size || b.count - a.count)
    .slice(0, limit)
    .map((slot) => ({
      name: slot.name,
      value: slot.value,
      count: slot.count,
      endpoints: [...slot.endpoints].slice(0, 5),
      endpointCount: slot.endpoints.size,
      hosts: [...slot.hosts],
      crossHost: slot.hosts.size > 1
    }))

  return {
    sharedBodies,
    redirectChains,
    domainLinks: domainLinks.slice(0, limit),
    sharedParams,
    scanned: scan.rows.length,
    total: scan.total,
    truncated: scan.truncated
  }
}

/* ================================================================= 导出 */

function exportDir() {
  const base = dbFilePath && dbFilePath !== ':memory:' ? dirname(dbFilePath) : '.'
  const dir = join(base, EXPORT_DIR_NAME)
  mkdirSync(dir, { recursive: true })
  return dir
}

function stampText() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function harHeaders(rawJson) {
  if (!rawJson) return []
  let parsed
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    return []
  }
  const out = []
  for (const [name, value] of Object.entries(parsed || {})) {
    // HAR 不允许伪头（:method / :authority），DevTools 打开时会直接报错
    if (name.startsWith(':')) continue
    if (Array.isArray(value)) for (const one of value) out.push({ name, value: String(one) })
    else out.push({ name, value: String(value) })
  }
  return out
}

function headerValue(rawJson, wanted) {
  for (const header of harHeaders(rawJson)) {
    if (header.name.toLowerCase() === wanted) return header.value
  }
  return null
}

function isTextMime(mime) {
  const text = String(mime || '').toLowerCase()
  if (text.startsWith('text/')) return true
  return (
    text.includes('json') ||
    text.includes('javascript') ||
    text.includes('xml') ||
    text.includes('urlencoded') ||
    text.includes('graphql') ||
    text.includes('+json')
  )
}

function harTimings(row) {
  const wait = typeof row.ttfb_ms === 'number' ? row.ttfb_ms : -1
  const receive = typeof row.duration_ms === 'number' && typeof row.ttfb_ms === 'number'
    ? Math.max(0, row.duration_ms - row.ttfb_ms)
    : -1
  const dns = typeof row.net_dns_ms === 'number' ? row.net_dns_ms : -1
  const tcp = typeof row.net_connect_ms === 'number' ? row.net_connect_ms : -1
  const tls = typeof row.net_tls_ms === 'number' ? row.net_tls_ms : -1
  return {
    blocked: -1,
    dns,
    // HAR 约定 connect 是「建连总耗时」，含 TLS；ssl 单独再报一次
    connect: tcp < 0 && tls < 0 ? -1 : Math.max(0, (tcp < 0 ? 0 : tcp) + (tls < 0 ? 0 : tls)),
    ssl: tls,
    send: 0,
    wait,
    receive
  }
}

function harContent(row, body) {
  const content = {
    size: Number(row.decoded_len ?? row.body_size ?? 0) || 0,
    mimeType: row.mime_type || 'application/octet-stream'
  }
  if (!body) return content
  content.size = body.size
  if (isTextMime(row.mime_type)) content.text = body.bytes.toString('utf8')
  else {
    content.text = body.bytes.toString('base64')
    content.encoding = 'base64'
  }
  if (row.body_trunc) content.comment = '采集时超过单条上限，正文被截断'
  return content
}

function harPostData(row) {
  if (!row.req_body) return undefined
  const text = String(row.req_body)
  const kind = bodyFieldKind(text)
  const mimeType = kind === 'json'
    ? 'application/json'
    : kind === 'form'
      ? 'application/x-www-form-urlencoded'
      : 'text/plain'
  const post = { mimeType, text }
  if (kind === 'form') post.params = parseQueryPairs(text).map(([name, value]) => ({ name, value }))
  return post
}

function monitorExtra(row) {
  return {
    seq: row.seq,
    inst: row.inst,
    targetType: row.target_type ?? null,
    frameUrl: row.frame_url ?? null,
    initiatorType: row.initiator_type ?? null,
    fromCache: Boolean(row.from_cache),
    fromSw: Boolean(row.from_sw),
    canceled: Boolean(row.canceled),
    bodyState: row.body_state ?? null,
    mergeState: row.merge_state ?? null,
    proxyFlowId: row.proxy_flow_id ?? null,
    tlsVersion: row.tls_version ?? null,
    upstreamIp: row.upstream_ip ?? null,
    failed: row.failed ?? null
  }
}

function exportHar(args) {
  const inst = norm(args.inst)
  const scan = scanRequests(inst, args.filter, EXPORT_SCAN_COLUMNS, args.maxRows)
  const includeBodies = args.includeBodies !== false
  const pages = new Map()
  const entries = []
  let bodyMissing = 0

  for (const row of scan.rows) {
    const pageUrl = row.frame_url || row.url || '(unknown)'
    if (!pages.has(pageUrl)) pages.set(pageUrl, { id: 'page_' + (pages.size + 1), url: pageUrl, firstTs: row.start_ts })
    const page = pages.get(pageUrl)
    if (typeof row.start_ts === 'number' && row.start_ts < page.firstTs) page.firstTs = row.start_ts

    const body = includeBodies && row.body_hash ? readBodyBytes(row.body_hash) : null
    if (includeBodies && row.body_hash && !body) bodyMissing += 1

    const request = {
      method: String(row.method || 'GET'),
      url: row.url,
      httpVersion: row.protocol || 'HTTP/1.1',
      cookies: [],
      headers: harHeaders(row.req_headers),
      queryString: parseQueryPairs(row.query).map(([name, value]) => ({ name, value })),
      headersSize: -1,
      bodySize: row.req_body ? String(row.req_body).length : 0
    }
    const postData = harPostData(row)
    if (postData) request.postData = postData

    const response = {
      status: Number(row.status ?? 0),
      statusText: row.status_text || '',
      httpVersion: row.protocol || 'HTTP/1.1',
      cookies: [],
      headers: harHeaders(row.resp_headers),
      content: harContent(row, body),
      redirectURL: headerValue(row.resp_headers, 'location') || '',
      headersSize: -1,
      bodySize: typeof row.encoded_len === 'number' ? row.encoded_len : -1
    }

    entries.push({
      pageref: page.id,
      startedDateTime: new Date(Number(row.start_ts) || Date.now()).toISOString(),
      time: Math.max(0, Number(row.duration_ms) || 0),
      request,
      response,
      cache: {},
      timings: harTimings(row),
      serverIPAddress: row.upstream_ip || row.remote_ip || undefined,
      connection: row.remote_port === null || row.remote_port === undefined ? undefined : String(row.remote_port),
      _resourceType: row.resource_type ?? undefined,
      _monitor: monitorExtra(row)
    })
  }

  const har = {
    log: {
      version: '1.2',
      creator: EXPORT_CREATOR,
      pages: [...pages.values()].map((page) => ({
        id: page.id,
        startedDateTime: new Date(Number(page.firstTs) || Date.now()).toISOString(),
        title: page.url,
        pageTimings: {}
      })),
      entries
    }
  }

  const text = JSON.stringify(har)
  const file = join(exportDir(), 'har-inst' + (inst ?? 0) + '-' + stampText() + '.har')
  writeFileSync(file, text, 'utf8')
  return {
    path: file,
    bytes: Buffer.byteLength(text),
    entries: entries.length,
    pages: pages.size,
    bodyMissing,
    scanned: scan.rows.length,
    total: scan.total,
    truncated: scan.truncated,
    sample: entries.slice(0, 2).map((entry) => ({ url: entry.request.url, status: entry.response.status, resourceType: entry._resourceType }))
  }
}

/** JSONL：一行一条，带完整 body。给 agent 做批量分析用（HAR 的嵌套结构不好流式读） */
function exportJsonl(args) {
  const inst = norm(args.inst)
  const scan = scanRequests(inst, args.filter, EXPORT_SCAN_COLUMNS, args.maxRows)
  const includeBodies = args.includeBodies !== false
  const lines = []
  let bodyMissing = 0
  for (const row of scan.rows) {
    const record = {
      seq: row.seq,
      inst: row.inst,
      ts: row.start_ts,
      endTs: row.end_ts,
      method: row.method,
      url: row.url,
      host: row.host,
      status: row.status,
      statusText: row.status_text,
      mimeType: row.mime_type,
      resourceType: row.resource_type,
      targetType: row.target_type,
      frameUrl: row.frame_url,
      initiatorType: row.initiator_type,
      durationMs: row.duration_ms,
      ttfbMs: row.ttfb_ms,
      requestBytes: row.encoded_len,
      responseBytes: row.decoded_len,
      fromCache: Boolean(row.from_cache),
      fromSw: Boolean(row.from_sw),
      failed: row.failed ?? null,
      requestHeaders: harHeaders(row.req_headers),
      responseHeaders: harHeaders(row.resp_headers),
      requestBody: row.req_body ?? null
    }
    if (includeBodies && row.body_hash) {
      const body = readBodyBytes(row.body_hash)
      if (!body) bodyMissing += 1
      else if (isTextMime(row.mime_type)) record.responseBody = body.bytes.toString('utf8')
      else {
        record.responseBody = body.bytes.toString('base64')
        record.responseBodyEncoding = 'base64'
      }
    }
    lines.push(JSON.stringify(record))
  }
  const text = lines.join('\n') + (lines.length ? '\n' : '')
  const file = join(exportDir(), 'requests-inst' + (inst ?? 0) + '-' + stampText() + '.jsonl')
  writeFileSync(file, text, 'utf8')
  return {
    path: file,
    bytes: Buffer.byteLength(text),
    lines: lines.length,
    bodyMissing,
    scanned: scan.rows.length,
    total: scan.total,
    truncated: scan.truncated
  }
}

/** 资源分类：离线镜像时按类型分目录，比全堆一起好找 */
function resourceBucket(resourceType, mimeType) {
  const type = String(resourceType || '').toLowerCase()
  const known = ['document', 'stylesheet', 'script', 'image', 'font', 'media', 'xhr', 'fetch', 'websocket', 'manifest']
  if (known.includes(type)) return type
  const mime = String(mimeType || '').toLowerCase()
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('font/') || mime.includes('woff')) return 'font'
  if (mime.startsWith('audio/') || mime.startsWith('video/')) return 'media'
  if (mime.startsWith('text/css')) return 'stylesheet'
  if (mime.includes('javascript')) return 'script'
  if (mime.startsWith('text/html')) return 'document'
  if (mime.includes('json')) return 'json'
  return 'other'
}

function safeName(text, max = 80) {
  const cleaned = String(text).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
  return (cleaned || 'file').slice(0, max)
}

const MIME_EXT = {
  'text/html': 'html',
  'text/css': 'css',
  'application/javascript': 'js',
  'text/javascript': 'js',
  'application/json': 'json',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'font/woff2': 'woff2',
  'font/woff': 'woff',
  'application/octet-stream': 'bin'
}

function bodyFileName(url, hash, mimeType) {
  let base = 'resource'
  try {
    const pathname = new URL(url).pathname
    const last = pathname.split('/').filter(Boolean).pop()
    if (last) base = safeName(last)
  } catch {
    base = safeName(String(url).slice(0, 60))
  }
  const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(base)
  if (!hasExt) {
    const ext = MIME_EXT[String(mimeType || '').toLowerCase().split(';')[0].trim()] ?? 'bin'
    base = base + '.' + ext
  }
  // 同 URL 不同内容（版本更新）靠 hash 前缀区分，重复内容天然同名
  return String(hash || 'nohash').slice(0, 8) + '-' + base
}

/**
 * 资源采集 / 离线镜像：把匹配到的响应体落成目录里的真文件 + 一份 manifest。
 * 为什么要 manifest：文件系统里的东西一旦离开这张表就没法回溯「它是哪次请求来的」。
 */
function exportBodies(args) {
  const inst = norm(args.inst)
  const scan = scanRequests(inst, args.filter, EXPORT_SCAN_COLUMNS, args.maxRows)
  const dir = args.dir ? String(args.dir) : join(exportDir(), 'resources-inst' + (inst ?? 0) + '-' + stampText())
  mkdirSync(dir, { recursive: true })
  const manifest = []
  const written = new Map()
  let bytes = 0
  let skipped = 0

  for (const row of scan.rows) {
    if (!row.body_hash) {
      skipped += 1
      continue
    }
    let entry = written.get(row.body_hash)
    if (!entry) {
      const body = readBodyBytes(row.body_hash)
      if (!body) {
        skipped += 1
        continue
      }
      const bucket = resourceBucket(row.resource_type, row.mime_type)
      const bucketDir = join(dir, bucket)
      mkdirSync(bucketDir, { recursive: true })
      const relative = bucket + '/' + bodyFileName(row.url, row.body_hash, row.mime_type)
      writeFileSync(join(dir, relative), body.bytes)
      bytes += body.bytes.byteLength
      entry = { file: relative, bytes: body.bytes.byteLength, hash: row.body_hash, refs: 0, urls: [] }
      written.set(row.body_hash, entry)
      manifest.push({ ...entry, mimeType: row.mime_type, resourceType: row.resource_type, urls: [] })
    }
    const seen = manifest.find((item) => item.hash === row.body_hash)
    if (seen) {
      if (seen.urls.length < 5) seen.urls.push(row.url)
      seen.refs += 1
    }
  }

  const summary = {
    inst,
    createdAt: Date.now(),
    dir,
    files: written.size,
    bytes,
    skipped,
    entries: manifest,
    total: scan.total,
    truncated: scan.truncated
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(summary, null, 2), 'utf8')
  return { dir, manifest: join(dir, 'manifest.json'), files: written.size, bytes, skipped, total: scan.total, truncated: scan.truncated }
}

/* ======================================================== 契约快照与回归 */

/** key 形如 "GET api.example.com/api/user/{int}"。这里拆回三元组 */
function splitEndpointKey(key) {
  const text = String(key || '')
  const space = text.indexOf(' ')
  const method = space === -1 ? text : text.slice(0, space)
  const rest = space === -1 ? '' : text.slice(space + 1)
  const slash = rest.indexOf('/')
  return {
    method,
    host: slash === -1 ? rest : rest.slice(0, slash),
    template: slash === -1 ? '/' : rest.slice(slash)
  }
}

function buildContract(inst, filter, maxRows, sampleLimit) {
  const scan = scanRequests(inst, filter, ENDPOINT_SCAN_COLUMNS, maxRows)
  const slots = buildEndpointSlots(scan.rows)
  const rowsByKey = new Map()
  for (const row of scan.rows) {
    const key = endpointKeyOf(row.method, row.host, templatePath(row.path))
    let list = rowsByKey.get(key)
    if (!list) {
      list = []
      rowsByKey.set(key, list)
    }
    list.push(row)
  }
  const endpoints = []
  for (const slot of slots.values()) {
    const profile = finalizeEndpointSlot(slot)
    const info = splitEndpointKey(slot.key)
    const rows = rowsByKey.get(slot.key) ?? []
    const response = sampleResponseSchema(rows, sampleLimit)
    endpoints.push({
      key: slot.key,
      method: info.method,
      host: info.host,
      template: info.template,
      calls: profile.calls,
      statuses: profile.statuses.map((item) => item.key).sort(),
      statusCounts: profile.statuses,
      mimeTypes: profile.mimeTypes.map((item) => item.key).sort(),
      resourceTypes: profile.resourceTypes.map((item) => item.key).sort(),
      query: profile.query,
      requestBody: profile.requestBody,
      responseSchema: response.schema,
      responseSchemaSamples: response.samples,
      durationMs: profile.durationMs,
      firstTs: profile.firstTs,
      lastTs: profile.lastTs
    })
  }
  endpoints.sort((a, b) => a.key.localeCompare(b.key))
  return { inst, createdAt: Date.now(), calls: scan.rows.length, truncated: scan.truncated, endpoints }
}

function loadContract(id) {
  const row = db.prepare('SELECT id, label, inst, created_at, json FROM contracts WHERE id = ?').get(norm(id))
  if (!row) return null
  try {
    return { ...JSON.parse(row.json), id: row.id, label: row.label, inst: row.inst, createdAt: row.created_at }
  } catch {
    return { id: row.id, label: row.label, inst: row.inst, createdAt: row.created_at, endpoints: [], broken: true }
  }
}

/** 参数/字段表比对：看的是「名字出现/消失」和「必填性翻转」 */
function diffFields(before, after) {
  const beforeMap = new Map((before || []).map((item) => [item.name, item]))
  const afterMap = new Map((after || []).map((item) => [item.name, item]))
  const added = (after || [])
    .filter((item) => !beforeMap.has(item.name))
    .map((item) => ({ name: item.name, required: Boolean(item.required), samples: item.values ?? [] }))
  const removed = (before || []).filter((item) => !afterMap.has(item.name)).map((item) => ({ name: item.name }))
  const requiredChanged = []
  for (const [name, item] of afterMap) {
    const oldOne = beforeMap.get(name)
    if (!oldOne) continue
    if (Boolean(oldOne.required) !== Boolean(item.required)) {
      requiredChanged.push({ name, from: Boolean(oldOne.required), to: Boolean(item.required) })
    }
  }
  return { added, removed, requiredChanged }
}

function diffContracts(base, current) {
  const before = new Map(base.endpoints.map((item) => [item.key, item]))
  const after = new Map(current.endpoints.map((item) => [item.key, item]))
  const added = []
  const removed = []
  const changed = []

  for (const [key, item] of after) {
    if (!before.has(key)) added.push({ key, calls: item.calls, statuses: item.statuses, mimeTypes: item.mimeTypes })
  }
  for (const [key, item] of before) {
    if (!after.has(key)) removed.push({ key, calls: item.calls, statuses: item.statuses, mimeTypes: item.mimeTypes })
  }
  for (const [key, oldOne] of before) {
    const newOne = after.get(key)
    if (!newOne) continue
    const statuses = {
      added: newOne.statuses.filter((item) => !oldOne.statuses.includes(item)),
      removed: oldOne.statuses.filter((item) => !newOne.statuses.includes(item))
    }
    const mimeTypes = {
      added: newOne.mimeTypes.filter((item) => !oldOne.mimeTypes.includes(item)),
      removed: oldOne.mimeTypes.filter((item) => !newOne.mimeTypes.includes(item))
    }
    const query = diffFields(oldOne.query, newOne.query)
    const requestFields = diffFields(oldOne.requestBody?.fields, newOne.requestBody?.fields)
    const response = diffSchema(oldOne.responseSchema, newOne.responseSchema)
    const meaningful =
      statuses.added.length > 0 || statuses.removed.length > 0 ||
      mimeTypes.added.length > 0 || mimeTypes.removed.length > 0 ||
      query.added.length > 0 || query.removed.length > 0 || query.requiredChanged.length > 0 ||
      requestFields.added.length > 0 || requestFields.removed.length > 0 || requestFields.requiredChanged.length > 0 ||
      response.added.length > 0 || response.removed.length > 0 || response.typeChanged.length > 0
    if (meaningful) {
      changed.push({
        key,
        statuses,
        mimeTypes,
        query,
        requestFields,
        response,
        callsBefore: oldOne.calls,
        callsAfter: newOne.calls
      })
    }
  }

  const changedKeys = new Set(changed.map((item) => item.key))
  return {
    base: { id: base.id ?? null, label: base.label ?? null, createdAt: base.createdAt, endpoints: base.endpoints.length },
    current: { createdAt: current.createdAt, endpoints: current.endpoints.length, calls: current.calls },
    added,
    removed,
    changed,
    summary: {
      addedEndpoints: added.length,
      removedEndpoints: removed.length,
      changedEndpoints: changed.length,
      unchangedEndpoints: [...after.keys()].filter((key) => before.has(key) && !changedKeys.has(key)).length,
      newStatusCodes: [...new Set(changed.flatMap((item) => item.statuses.added))].sort(),
      droppedStatusCodes: [...new Set(changed.flatMap((item) => item.statuses.removed))].sort(),
      newResponseFields: [...new Set(changed.flatMap((item) => item.response.added.map((one) => item.key + ' ' + one.path)))],
      droppedResponseFields: [...new Set(changed.flatMap((item) => item.response.removed.map((one) => item.key + ' ' + one.path)))],
      newRequestFields: [...new Set(changed.flatMap((item) => item.requestFields.added.map((one) => item.key + ' ' + one.name)))],
      newQueryParams: [...new Set(changed.flatMap((item) => item.query.added.map((one) => item.key + ' ' + one.name)))]
    }
  }
}

function contractSnapshot(args) {
  const inst = norm(args.inst)
  const label = String(args.label ?? '') || new Date().toISOString()
  const built = buildContract(inst, args.filter, args.maxRows ?? ANALYZE_ROWS_MAX, clampInt(args.sampleLimit, 3, 1, 20))
  const info = db
    .prepare('INSERT INTO contracts (label, inst, created_at, json) VALUES (?, ?, ?, ?)')
    .run(label, inst, built.createdAt, JSON.stringify(built))
  return {
    id: Number(info.lastInsertRowid),
    label,
    inst,
    createdAt: built.createdAt,
    endpoints: built.endpoints.length,
    calls: built.calls,
    truncated: built.truncated
  }
}

function contractList(args) {
  return {
    rows: db
      .prepare('SELECT id, label, inst, created_at AS createdAt, LENGTH(json) AS bytes FROM contracts ORDER BY id DESC LIMIT ?')
      .all(clampInt(args.limit, 50, 1, 500))
  }
}

function contractGet(args) {
  const contract = loadContract(args.id)
  if (!contract) return { found: false, id: norm(args.id) }
  if (args.withSchema === false) {
    return {
      found: true,
      id: contract.id,
      label: contract.label,
      inst: contract.inst,
      createdAt: contract.createdAt,
      endpoints: contract.endpoints.map((item) => ({ key: item.key, calls: item.calls, statuses: item.statuses }))
    }
  }
  return { found: true, ...contract }
}

function contractDelete(args) {
  const info = db.prepare('DELETE FROM contracts WHERE id = ?').run(norm(args.id))
  return { deleted: Number(info.changes) || 0 }
}

function contractDiff(args) {
  const base = loadContract(args.baseId ?? args.id)
  if (!base) return { error: '没有这个契约快照：' + String(args.baseId ?? args.id) }
  const current = buildContract(norm(args.inst), args.filter, args.maxRows ?? ANALYZE_ROWS_MAX, clampInt(args.sampleLimit, 3, 1, 20))
  return diffContracts(base, current)
}
