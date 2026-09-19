#!/usr/bin/env node
/**
 * 监控容器 · 存储进程
 *
 * 为什么是独立进程，而不是塞进 Electron 主进程：
 *   1) better-sqlite3 v13 的 prebuild 在 Electron 33 里 require 那一瞬间就硬崩
 *      （实测进程 exit -36861，连异常都抛不出来），N-API 也救不了；
 *      而系统 Node 22 自带的 node:sqlite 稳定可用、零编译、零依赖。
 *   2) 设计文档 §5.2 的硬性要求：绝不在 CDP 事件回调里做同步 IO。
 *      落盘天然应该在进程外，顺带把吞吐问题一起解决。
 *   3) 可以脱离 Electron 单独测试和压测。
 *
 * 协议：stdin/stdout 上的 NDJSON。
 *   请求  {"id":1,"op":"queryRequests","args":{...}}
 *   应答  {"id":1,"ok":true,"result":{...}} / {"id":1,"ok":false,"error":"..."}
 * 二进制不走 JSON：body 用 base64 过线，落库时解码成 BLOB。
 */

import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

// node:sqlite 在 22.x 仍标记 experimental，会往 stderr 吐警告。
// stderr 是日志通道，别让它被警告淹没。
process.removeAllListeners('warning')
process.on('warning', () => {})

const SCHEMA_VERSION = 6

const config = {
  /** 单条 body 落盘上限，超过只留 hash + size */
  bodyMaxBytes: 256 * 1024,
  /** bodies 表里 blob 的总预算，超了按 LRU 淘汰 */
  bodyStoreMaxBytes: 512 * 1024 * 1024,
  /** bodyStoreMaxBytes 之外的第二道闸：条数上限 */
  bodyStoreMaxCount: 50000,
  /** 关掉就完全不落 body，只要元数据 */
  storeBodies: true,
  /** 单个脚本源码落盘上限，超了只留元数据（url/size/hash） */
  scriptMaxBytes: 2 * 1024 * 1024
}

let db = null
/** 库文件路径。storageSummary 要报磁盘占用，得留着它 */
let dbFilePath = null
let S = null

/**
 * P5 代理侧列（列名 → 声明）。建表和迁移共用一份，免得漏了某一列 ——
 * 漏列的表现是「界面有字段、库里没有」，而且只在老库上出现。
 */
const PROXY_COLUMNS = [
  ['merge_state', 'TEXT'],
  ['proxy_flow_id', 'TEXT'],
  ['net_dns_ms', 'REAL'],
  ['net_connect_ms', 'REAL'],
  ['net_tls_ms', 'REAL'],
  ['net_download_ms', 'REAL'],
  ['upstream_ip', 'TEXT'],
  ['tls_version', 'TEXT'],
  ['tls_cipher', 'TEXT'],
  ['upstream_alpn', 'TEXT'],
  ['proxy_delta_ms', 'REAL'],
  ['merge_ambiguous', 'INTEGER DEFAULT 0'],
  ['proxy_open', 'INTEGER DEFAULT 0']
]

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  url TEXT,
  profile TEXT,
  kernel TEXT,
  kernel_version TEXT,
  user_agent TEXT,
  args TEXT
);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inst INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  key TEXT NOT NULL,
  request_id TEXT NOT NULL,
  session_id TEXT,
  target_id TEXT,
  target_type TEXT,
  frame_url TEXT,
  url TEXT NOT NULL,
  host TEXT,
  scheme TEXT,
  path TEXT,
  query TEXT,
  method TEXT NOT NULL,
  resource_type TEXT,
  initiator_type TEXT,
  /* InitiatorInfo 的 JSON（§7.1 #2 发起链）。列表查询不带它，只有详情 SELECT * 才给 */
  initiator_stack TEXT,
  priority TEXT,
  status INTEGER,
  status_text TEXT,
  mime_type TEXT,
  protocol TEXT,
  remote_ip TEXT,
  remote_port INTEGER,
  req_headers TEXT,
  resp_headers TEXT,
  req_body TEXT,
  encoded_len INTEGER,
  decoded_len INTEGER,
  from_cache INTEGER DEFAULT 0,
  from_sw INTEGER DEFAULT 0,
  ttfb_ms REAL,
  duration_ms REAL,
  start_ts REAL NOT NULL,
  end_ts REAL,
  failed TEXT,
  canceled INTEGER DEFAULT 0,
  body_state TEXT DEFAULT 'none',
  body_size INTEGER,
  body_hash TEXT,
  body_trunc INTEGER DEFAULT 0,
  /* ---------------------------------------------------------------- P5 代理侧
   * merge_state / proxy_flow_id 说明这条记录的代理那一半是怎么来的：
   *   merged=两边都有、cdp-only=代理没看到、proxy-only=CDP 没看到（采集盲区）
   * 其余是代理补充的、CDP 给不了的东西（§5.1）：DNS/connect/TLS 分段、
   * 上游 IP、TLS 版本与套件、ALPN。列清单见 PROXY_COLUMNS。
   */
  ${PROXY_COLUMNS.map(([column, decl]) => column + ' ' + decl).join(',\n  ')},
  UNIQUE (inst, seq)
);

CREATE INDEX IF NOT EXISTS ix_req_inst_ts   ON requests (inst, start_ts);
CREATE INDEX IF NOT EXISTS ix_req_url       ON requests (url);
CREATE INDEX IF NOT EXISTS ix_req_host      ON requests (host);
CREATE INDEX IF NOT EXISTS ix_req_status    ON requests (status);
CREATE INDEX IF NOT EXISTS ix_req_mime      ON requests (mime_type);
CREATE INDEX IF NOT EXISTS ix_req_type      ON requests (resource_type);
CREATE INDEX IF NOT EXISTS ix_req_bodyhash  ON requests (body_hash);
CREATE INDEX IF NOT EXISTS ix_req_key       ON requests (inst, key);

CREATE TABLE IF NOT EXISTS bodies (
  hash TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  stored INTEGER NOT NULL DEFAULT 0,
  trunc INTEGER NOT NULL DEFAULT 0,
  blob BLOB,
  first_seen INTEGER NOT NULL,
  last_ref INTEGER NOT NULL,
  ref_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS ix_bodies_lru ON bodies (stored, last_ref);

CREATE TABLE IF NOT EXISTS scripts (
  hash TEXT PRIMARY KEY,
  script_id TEXT,
  url TEXT,
  size INTEGER,
  source TEXT,
  inst INTEGER,
  -- 内联脚本的 url 是文档 URL，靠起始行才能把它和外部脚本分开
  start_line INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS ix_scripts_url ON scripts (url);

-- scripts 按内容 hash 全局去重（同一个 bundle 在多次会话里复用同一行），
-- 「本次会话加载了哪些脚本」由这张引用表表达，否则按 inst 过滤是错的。
CREATE TABLE IF NOT EXISTS script_refs (
  inst INTEGER NOT NULL,
  hash TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (inst, hash)
);

CREATE INDEX IF NOT EXISTS ix_script_refs_inst ON script_refs (inst, first_seen);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inst INTEGER NOT NULL,
  ts REAL NOT NULL,
  kind TEXT NOT NULL,
  target_type TEXT,
  url TEXT,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS ix_events_inst_ts ON events (inst, ts);
`

const REQUEST_COLUMNS = [
  'inst', 'seq', 'key', 'request_id', 'session_id', 'target_id', 'target_type',
  'frame_url', 'url', 'host', 'scheme', 'path', 'query', 'method', 'resource_type',
  'initiator_type', 'initiator_stack', 'priority', 'status', 'status_text', 'mime_type', 'protocol',
  'remote_ip', 'remote_port', 'req_headers', 'resp_headers', 'req_body',
  'encoded_len', 'decoded_len', 'from_cache', 'from_sw', 'ttfb_ms', 'duration_ms',
  'start_ts', 'end_ts', 'failed', 'canceled',
  ...PROXY_COLUMNS.map(([column]) => column)
]
/**
 * 冲突时要更新的列 —— 只放「结果类」字段。
 *
 * 同一条请求会写两次：采集侧先落一条「响应头到了但还没跑完」的临时行
 * （否则永远等不到终态事件的请求在整个会话里都不可见），终态事件到了再写一次。
 * body_* 列故意留在外面：它们归 setRequestBodies 管，跟着这次写会把已经
 * 采到的 body 抹成 NULL。
 */
const REQUEST_RESULT_COLUMNS = [
  'status', 'status_text', 'mime_type', 'protocol', 'remote_ip', 'remote_port',
  'encoded_len', 'decoded_len', 'from_cache', 'from_sw', 'ttfb_ms', 'duration_ms',
  'end_ts', 'failed', 'canceled',
  // 代理侧字段也要跟着终态行更新：晚配（长连接）就是靠这次 upsert 把字段补上去的
  ...PROXY_COLUMNS.map(([column]) => column)
]

// 不用 INSERT OR IGNORE：那样 NOT NULL 之类的约束冲突是静默吞掉的
// （曾经把整个 requests 表写空过而界面毫无异常）。改成 upsert，
// 约束冲突会真的抛出来，由调用方按队列重试/上报。
const INSERT_REQUEST_SQL =
  'INSERT INTO requests (' + REQUEST_COLUMNS.join(',') + ') VALUES (' +
  REQUEST_COLUMNS.map(() => '?').join(',') + ') ' +
  'ON CONFLICT(inst, seq) DO UPDATE SET ' +
  REQUEST_RESULT_COLUMNS.map((column) => column + ' = excluded.' + column).join(', ')

function norm(v) {
  if (v === undefined || v === null) return null
  const t = typeof v
  if (t === 'boolean') return v ? 1 : 0
  if (t === 'number') return Number.isFinite(v) ? v : null
  if (t === 'bigint' || t === 'string') return v
  if (t === 'object') return JSON.stringify(v)
  return String(v)
}

function openDatabase(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
  const handle = new DatabaseSync(dbPath)
  handle.exec('PRAGMA journal_mode = WAL')
  handle.exec('PRAGMA synchronous = NORMAL')
  handle.exec('PRAGMA temp_store = MEMORY')
  handle.exec('PRAGMA cache_size = -32000')
  handle.exec(DDL)
  // CREATE TABLE IF NOT EXISTS 不会给已存在的表补列，加列必须显式迁移
  ensureColumn(handle, 'scripts', 'start_line', 'INTEGER NOT NULL DEFAULT 0')
  // §7.1 #2 的发起链：老库的 requests 表没有这一列
  ensureColumn(handle, 'requests', 'initiator_stack', 'TEXT')
  // P5：老库没有代理那几列。CREATE TABLE IF NOT EXISTS 不会补列，必须显式迁移
  for (const [column, decl] of PROXY_COLUMNS) ensureColumn(handle, 'requests', column, decl)
  handle
    .prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run('schema_version', String(SCHEMA_VERSION))
  return handle
}

function ensureColumn(handle, table, column, declaration) {
  const columns = handle.prepare('PRAGMA table_info(' + table + ')').all()
  if (columns.some((row) => row.name === column)) return
  handle.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + declaration)
}

function buildStatements() {
  return {
    insertRequest: db.prepare(INSERT_REQUEST_SQL),
    countInstRequests: db.prepare('SELECT COUNT(*) AS c FROM requests WHERE inst = ?'),
    setBody: db.prepare(
      'UPDATE requests SET body_state = ?, body_size = ?, body_hash = ?, body_trunc = ? ' +
        'WHERE inst = ? AND seq = ?'
    ),
    upsertBodyNew: db.prepare(
      'INSERT INTO bodies (hash, size, stored, trunc, blob, first_seen, last_ref, ref_count) ' +
        'VALUES (?, ?, 1, ?, ?, ?, ?, 1) ' +
        'ON CONFLICT(hash) DO UPDATE SET ref_count = ref_count + 1, last_ref = excluded.last_ref'
    ),
    upsertBodyRef: db.prepare(
      'INSERT INTO bodies (hash, size, stored, trunc, blob, first_seen, last_ref, ref_count) ' +
        'VALUES (?, ?, 0, ?, NULL, ?, ?, 1) ' +
        'ON CONFLICT(hash) DO UPDATE SET ref_count = ref_count + 1, last_ref = excluded.last_ref'
    ),
    getBody: db.prepare('SELECT hash, size, stored, trunc, blob FROM bodies WHERE hash = ?'),
    touchBodyBatch: null,
    insertScript: db.prepare(
      'INSERT INTO scripts (hash, script_id, url, size, source, inst, start_line, first_seen, seen_count) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1) ' +
        'ON CONFLICT(hash) DO UPDATE SET ' +
        '  seen_count = seen_count + 1, ' +
        '  script_id = COALESCE(scripts.script_id, excluded.script_id), ' +
        // 先到的可能只有元数据（超限 / 拉取失败），之后拿到源码要能补上
        '  source = COALESCE(scripts.source, excluded.source)'
    ),
    getScript: db.prepare('SELECT * FROM scripts WHERE hash = ?'),
    refScript: db.prepare(
      'INSERT INTO script_refs (inst, hash, first_seen, seen_count) VALUES (?, ?, ?, 1) ' +
        'ON CONFLICT(inst, hash) DO UPDATE SET seen_count = seen_count + 1'
    ),
    insertEvent: db.prepare(
      'INSERT INTO events (inst, ts, kind, target_type, url, detail) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    bodyBudget: db.prepare(
      'SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM bodies WHERE stored = 1'
    ),
    oldestBodies: db.prepare(
      'SELECT hash, size FROM bodies WHERE stored = 1 ORDER BY last_ref ASC LIMIT ?'
    ),
    dropBlob: db.prepare('UPDATE bodies SET stored = 0, blob = NULL WHERE hash = ?'),
    flush: db.prepare('PRAGMA wal_checkpoint(PASSIVE)')
  }
}

const FILTER_EQ = {
  host: 'host',
  method: 'method',
  scheme: 'scheme',
  targetType: 'target_type',
  resourceType: 'resource_type',
  mimeType: 'mime_type',
  status: 'status',
  initiatorType: 'initiator_type',
  bodyState: 'body_state',
  frameUrl: 'frame_url'
}

/** 只允许白名单列参与构造，避免把渲染进程的输入直接拼进 SQL */
function buildWhere(filter, extraClauses) {
  const clauses = []
  const params = []
  const f = filter || {}

  if (f.inst !== undefined) {
    clauses.push('inst = ?')
    params.push(f.inst)
  }
  if (f.search) {
    clauses.push('(url LIKE ? OR host LIKE ? OR frame_url LIKE ?)')
    const like = '%' + f.search + '%'
    params.push(like, like, like)
  }
  if (f.url) {
    clauses.push('url LIKE ?')
    params.push('%' + f.url + '%')
  }
  if (f.path) {
    clauses.push('path LIKE ?')
    params.push('%' + f.path + '%')
  }
  for (const [key, column] of Object.entries(FILTER_EQ)) {
    const value = f[key]
    if (value === undefined || value === null || value === '' || value === 'all') continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      clauses.push(column + ' IN (' + value.map(() => '?').join(',') + ')')
      params.push(...value.map(norm))
    } else {
      clauses.push(column + ' = ?')
      params.push(norm(value))
    }
  }
  if (f.urlIn && Array.isArray(f.urlIn) && f.urlIn.length) {
    clauses.push('url IN (' + f.urlIn.map(() => '?').join(',') + ')')
    params.push(...f.urlIn)
  }
  if (f.statusMin !== undefined) {
    clauses.push('status >= ?')
    params.push(f.statusMin)
  }
  if (f.statusMax !== undefined) {
    clauses.push('status <= ?')
    params.push(f.statusMax)
  }
  if (f.since !== undefined) {
    clauses.push('start_ts >= ?')
    params.push(f.since)
  }
  if (f.until !== undefined) {
    clauses.push('start_ts <= ?')
    params.push(f.until)
  }
  if (f.minSize !== undefined) {
    clauses.push('encoded_len >= ?')
    params.push(f.minSize)
  }
  if (f.maxSize !== undefined) {
    clauses.push('encoded_len <= ?')
    params.push(f.maxSize)
  }
  if (f.onlyFailed) clauses.push('failed IS NOT NULL')
  // 还没拿到响应的请求（进行中/被取消）—— 界面上要能单独挑出来
  if (f.onlyPending) clauses.push('status IS NULL')
  if (f.hasBody) clauses.push("body_state = 'stored'")
  if (f.fromCache !== undefined) {
    clauses.push('from_cache = ?')
    params.push(f.fromCache ? 1 : 0)
  }
  if (f.fromSw !== undefined) {
    clauses.push('from_sw = ?')
    params.push(f.fromSw ? 1 : 0)
  }
  if (f.excludeStatus && Array.isArray(f.excludeStatus) && f.excludeStatus.length) {
    clauses.push('(status IS NULL OR status NOT IN (' + f.excludeStatus.map(() => '?').join(',') + '))')
    params.push(...f.excludeStatus)
  }
  if (extraClauses && extraClauses.length) clauses.push(...extraClauses)

  return { sql: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', params }
}

const ORDER_BY = {
  time_desc: 'start_ts DESC, seq DESC',
  time_asc: 'start_ts ASC, seq ASC',
  duration_desc: 'duration_ms DESC NULLS LAST',
  size_desc: 'encoded_len DESC NULLS LAST',
  status_asc: 'status ASC NULLS LAST'
}

function queryRequests(args) {
  const f = args.filter || {}
  const where = buildWhere(f)
  const order = ORDER_BY[args.order] || ORDER_BY.time_desc
  const limit = Math.min(Math.max(args.limit ?? 500, 1), 20000)
  const offset = Math.max(args.offset ?? 0, 0)

  const total = db
    .prepare('SELECT COUNT(*) AS c FROM requests ' + where.sql)
    .get(...where.params).c

  const rows = db
    .prepare(
      'SELECT id, inst, seq, key, request_id, session_id, target_id, target_type, frame_url, ' +
        'url, host, scheme, path, query, method, resource_type, initiator_type, priority, ' +
        'status, status_text, mime_type, protocol, remote_ip, remote_port, ' +
        'encoded_len, decoded_len, from_cache, from_sw, ttfb_ms, duration_ms, ' +
        'start_ts, end_ts, failed, canceled, body_state, body_size, body_hash, body_trunc, ' +
        PROXY_COLUMNS.map(([column]) => column).join(', ') + ' ' +
        'FROM requests ' + where.sql + ' ORDER BY ' + order + ' LIMIT ? OFFSET ?'
    )
    .all(...where.params, limit, offset)

  return { total, rows }
}

function queryDetail(args) {
  const row = db
    .prepare('SELECT * FROM requests WHERE inst = ? AND seq = ?')
    .get(norm(args.inst), norm(args.seq))
  if (!row) return null
  const body = row.body_hash
    ? db.prepare('SELECT hash, size, stored, trunc FROM bodies WHERE hash = ?').get(row.body_hash)
    : null
  return { request: row, body: body || null }
}

const GROUP_COLUMNS = {
  resource_type: 'resource_type',
  status: 'status',
  host: 'host',
  mime_type: 'mime_type',
  target_type: 'target_type',
  method: 'method',
  scheme: 'scheme',
  initiator_type: 'initiator_type',
  body_state: 'body_state'
}

function stats(args) {
  const where = buildWhere({ inst: args.inst })
  const base = 'FROM requests ' + where.sql

  const totals = db
    .prepare(
      'SELECT COUNT(*) AS total, COALESCE(SUM(encoded_len), 0) AS bytes, ' +
        'COALESCE(AVG(duration_ms), 0) AS avgMs, ' +
        'SUM(CASE WHEN failed IS NOT NULL THEN 1 ELSE 0 END) AS failed, ' +
        'SUM(CASE WHEN from_cache = 1 THEN 1 ELSE 0 END) AS cached, ' +
        'SUM(CASE WHEN from_sw = 1 THEN 1 ELSE 0 END) AS sw, ' +
        'SUM(CASE WHEN body_state = ' + "'stored'" + ' THEN 1 ELSE 0 END) AS withBody ' +
        base
    )
    .get(...where.params)

  const by = {}
  for (const [key, column] of Object.entries(GROUP_COLUMNS)) {
    const grouped = buildWhere({ inst: args.inst }, [column + ' IS NOT NULL'])
    by[key] = db
      .prepare(
        'SELECT ' + column + ' AS k, COUNT(*) AS c, COALESCE(SUM(encoded_len), 0) AS bytes ' +
          'FROM requests ' +
          grouped.sql +
          ' GROUP BY ' + column + ' ORDER BY c DESC LIMIT 30'
      )
      .all(...grouped.params)
  }

  const bodies = S.bodyBudget.get()
  const pageInfo = db.prepare('PRAGMA page_count').get()
  const pageSize = db.prepare('PRAGMA page_size').get()
  const pageCount = pageInfo ? Object.values(pageInfo)[0] : 0
  const pageBytes = pageSize ? Object.values(pageSize)[0] : 0

  return {
    ...totals,
    by,
    bodies: { ...bodies, budgetBytes: config.bodyStoreMaxBytes },
    dbBytes: pageCount * pageBytes
  }
}

/** 瀑布图数据源：只要定位信息，字段尽可能窄 */
function timeline(args) {
  const where = buildWhere({ inst: args.inst, ...(args.filter || {}) })
  const limit = Math.min(Math.max(args.limit ?? 3000, 1), 50000)
  const rows = db
    .prepare(
      'SELECT seq, method, start_ts, end_ts, duration_ms, ttfb_ms, url, host, resource_type, ' +
        'status, target_type, encoded_len, failed, merge_state, proxy_delta_ms, ' +
        'net_dns_ms, net_connect_ms, net_tls_ms, net_download_ms, proxy_open FROM requests ' +
        where.sql +
        ' ORDER BY start_ts DESC LIMIT ?'
    )
    .all(...where.params, limit)
  return { rows }
}

function appendBodies(inst, items) {
  const now = Date.now()
  let stored = 0
  let referenced = 0
  let skipped = 0

  db.exec('BEGIN')
  try {
    for (const item of items) {
      const hash = item.hash
      if (!hash) continue
      const size = item.size ?? 0
      const trunc = item.trunc ? 1 : 0

      if (item.b64 === undefined || item.b64 === null) {
        // 主进程已经传过这份 payload（session 内 hash 去重命中），只加引用
        S.upsertBodyRef.run(hash, size, trunc, now, now)
        referenced += 1
        continue
      }
      if (!config.storeBodies || size > config.bodyMaxBytes) {
        S.upsertBodyRef.run(hash, size, trunc, now, now)
        skipped += 1
        continue
      }
      const buf = Buffer.from(item.b64, 'base64')
      const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.length)
      S.upsertBodyNew.run(hash, size, trunc, bytes, now, now)
      stored += 1
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  const evicted = enforceBodyBudget()
  return { stored, referenced, skipped, evicted }
}

/** LRU：先按条数，再按字节数，把最久没被引用的 blob 降级成 hash-only */
function enforceBodyBudget() {
  let evicted = 0
  const budget = S.bodyBudget.get()
  let overCount = budget.n - config.bodyStoreMaxCount
  let overBytes = budget.bytes - config.bodyStoreMaxBytes
  if (overCount <= 0 && overBytes <= 0) return 0

  const need = Math.max(overCount, 1) + (overBytes > 0 ? 64 : 0)
  const candidates = S.oldestBodies.all(Math.min(need, 5000))
  db.exec('BEGIN')
  try {
    for (const row of candidates) {
      if (overCount <= 0 && overBytes <= 0) break
      S.dropBlob.run(row.hash)
      overCount -= 1
      overBytes -= row.size
      evicted += 1
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return evicted
}

/* ------------------------------------------------------------------ 脚本 */

const SCRIPT_ORDER = {
  time_desc: 'r.first_seen DESC',
  time_asc: 'r.first_seen ASC',
  size_desc: 's.size DESC',
  url_asc: 's.url ASC'
}

/**
 * 脚本的过滤条件。列名全部白名单化后拼接 —— 渲染进程的输入不直接进 SQL。
 * 空 url 是内联脚本 / eval，不是脏数据，所以单独给一个 inline 维度。
 */
function buildScriptWhere(inst, filter) {
  const clauses = []
  const params = []
  const f = filter || {}
  if (inst !== undefined) {
    clauses.push('r.inst = ?')
    params.push(inst)
  }
  if (f.search) {
    clauses.push('COALESCE(s.url, \'\') LIKE ?')
    params.push('%' + f.search + '%')
  }
  if (f.hasSource === true) clauses.push('s.source IS NOT NULL')
  if (f.hasSource === false) clauses.push('s.source IS NULL')
  // 内联脚本的 url 是文档 URL，光看 url 判不出来；起始行才是判据
  if (f.inline === true) clauses.push('(COALESCE(s.url, \'\') = \'\' OR s.start_line > 0)')
  if (f.inline === false) clauses.push('(COALESCE(s.url, \'\') <> \'\' AND s.start_line = 0)')
  if (f.minSize) {
    clauses.push('s.size >= ?')
    params.push(f.minSize)
  }
  return { sql: clauses.length ? ' WHERE ' + clauses.join(' AND ') : '', params }
}

function queryScripts(args) {
  const where = buildScriptWhere(args.inst, args.filter)
  const order = SCRIPT_ORDER[args.order] ?? SCRIPT_ORDER.time_desc
  const limit = Math.min(Math.max(args.limit ?? 500, 1), 5000)
  const offset = Math.max(args.offset ?? 0, 0)

  const rows = db
    .prepare(
      'SELECT s.hash, s.url, s.size, s.script_id, r.first_seen, r.seen_count, ' +
        's.start_line, ' +
        '(CASE WHEN COALESCE(s.url, \'\') = \'\' OR s.start_line > 0 THEN 1 ELSE 0 END) AS is_inline, ' +
        '(s.source IS NOT NULL) AS has_source, COALESCE(LENGTH(s.source), 0) AS source_len ' +
        'FROM script_refs r JOIN scripts s ON s.hash = r.hash' +
        where.sql +
        ' ORDER BY ' +
        order +
        ' LIMIT ? OFFSET ?'
    )
    .all(...where.params, limit, offset)

  const total = db
    .prepare('SELECT COUNT(*) AS c FROM script_refs r JOIN scripts s ON s.hash = r.hash' + where.sql)
    .get(...where.params).c

  return { rows, total }
}

function scriptStats(args) {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS total, ' +
        'COALESCE(SUM(CASE WHEN s.source IS NOT NULL THEN 1 ELSE 0 END), 0) AS with_source, ' +
        'COALESCE(SUM(LENGTH(s.source)), 0) AS source_bytes, ' +
        'COALESCE(SUM(CASE WHEN COALESCE(s.url, \'\') = \'\' OR s.start_line > 0 THEN 1 ELSE 0 END), 0) AS inline_count ' +
        'FROM script_refs r JOIN scripts s ON s.hash = r.hash WHERE r.inst = ?'
    )
    .get(args.inst)

  return {
    total: row?.total ?? 0,
    withSource: row?.with_source ?? 0,
    sourceBytes: row?.source_bytes ?? 0,
    inline: row?.inline_count ?? 0
  }
}

const OPS = {
  open(args) {
    if (db) db.close()
    Object.assign(config, args.config || {})
    db = openDatabase(args.dbPath)
    dbFilePath = args.dbPath
    S = buildStatements()
    return { schemaVersion: SCHEMA_VERSION, dbPath: args.dbPath, config: { ...config } }
  },

  beginInstance(args) {
    const info = db
      .prepare(
        'INSERT INTO instances (started_at, url, profile, kernel, kernel_version, user_agent, args) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        Date.now(),
        norm(args.url),
        norm(args.profile),
        norm(args.kernel),
        norm(args.kernelVersion),
        norm(args.userAgent),
        norm(args.args)
      )
    return { instId: Number(info.lastInsertRowid) }
  },

  endInstance(args) {
    db.prepare('UPDATE instances SET ended_at = ? WHERE id = ?').run(Date.now(), norm(args.inst))
    return { ok: true }
  },

  appendRequests(args) {
    const rows = args.rows || []
    if (rows.length === 0) return { inserted: 0, updated: 0, ignored: 0 }
    const inst = args.inst
    let written = 0
    const t0 = Date.now()

    // 同一条请求会写两次（pending 行 + 终态行），所以必须把「新行」和
    // 「更新已有行」分开报 —— 界面上「已落库」说的是行数，不是写入次数。
    const before = S.countInstRequests.get(inst).c

    db.exec('BEGIN')
    try {
      for (const row of rows) {
        const values = REQUEST_COLUMNS.map((column) => {
          if (column === 'inst') return inst
          return norm(row[column])
        })
        const info = S.insertRequest.run(...values)
        written += Number(info.changes) || 0
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    const inserted = S.countInstRequests.get(inst).c - before
    return { inserted, updated: written - inserted, ignored: rows.length - written, ms: Date.now() - t0 }
  },

  appendBodies(args) {
    return appendBodies(args.inst, args.items || [])
  },

  setRequestBodies(args) {
    const items = args.items || []
    const inst = args.inst
    let updated = 0
    const missing = []
    db.exec('BEGIN')
    try {
      for (const item of items) {
        // body 可能比请求行先到（Fetch 在 Response 阶段拦，早于 Network.loadingFinished）。
        // 改不到行不算错，把 seq 报回去让主进程下轮重试。
        const info = S.setBody.run(
          norm(item.state) || 'none',
          norm(item.size),
          norm(item.hash),
          item.trunc ? 1 : 0,
          inst,
          item.seq
        )
        if (Number(info.changes) > 0) updated += 1
        else if (missing.length < 512) missing.push(item.seq)
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    return { updated, missing }
  },

  getBody(args) {
    const row = S.getBody.get(norm(args.hash))
    if (!row) return null
    const result = { hash: row.hash, size: row.size, stored: !!row.stored, trunc: !!row.trunc }
    if (args.withData && row.stored && row.blob) {
      const bytes = row.blob instanceof Uint8Array ? row.blob : new Uint8Array(row.blob)
      result.b64 = Buffer.from(bytes).toString('base64')
    }
    return result
  },

  queryRequests,
  queryDetail,

  queryScripts,
  scriptStats,

  /** 只取源码。列表查询刻意不带 source，免得一页脚本把几十 MB 拖过 IPC。 */
  getScriptSource(args) {
    const row = S.getScript.get(norm(args.hash))
    if (!row) return null
    return { hash: row.hash, url: row.url, size: row.size, source: row.source ?? null }
  },

  appendScripts(args) {
    const items = args.items || []
    let withSource = 0
    let metaOnly = 0
    db.exec('BEGIN')
    try {
      for (const item of items) {
        if (!item || !item.hash) continue
        // 超限只留元数据：监控库的落盘体积不能由页面决定
        const tooBig = typeof item.source === 'string' && item.source.length > config.scriptMaxBytes
        const source = tooBig ? null : norm(item.source)
        if (source === null) metaOnly += 1
        else withSource += 1
        S.insertScript.run(
          norm(item.hash),
          norm(item.scriptId),
          norm(item.url),
          norm(item.size),
          source,
          norm(item.inst ?? args.inst),
          norm(item.startLine) ?? 0,
          Date.now()
        )
        S.refScript.run(norm(item.inst ?? args.inst), item.hash, Date.now())
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    return { withSource, metaOnly, inserted: items.length }
  },

  appendEvents(args) {
    const items = args.items || []
    db.exec('BEGIN')
    try {
      for (const item of items) {
        S.insertEvent.run(
          args.inst,
          item.ts ?? Date.now(),
          norm(item.kind),
          norm(item.targetType),
          norm(item.url),
          norm(item.detail)
        )
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    return { inserted: items.length }
  },

  stats,
  timeline,

  listInstances() {
    return { rows: db.prepare('SELECT * FROM instances ORDER BY id DESC LIMIT 100').all() }
  },

  /** §7.1 #9 会话管理：每个实例的计数，一次查完（面板不该按实例刷 N 次库） */
  instanceStats() {
    const rows = db
      .prepare(
        'SELECT inst, COUNT(*) AS requests, ' +
          "SUM(CASE WHEN body_state = 'stored' THEN 1 ELSE 0 END) AS bodies, " +
          'MIN(start_ts) AS firstAt, MAX(start_ts) AS lastAt ' +
          'FROM requests GROUP BY inst ORDER BY inst DESC LIMIT 200'
      )
      .all()
    const byInst = new Map(
      db.prepare('SELECT inst, COUNT(*) AS scripts FROM script_refs GROUP BY inst').all().map((row) => [row.inst, row.scripts])
    )
    return { rows: rows.map((row) => ({ ...row, scripts: byInst.get(row.inst) ?? 0 })) }
  },

  /** §7.1 #9 存储分区：库文件大小、各表行数、body 去重后的总字节 */
  storageSummary() {
    const names = ['instances', 'requests', 'bodies', 'scripts', 'script_refs', 'events']
    const tables = names.map((name) => ({
      name,
      rows: db.prepare('SELECT COUNT(*) AS n FROM ' + name).get().n
    }))
    let bytes = 0
    if (dbFilePath && dbFilePath !== ':memory:') {
      try {
        bytes += statSync(dbFilePath).size
      } catch {
        /* 文件还没落盘 */
      }
      try {
        // WAL 也得算：不算的话面板显示的大小会比磁盘上实际占的小一截
        bytes += statSync(dbFilePath + '-wal').size
      } catch {
        /* 没有 WAL 文件是正常的 */
      }
    }
    const bodyBytes = db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM bodies').get().n
    return { dbPath: dbFilePath, dbBytes: bytes, tables, bodyBytes }
  },

  prune() {
    return { evicted: enforceBodyBudget() }
  },

  flush() {
    S.flush.run()
    return { ok: true }
  },

  close() {
    if (db) {
      try {
        S.flush.run()
      } catch {
        /* checkpoint 失败不影响关闭 */
      }
      db.close()
      db = null
    }
    return { ok: true }
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function handle(line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch (err) {
    send({ id: null, ok: false, error: 'JSON 解析失败: ' + err.message })
    return
  }

  const op = OPS[msg.op]
  if (!op) {
    send({ id: msg.id ?? null, ok: false, error: '未知操作: ' + msg.op })
    return
  }
  if (!db && msg.op !== 'open') {
    send({ id: msg.id ?? null, ok: false, error: '数据库未打开，先调用 open' })
    return
  }

  try {
    const result = op(msg.args || {})
    if (msg.id !== undefined) send({ id: msg.id, ok: true, result })
  } catch (err) {
    if (msg.id !== undefined) {
      send({ id: msg.id, ok: false, error: (err && err.message) || String(err) })
    }
  }
}

// 手写 NDJSON 分帧：readline 在高吞吐下会成为瓶颈
let carry = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  const text = carry + chunk
  let start = 0
  let index = text.indexOf('\n', start)
  while (index !== -1) {
    const line = text.slice(start, index)
    if (line.length > 0) {
      try {
        handle(line)
      } catch (err) {
        send({ id: null, ok: false, error: '处理失败: ' + ((err && err.message) || String(err)) })
      }
    }
    start = index + 1
    index = text.indexOf('\n', start)
  }
  carry = text.slice(start)
})

process.stdin.on('end', () => {
  if (db) {
    try {
      S.flush.run()
      db.close()
    } catch {
      /* 退出路径，忽略 */
    }
  }
  process.exit(0)
})

send({ id: null, ok: true, result: { ready: true, pid: process.pid, node: process.versions.node } })
