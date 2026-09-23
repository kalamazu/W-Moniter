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
import { mkdirSync, statSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { migrateScope, SCOPE_VERSION } from './migrations/009-scope.mjs'
import { migrateAuth } from './migrations/010-auth.mjs'
import { migrateExtensions } from './migrations/011-extensions.mjs'

// node:sqlite 在 22.x 仍标记 experimental，会往 stderr 吐警告。
// stderr 是日志通道，别让它被警告淹没。
process.removeAllListeners('warning')
process.on('warning', () => {})

const SCHEMA_VERSION = 11

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
let dbScope = { workspaceId: 'default', profileId: 'primary' }

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
  /* info / warn / error。事件流面板要能只看告警，别让详情里塞 */
  level TEXT DEFAULT 'info',
  target_type TEXT,
  url TEXT,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS ix_events_inst_ts ON events (inst, ts);

/*
 * WebSocket / SSE 的帧。握手本身还是 requests 表里的一行（resourceType=WebSocket），
 * 这里只放「握手之后双向跑的东西」—— 那部分 CDP 只在帧事件里给，别处拿不到。
 * payload 对二进制帧是 base64（CDP 的约定），用 binary 列标出来，读的人不用猜。
 */
CREATE TABLE IF NOT EXISTS ws_frames (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inst INTEGER NOT NULL,
  seq INTEGER,
  ts REAL NOT NULL,
  request_id TEXT,
  url TEXT,
  direction TEXT NOT NULL,
  opcode INTEGER,
  payload TEXT,
  size INTEGER,
  truncated INTEGER DEFAULT 0,
  binary INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS ix_ws_inst_id ON ws_frames (inst, id);
CREATE INDEX IF NOT EXISTS ix_ws_req ON ws_frames (inst, request_id);

/*
 * 接口契约快照。json 列存的是整份契约（端点 + 状态码 + 字段表 + 响应形状），
 * 回归时拿它和「当前」比出增删 —— 存结构化查询条件而不是原始行，
 * 是因为契约的意义就是「压缩成可比对的形式」。
 */
CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT,
  inst INTEGER,
  created_at INTEGER NOT NULL,
  json TEXT NOT NULL
);

/*
 * Cookie 罐的镜像。**权威来源是浏览器**（Storage.getCookies），这里只是把每次对账的
 * 结果留一份，好让 agent 在浏览器已经关了的时候还能查、还能做跨会话对比。
 *
 * 主键用 domain|path|name|partition 而不是 id：同一条 cookie 被改写时应该原地更新
 * （change_count +1），而不是多出一行 —— 「现在罐里有什么」和「历史上变过几次」
 * 是两个问题，前者靠这张表，后者靠事件流。
 */
CREATE TABLE IF NOT EXISTS cookies (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  host TEXT NOT NULL,
  path TEXT,
  value TEXT,
  value_len INTEGER DEFAULT 0,
  trunc INTEGER DEFAULT 0,
  expires REAL,
  session INTEGER DEFAULT 0,
  secure INTEGER DEFAULT 0,
  http_only INTEGER DEFAULT 0,
  same_site TEXT,
  priority TEXT,
  source_scheme TEXT,
  source_port INTEGER,
  partition_key TEXT,
  size INTEGER DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  first_inst INTEGER,
  last_inst INTEGER,
  change_count INTEGER DEFAULT 1,
  sent_count INTEGER DEFAULT 0,
  sent_hosts TEXT,
  cross_site INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS ix_cookies_domain ON cookies (domain);
CREATE INDEX IF NOT EXISTS ix_cookies_host ON cookies (host);
CREATE INDEX IF NOT EXISTS ix_cookies_name ON cookies (name);
CREATE INDEX IF NOT EXISTS ix_cookies_size ON cookies (size);

/*
 * 站点资源（按 origin 一行，覆盖式更新）。
 * detail 存整份明细的 JSON（localStorage 键值 / IndexedDB 结构 / 缓存列表 / SW 注册），
 * 列出来的那几个数字是为了让「总览」不用把 detail 全解一遍 —— 总览要扫几百个 origin。
 */
CREATE TABLE IF NOT EXISTS site_origins (
  origin TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_inst INTEGER,
  cookie_count INTEGER DEFAULT 0,
  local_count INTEGER DEFAULT 0,
  local_bytes INTEGER DEFAULT 0,
  session_count INTEGER DEFAULT 0,
  session_bytes INTEGER DEFAULT 0,
  idb_names TEXT,
  idb_stores INTEGER DEFAULT 0,
  cache_names TEXT,
  cache_entries INTEGER DEFAULT 0,
  sw_count INTEGER DEFAULT 0,
  usage_bytes INTEGER,
  quota_bytes INTEGER,
  usage_breakdown TEXT,
  detail TEXT
);

/*
 * 站点资源快照。和契约快照一个道理：拍一份、改点东西、再拍一份，diff 出「多了什么」。
 * 存的是站点清单的全量 JSON，不是查询条件 —— 站点资源不像请求那样有个天然的过滤口径。
 */
CREATE TABLE IF NOT EXISTS site_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT,
  inst INTEGER,
  created_at INTEGER NOT NULL,
  json TEXT NOT NULL
);
`

const REQUEST_COLUMNS = [
  'workspace_id', 'profile_id', 'legacy_origin', 'inst', 'seq', 'key', 'request_id', 'session_id', 'target_id', 'target_type',
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

function openDatabase(dbPath, scope) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
  const existed = dbPath !== ':memory:' && existsSync(dbPath)
  const handle = new DatabaseSync(dbPath)
  try {
  handle.exec('PRAGMA journal_mode = WAL')
  handle.exec('PRAGMA synchronous = NORMAL')
  handle.exec('PRAGMA temp_store = MEMORY')
  handle.exec('PRAGMA cache_size = -32000')
  const hasMeta = handle.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()
  const oldVersion = hasMeta ? Number(handle.prepare("SELECT v FROM meta WHERE k = 'schema_version'").get()?.v || 0) : 0
  if (oldVersion > SCHEMA_VERSION) throw new Error(`database schema ${oldVersion} is newer than supported ${SCHEMA_VERSION}`)
  if (existed && hasMeta && oldVersion < SCHEMA_VERSION) {
    // VACUUM INTO snapshots the WAL too; a raw file copy can silently omit committed rows.
    const backup = `${dbPath}.pre-v${oldVersion < SCOPE_VERSION ? SCOPE_VERSION : oldVersion < 10 ? 10 : 11}-${Date.now()}.bak`
    handle.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`)
  }
  handle.exec(DDL)
  // CREATE TABLE IF NOT EXISTS 不会给已存在的表补列，加列必须显式迁移
  ensureColumn(handle, 'scripts', 'start_line', 'INTEGER NOT NULL DEFAULT 0')
  // §7.1 #2 的发起链：老库的 requests 表没有这一列
  ensureColumn(handle, 'requests', 'initiator_stack', 'TEXT')
  // P5：老库没有代理那几列。CREATE TABLE IF NOT EXISTS 不会补列，必须显式迁移
  for (const [column, decl] of PROXY_COLUMNS) ensureColumn(handle, 'requests', column, decl)
  // v7：事件流加了 level（info/warn/error），老库的 events 没有这一列
  ensureColumn(handle, 'events', 'level', "TEXT DEFAULT 'info'")
  const owner = handle.prepare("SELECT v FROM meta WHERE k = 'workspace_id'").get()?.v
  const profile = handle.prepare("SELECT v FROM meta WHERE k = 'profile_id'").get()?.v
  if (owner && (owner !== scope.workspaceId || profile !== scope.profileId)) {
    throw new Error(`scope mismatch: database belongs to ${owner}/${profile}`)
  }
  migrateScope(handle, { ...scope, adoptLegacy: scope.workspaceId === 'default' })
  migrateAuth(handle)
  migrateExtensions(handle)
  handle.exec('PRAGMA foreign_keys = ON')
  return handle
  } catch (error) {
    handle.close()
    throw error
  }
}

function ensureColumn(handle, table, column, declaration) {
  const columns = handle.prepare('PRAGMA table_info(' + table + ')').all()
  if (columns.some((row) => row.name === column)) return
  handle.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + declaration)
}

function buildStatements() {
  return {
    /* 站点资源：cookie 罐的四条基本操作 */
    insertCookie: db.prepare(
      'INSERT INTO cookies (workspace_id, profile_id, key, name, domain, host, path, value, value_len, trunc, expires, session, secure, ' +
        'http_only, same_site, priority, source_scheme, source_port, partition_key, size, first_seen, last_seen, ' +
        'first_inst, last_inst, change_count) VALUES (' +
        new Array(25).fill('?').join(', ') + ')'
    ),
    updateCookie: db.prepare(
      'UPDATE cookies SET value = ?, value_len = ?, trunc = ?, expires = ?, session = ?, secure = ?, http_only = ?, ' +
        'same_site = ?, priority = ?, source_scheme = ?, source_port = ?, partition_key = ?, size = ?, ' +
        'last_seen = ?, last_inst = ?, change_count = change_count + 1, host = ? WHERE key = ?'
    ),
    touchCookie: db.prepare('UPDATE cookies SET last_seen = ?, last_inst = ? WHERE key = ?'),
    deleteCookie: db.prepare('DELETE FROM cookies WHERE key = ?'),
    cookieSent: db.prepare('UPDATE cookies SET sent_count = ?, sent_hosts = ?, cross_site = ? WHERE key = ?'),
    upsertSiteOrigin: db.prepare(
      'INSERT INTO site_origins (workspace_id, profile_id, origin, first_seen, updated_at, last_inst, cookie_count, local_count, local_bytes, ' +
        'session_count, session_bytes, idb_names, idb_stores, cache_names, cache_entries, sw_count, usage_bytes, ' +
        'quota_bytes, usage_breakdown, detail) VALUES (' +
        new Array(20).fill('?').join(', ') + ') ' +
        'ON CONFLICT(origin) DO UPDATE SET updated_at = excluded.updated_at, last_inst = excluded.last_inst, ' +
        'cookie_count = excluded.cookie_count, local_count = excluded.local_count, local_bytes = excluded.local_bytes, ' +
        'session_count = excluded.session_count, session_bytes = excluded.session_bytes, idb_names = excluded.idb_names, ' +
        'idb_stores = excluded.idb_stores, cache_names = excluded.cache_names, cache_entries = excluded.cache_entries, ' +
        'sw_count = excluded.sw_count, usage_bytes = excluded.usage_bytes, quota_bytes = excluded.quota_bytes, ' +
        'usage_breakdown = excluded.usage_breakdown, detail = excluded.detail'
    ),
    insertSiteSnapshot: db.prepare(
      'INSERT INTO site_snapshots (label, inst, created_at, json) VALUES (?, ?, ?, ?)'
    ),
    insertRequest: db.prepare(INSERT_REQUEST_SQL),
    countInstRequests: db.prepare('SELECT COUNT(*) AS c FROM requests WHERE inst = ?'),
    setBody: db.prepare(
      'UPDATE requests SET body_state = ?, body_size = ?, body_hash = ?, body_trunc = ? ' +
        "WHERE inst = ? AND seq = ? AND (body_state != 'stored' OR ? = 'stored')"
    ),
    getBodyState: db.prepare('SELECT body_state FROM requests WHERE inst = ? AND seq = ?'),
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
      'INSERT INTO events (inst, ts, kind, level, target_type, url, detail) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ),
    insertWsFrame: db.prepare(
      'INSERT INTO ws_frames (inst, seq, ts, request_id, url, direction, opcode, payload, size, truncated, binary) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
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

/** ContentStore 已经原子提交过的正文：SQLite 只登记引用，不接收 BLOB。 */
function appendBodyRefs(inst, items) {
  const now = Date.now()
  db.exec('BEGIN')
  try {
    for (const item of items) {
      if (!item?.hash) continue
      // stored=1 表示正文由受信任内容库持有；blob=null 是刻意的，不是丢失。
      S.upsertBodyNew.run(String(item.hash), Number(item.size ?? 0), item.trunc ? 1 : 0, null, now, now)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return { referenced: items.length }
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
/**
 * 形状 → 扁平路径表。契约回归比对的就是这张表（字段增删 / 类型变化）。
 *
 * 每条路径只出现一次：optional 由父层算出来再往下传。早先父层推一条、
 * 递归又推一条，同一字段会以「有 optional」和「没 optional」两种样子出现两次，
 * 下游按 path 建索引时谁覆盖谁全看顺序。
 */
function schemaToPaths(schema, prefix = '', out = [], optional = false) {
  if (!schema) return out
  if (schema.t === 'object') {
    for (const [key, child] of Object.entries(schema.fields || {})) {
      const path = prefix ? prefix + '.' + key : key
      // seen 少于样本数 = 不是每个样本里都有。契约里「必现」和「可选」是两回事。
      // 父层已经判成可选时得并上（or）—— 不然 bonus.deep 这种「整个 bonus 只在一半样本里」
      // 的字段会被子层自己的 seen==count 抹成必现，契约回归就漏报
      schemaToPaths(child, path, out, optional || (child.seen ?? 0) < (schema.count ?? 1))
    }
    return out
  }
  if (schema.t === 'array') {
    const path = prefix ? prefix + '[]' : '[]'
    out.push({ path, type: 'array', optional })
    if (schema.items) schemaToPaths(schema.items, path, out, optional)
    return out
  }
  out.push({ path: prefix || '(root)', type: schema.t, optional })
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
  'start_ts', 'target_type', 'frame_url', 'initiator_stack', 'initiator_type',
  // request_id 是重定向链的分组键（同一 requestId 的多跳），漏了它关联分析就只能瞎猜
  'request_id'
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

/**
 * sqlite 的 blob 是 Uint8Array，不是 Buffer —— 对它调 .toString('utf8')
 * 得到的是 "1,2,3" 这种逗号串，不是文本。这里统一包成 Buffer 再交出去，
 * 免得每个调用点各错一遍（这个坑在 HAR、JSONL、schema 抽样上同时踩过）。
 */
function readBodyBytes(hash) {
  const row = db.prepare('SELECT size, stored, blob FROM bodies WHERE hash = ?').get(norm(hash))
  if (row?.stored && row.blob) {
    const raw = row.blob
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
    return { bytes, size: row.size }
  }
  if (!config.contentDir || !/^[a-f0-9]{64}$/.test(hash)) return null
  try {
    const manifest = JSON.parse(readFileSync(join(config.contentDir, 'manifests', `${hash}.json`), 'utf8'))
    if (manifest.hash !== hash || !Array.isArray(manifest.chunkHashes)) return null
    const chunks = manifest.chunkHashes.map((chunkHash) => {
      if (!/^[a-f0-9]{64}$/.test(chunkHash)) throw new Error('bad chunk hash')
      const chunk = readFileSync(join(config.contentDir, 'chunks', chunkHash))
      if (createHash('sha256').update(chunk).digest('hex') !== chunkHash) throw new Error('bad chunk')
      return chunk
    })
    const bytes = Buffer.concat(chunks)
    if (bytes.length !== manifest.size || createHash('sha256').update(bytes).digest('hex') !== hash) return null
    return { bytes, size: bytes.length }
  } catch { return null }
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
    // 扁平字段表是给 agent 直接用的：嵌套形状要递归才能回答「有没有 foo.bar」
    responseFields: schemaToPaths(response.schema),
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
  // 状态码的增删按「全量集合」算，而不是只看 changed：
  // 一个新端点带着新状态码进来，「这个状态码是新的」这件事同样成立。
  const baseStatuses = new Set(base.endpoints.flatMap((item) => item.statuses))
  const currentStatuses = new Set(current.endpoints.flatMap((item) => item.statuses))
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
      addedEndpointKeys: added.map((item) => item.key),
      removedEndpointKeys: removed.map((item) => item.key),
      newStatusCodes: [...currentStatuses].filter((item) => !baseStatuses.has(item)).sort(),
      droppedStatusCodes: [...baseStatuses].filter((item) => !currentStatuses.has(item)).sort(),
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

/* ==================================================== 站点资源（cookie / 存储） */

/** cookie 罐里的主键：domain|path|name|partition。同一条 cookie 更新时靠它原地更新 */
function cookieKeyOf(item) {
  const domain = stripLeadingDots(String(item.domain ?? item.host ?? '')).toLowerCase()
  const path = item.path || '/'
  return domain + '|' + path + '|' + String(item.name ?? '') + '|' + String(item.partitionKey ?? '')
}

/** 不用正则，避免在 spec 里被转义吃掉（这一类坑踩过） */
function stripLeadingDots(text) {
  let i = 0
  while (i < text.length && text[i] === '.') i += 1
  return text.slice(i)
}

/** 值超过这个长度就截断落库。cookie 本身有 4KB 上限，正常不会到 */
const COOKIE_VALUE_MAX = 4096

function cookieJson(row) {
  return {
    key: row.key,
    name: row.name,
    value: row.value ?? '',
    ...(row.trunc ? { truncated: true } : {}),
    valueLen: row.value_len ?? 0,
    domain: row.domain,
    path: row.path ?? '/',
    ...(row.expires === null || row.expires === undefined ? {} : { expires: row.expires }),
    session: Boolean(row.session),
    secure: Boolean(row.secure),
    httpOnly: Boolean(row.http_only),
    ...(row.same_site ? { sameSite: row.same_site } : {}),
    ...(row.priority ? { priority: row.priority } : {}),
    ...(row.source_scheme ? { sourceScheme: row.source_scheme } : {}),
    ...(row.source_port === null || row.source_port === undefined ? {} : { sourcePort: row.source_port }),
    ...(row.partition_key ? { partitionKey: row.partition_key } : {}),
    size: row.size ?? 0,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    changeCount: row.change_count ?? 1,
    sentCount: row.sent_count ?? 0,
    sentHosts: parseJsonArray(row.sent_hosts),
    crossSite: Boolean(row.cross_site)
  }
}

function parseJsonArray(text) {
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * cookie 罐对账。
 *
 * 传进来的就是「浏览器此刻的罐」——全量替换语义。跟库里现有的比一遍：
 *   库里没有 → added；值或属性变了 → changed；库里多出来的 → removed。
 * 只有真的变了才产生事件，光 last_seen 变化不产生 —— 否则每轮对账都刷屏。
 *
 * attribution 是「刚刚收到过 Set-Cookie 的响应」，用来给变化标一个来源 URL。
 * 这里不做 Set-Cookie 语义解析（domain/path 匹配、Max-Age 这些坑太多），
 * 只把「谁改的」对上号 —— 判定本身以浏览器的罐为准，天然正确。
 */
function cookieSync(args) {
  const now = Number(args.now) || Date.now()
  const inst = norm(args.inst)
  const incoming = new Map()
  for (const item of args.cookies || []) incoming.set(cookieKeyOf(item), item)

  const existing = new Map()
  for (const row of db
    .prepare('SELECT * FROM cookies')
    .all()) {
    existing.set(row.key, row)
  }

  const attributions = Array.isArray(args.attribution) ? args.attribution : []
  const sourceFor = (name) => {
    for (let i = attributions.length - 1; i >= 0; i -= 1) {
      const item = attributions[i]
      if (!item || !item.url) continue
      if (!Array.isArray(item.names) || item.names.length === 0) return { source: 'set-cookie', url: item.url }
      if (item.names.includes(name)) return { source: 'set-cookie', url: item.url }
    }
    return { source: 'scan' }
  }

  const changes = []
  let added = 0
  let changed = 0
  let removed = 0
  let touched = 0

  db.exec('BEGIN')
  try {
    for (const [key, item] of incoming) {
      const domain = stripLeadingDots(String(item.domain ?? item.host ?? '')).toLowerCase()
      const host = stripLeadingDots(String(item.host ?? item.domain ?? '')).toLowerCase()
      const rawValue = String(item.value ?? '')
      const truncated = rawValue.length > COOKIE_VALUE_MAX
      const stored = truncated ? rawValue.slice(0, COOKIE_VALUE_MAX) : rawValue
      const path = item.path || '/'
      const prev = existing.get(key)
      if (!prev) {
        S.insertCookie.run(
          dbScope.workspaceId, dbScope.profileId,
          key, String(item.name ?? ''), domain, host, path, stored, rawValue.length, truncated ? 1 : 0,
          norm(item.expires), item.session ? 1 : 0, item.secure ? 1 : 0, item.httpOnly ? 1 : 0,
          norm(item.sameSite), norm(item.priority), norm(item.sourceScheme), norm(item.sourcePort),
          norm(item.partitionKey), norm(item.size) ?? stored.length, now, now, inst, inst, 1
        )
        added += 1
        const from = sourceFor(String(item.name ?? ''))
        changes.push({
          action: 'added', name: String(item.name ?? ''), domain, path,
          value: stored, valueLen: rawValue.length, ...from
        })
        continue
      }
      existing.delete(key)
      const valueMoved = (prev.value ?? '') !== stored || (prev.value_len ?? 0) !== rawValue.length
      const metaMoved =
        (prev.expires ?? null) !== (norm(item.expires) ?? null) ||
        Boolean(prev.session) !== Boolean(item.session) ||
        Boolean(prev.secure) !== Boolean(item.secure) ||
        Boolean(prev.http_only) !== Boolean(item.httpOnly) ||
        (prev.same_site ?? null) !== (norm(item.sameSite) ?? null) ||
        (prev.host ?? '') !== host
      if (valueMoved || metaMoved) {
        S.updateCookie.run(
          stored, rawValue.length, truncated ? 1 : 0, norm(item.expires), item.session ? 1 : 0,
          item.secure ? 1 : 0, item.httpOnly ? 1 : 0, norm(item.sameSite), norm(item.priority),
          norm(item.sourceScheme), norm(item.sourcePort), norm(item.partitionKey),
          norm(item.size) ?? stored.length, now, inst, host, key
        )
        changed += 1
        const from = sourceFor(String(item.name ?? ''))
        changes.push({
          action: 'changed', name: String(item.name ?? ''), domain, path,
          value: stored, valueLen: rawValue.length, ...from
        })
        continue
      }
      S.touchCookie.run(now, inst, key)
      touched += 1
    }

    for (const [key, prev] of existing) {
      S.deleteCookie.run(key)
      removed += 1
      changes.push({
        action: 'removed', name: prev.name, domain: prev.domain, path: prev.path ?? '/',
        valueLen: prev.value_len ?? 0, reason: 'gone', source: 'scan'
      })
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  return { total: incoming.size, added, changed, removed, touched, changes }
}

function cookieFilterOf(args) {
  const q = args.query || {}
  const clauses = []
  const params = []
  if (q.search) {
    const like = '%' + q.search + '%'
    clauses.push('(name LIKE ? OR domain LIKE ? OR value LIKE ?)')
    params.push(like, like, like)
  }
  if (q.domain) {
    const domain = stripLeadingDots(String(q.domain)).toLowerCase()
    clauses.push('(host = ? OR host LIKE ?)')
    params.push(domain, '%.' + domain)
  }
  if (q.name) {
    clauses.push('name = ?')
    params.push(String(q.name))
  }
  if (q.path) {
    clauses.push('path = ?')
    params.push(String(q.path))
  }
  if (q.session !== undefined) {
    clauses.push('session = ?')
    params.push(q.session ? 1 : 0)
  }
  if (q.crossSite !== undefined) {
    clauses.push('cross_site = ?')
    params.push(q.crossSite ? 1 : 0)
  }
  if (q.sameSite) {
    clauses.push('same_site = ?')
    params.push(String(q.sameSite))
  }
  if (q.secure !== undefined) {
    clauses.push('secure = ?')
    params.push(q.secure ? 1 : 0)
  }
  if (q.httpOnly !== undefined) {
    clauses.push('http_only = ?')
    params.push(q.httpOnly ? 1 : 0)
  }
  if (q.partitioned !== undefined) {
    clauses.push(q.partitioned ? "COALESCE(partition_key, '') <> ''" : "COALESCE(partition_key, '') = ''")
  }
  return { sql: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', params }
}

const COOKIE_SORTS = { size: 'size', lastSeen: 'last_seen', sentCount: 'sent_count', domain: 'domain', name: 'name' }

function cookieList(args) {
  const where = cookieFilterOf(args)
  const sort = COOKIE_SORTS[args.query?.sort] ?? 'size'
  const desc = args.query?.order !== 'asc'
  const limit = clampInt(args.query?.limit ?? args.limit, 200, 1, 2000)
  const offset = clampInt(args.query?.offset ?? args.offset, 0, 0, 1e9)
  const rows = db
    .prepare('SELECT * FROM cookies ' + where.sql + ' ORDER BY ' + sort + (desc ? ' DESC' : ' ASC') + ' LIMIT ? OFFSET ?')
    .all(...where.params, limit, offset)
  const total = db.prepare('SELECT COUNT(*) AS c FROM cookies ' + where.sql).get(...where.params).c
  return { rows: rows.map(cookieJson), total, limit, offset }
}

/**
 * cookie 画像：研究要看的不是「有多少条」，而是「谁在用、跨了几站、活了多久」。
 */
function cookieStats(args) {
  const now = Number(args.now) || Date.now()
  const one = (sql, ...params) => db.prepare(sql).get(...params).c
  const total = one('SELECT COUNT(*) AS c FROM cookies')
  return {
    total,
    hosts: one('SELECT COUNT(DISTINCT host) AS c FROM cookies'),
    session: one('SELECT COUNT(*) AS c FROM cookies WHERE session = 1'),
    persistent: one('SELECT COUNT(*) AS c FROM cookies WHERE session = 0'),
    secure: one('SELECT COUNT(*) AS c FROM cookies WHERE secure = 1'),
    httpOnly: one('SELECT COUNT(*) AS c FROM cookies WHERE http_only = 1'),
    sameSiteNone: one("SELECT COUNT(*) AS c FROM cookies WHERE same_site = 'None'"),
    crossSite: one('SELECT COUNT(*) AS c FROM cookies WHERE cross_site = 1'),
    partitioned: one("SELECT COUNT(*) AS c FROM cookies WHERE COALESCE(partition_key, '') <> ''"),
    totalBytes: db.prepare('SELECT COALESCE(SUM(size), 0) AS c FROM cookies').get().c,
    biggest: db
      .prepare('SELECT name, domain, size FROM cookies ORDER BY size DESC LIMIT 10')
      .all(),
    bySameSite: db
      .prepare(
        // GROUP BY key 会撞上 cookies 自己的 key 列（主键），于是每条 cookie 一组 ——
        // 必须按整段表达式分组
        "SELECT COALESCE(same_site, '(未声明)') AS key, COUNT(*) AS count FROM cookies " +
          "GROUP BY COALESCE(same_site, '(未声明)') ORDER BY count DESC"
      )
      .all(),
    sharedNames: db
      .prepare(
        'SELECT name, COUNT(DISTINCT host) AS hosts, COUNT(*) AS count FROM cookies ' +
          'GROUP BY name HAVING hosts > 1 ORDER BY hosts DESC, count DESC LIMIT 20'
      )
      .all(),
    longLived: db
      .prepare('SELECT name, domain, expires FROM cookies WHERE session = 0 AND expires IS NOT NULL ORDER BY expires DESC LIMIT 10')
      .all()
      .map((row) => ({ ...row, days: Math.round(((row.expires * 1000 - now) / 86400000) * 10) / 10 })),
    mostSent: db
      .prepare('SELECT name, domain, sent_count AS sentCount, sent_hosts AS sentHosts FROM cookies WHERE sent_count > 0 ORDER BY sent_count DESC LIMIT 15')
      .all()
      .map((row) => ({ name: row.name, domain: row.domain, sentCount: row.sentCount, hosts: parseJsonArray(row.sentHosts).length }))
  }
}

/**
 * cookie 被带出去过（requestWillBeSentExtraInfo.associatedCookies）。
 * 累计「发往过哪些站点」—— 一条 cookie 出现在多个站点上，就是它在跟着你走。
 * sent_hosts 封顶 32 个站点，再多也只是数字膨胀。
 */
function cookieRememberSent(args) {
  const items = args.items || []
  if (items.length === 0) return { updated: 0 }
  const hostsByKey = new Map()
  for (const item of items) {
    if (!item || !item.key || !item.host) continue
    const set = hostsByKey.get(item.key) ?? new Set()
    set.add(String(item.host))
    hostsByKey.set(item.key, set)
  }
  if (hostsByKey.size === 0) return { updated: 0 }
  const rows = new Map()
  const placeholders = [...hostsByKey.keys()].map(() => '?').join(',')
  for (const row of db.prepare('SELECT key, domain, sent_count, sent_hosts, cross_site FROM cookies WHERE key IN (' + placeholders + ')').all(...hostsByKey.keys())) {
    rows.set(row.key, row)
  }
  let updated = 0
  db.exec('BEGIN')
  try {
    for (const [key, hostSet] of hostsByKey) {
      const row = rows.get(key)
      if (!row) continue
      const merged = new Set(parseJsonArray(row.sent_hosts))
      for (const host of hostSet) merged.add(host)
      const hosts = [...merged].slice(0, 32)
      const domain = stripLeadingDots(String(row.domain ?? '')).toLowerCase()
      // 「跨站」= 用到它的站点不是它自己（也不是它的子域）。这是最保守的定义
      const cross = hosts.some((host) => host !== domain && !host.endsWith('.' + domain))
      S.cookieSent.run((row.sent_count ?? 0) + 1, JSON.stringify(hosts), cross ? 1 : 0, key)
      updated += 1
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return { updated }
}

/* ------------------------------------------------- 站点资源：清单与快照 */

function parseJsonObject(text) {
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** 从 requests 里认出来的 origin。端口要带上，http 和 https 也不能混成一个站点 */
function siteOriginsSeen(args) {
  const inst = norm(args.inst)
  const limit = clampInt(args.limit, 200, 1, 2000)
  const rows = db
    .prepare(
      'SELECT host, COUNT(*) AS calls, MAX(start_ts) AS lastAt, MAX(url) AS sampleUrl FROM requests ' +
        "WHERE inst = ? AND host IS NOT NULL AND host <> '' GROUP BY host ORDER BY lastAt DESC LIMIT ?"
    )
    .all(inst, limit)
  const out = []
  for (const row of rows) {
    let origin = null
    try {
      origin = new URL(row.sampleUrl).origin
    } catch {
      origin = null
    }
    if (!origin || origin === 'null') continue
    out.push({ origin, calls: row.calls, lastAt: row.lastAt })
  }
  return { rows: out }
}

/** host → cookie 条数。按父域累加：example.com 的 cookie 对 www.example.com 也算数 */
function cookieCountsByHost() {
  const map = new Map()
  for (const row of db.prepare('SELECT host, COUNT(*) AS c FROM cookies GROUP BY host').all()) {
    map.set(row.host, row.c)
  }
  return map
}

function cookieCountFor(host, map) {
  if (!host) return 0
  const parts = String(host).split('.')
  let total = 0
  for (let i = 0; i < parts.length; i += 1) {
    total += map.get(parts.slice(i).join('.')) ?? 0
  }
  return total
}

function originHost(origin) {
  try {
    return new URL(origin).hostname
  } catch {
    return ''
  }
}

function siteRowJson(row, counts) {
  return {
    origin: row.origin,
    updatedAt: row.updated_at ?? 0,
    scanned: true,
    cookieCount: cookieCountFor(originHost(row.origin), counts),
    localStorageCount: row.local_count ?? 0,
    localStorageBytes: row.local_bytes ?? 0,
    sessionStorageCount: row.session_count ?? 0,
    sessionStorageBytes: row.session_bytes ?? 0,
    idbNames: parseJsonArray(row.idb_names),
    idbStores: row.idb_stores ?? 0,
    cacheNames: parseJsonArray(row.cache_names),
    cacheEntries: row.cache_entries ?? 0,
    swCount: row.sw_count ?? 0,
    usageBytes: row.usage_bytes ?? null,
    quotaBytes: row.quota_bytes ?? null,
    usageBreakdown: parseJsonArray(row.usage_breakdown)
  }
}

function emptySiteJson(origin, counts) {
  return {
    origin,
    updatedAt: 0,
    scanned: false,
    cookieCount: cookieCountFor(originHost(origin), counts),
    localStorageCount: 0,
    localStorageBytes: 0,
    sessionStorageCount: 0,
    sessionStorageBytes: 0,
    idbNames: [],
    idbStores: 0,
    cacheNames: [],
    cacheEntries: 0,
    swCount: 0,
    usageBytes: null,
    quotaBytes: null,
    usageBreakdown: []
  }
}

/**
 * 站点资源总览 = 「见过的域」∪「扫过的域」。
 * 见过的排前面（按最近活动），扫过但这次没流量的补在后面 —— 扫过却没扫到不该从列表里消失。
 */
function siteOverview(args) {
  const inst = norm(args.inst)
  const limit = clampInt(args.limit, 300, 1, 5000)
  const counts = cookieCountsByHost()
  const stored = new Map()
  for (const row of db.prepare('SELECT * FROM site_origins').all()) stored.set(row.origin, row)
  const seen = siteOriginsSeen({ inst, limit: limit * 2 }).rows
  const out = []
  const taken = new Set()
  for (const item of seen) {
    if (taken.has(item.origin)) continue
    taken.add(item.origin)
    const row = stored.get(item.origin)
    if (row && args.onlyScanned !== true) out.push(siteRowJson(row, counts))
    else if (row) continue
    else out.push(emptySiteJson(item.origin, counts))
    stored.delete(item.origin)
  }
  if (args.onlyScanned !== true) {
    for (const row of stored.values()) out.push(siteRowJson(row, counts))
  } else {
    for (const row of stored.values()) out.push(siteRowJson(row, counts))
  }
  return { rows: out.slice(0, limit), total: out.length }
}

function siteDetail(args) {
  const origin = String(args.origin ?? '')
  if (!origin) return { error: '要给 origin' }
  const counts = cookieCountsByHost()
  const row = db.prepare('SELECT * FROM site_origins WHERE origin = ?').get(origin)
  const base = row ? siteRowJson(row, counts) : emptySiteJson(origin, counts)
  const detail = row ? parseJsonObject(row.detail) : null
  const host = originHost(origin)
  const cookies = db
    .prepare('SELECT * FROM cookies WHERE host = ? OR host LIKE ? ORDER BY size DESC')
    .all(host, '%.' + host)
    .map(cookieJson)
  return {
    ...base,
    cookies,
    localStorage: Array.isArray(detail?.localStorage) ? detail.localStorage : [],
    sessionStorage: Array.isArray(detail?.sessionStorage) ? detail.sessionStorage : [],
    idb: Array.isArray(detail?.idb) ? detail.idb : [],
    caches: Array.isArray(detail?.caches) ? detail.caches : [],
    serviceWorkers: Array.isArray(detail?.serviceWorkers) ? detail.serviceWorkers : []
  }
}

/** 当前站点清单（不落库的那份），快照与 diff 共用 */
function currentSiteDoc() {
  const cookies = db.prepare('SELECT * FROM cookies').all().map(cookieJson)
  const origins = db
    .prepare('SELECT * FROM site_origins ORDER BY origin')
    .all()
    .map((row) => {
      const detail = parseJsonObject(row.detail)
      const entries = Array.isArray(detail?.localStorage) ? detail.localStorage : []
      const keys = entries.map((item) => item.key)
      const keyBytes = {}
      for (const item of entries) keyBytes[item.key] = item.bytes ?? 0
      return {
        origin: row.origin,
        cookieCount: row.cookie_count ?? 0,
        localCount: row.local_count ?? 0,
        localBytes: row.local_bytes ?? 0,
        sessionCount: row.session_count ?? 0,
        idbNames: parseJsonArray(row.idb_names),
        cacheNames: parseJsonArray(row.cache_names),
        swCount: row.sw_count ?? 0,
        usageBytes: row.usage_bytes ?? null,
        keys,
        keyBytes
      }
    })
  return { cookies, origins }
}

function siteSnapshot(args) {
  const doc = currentSiteDoc()
  const json = JSON.stringify(doc)
  const createdAt = Date.now()
  const info = S.insertSiteSnapshot.run(norm(args.label), norm(args.inst), createdAt, json)
  return {
    id: Number(info.lastInsertRowid),
    label: args.label === undefined || args.label === null ? null : String(args.label),
    createdAt,
    origins: doc.origins.length,
    cookies: doc.cookies.length,
    bytes: json.length
  }
}

function siteSnapshotList(args) {
  return {
    rows: db
      .prepare('SELECT id, label, created_at AS createdAt, LENGTH(json) AS bytes FROM site_snapshots ORDER BY id DESC LIMIT ?')
      .all(clampInt(args.limit, 50, 1, 500))
      .map((row) => {
        const doc = parseJsonObject(db.prepare('SELECT json FROM site_snapshots WHERE id = ?').get(row.id).json)
        return { ...row, origins: doc?.origins?.length ?? 0, cookies: doc?.cookies?.length ?? 0 }
      })
  }
}

function loadSiteSnapshot(id) {
  const row = db.prepare('SELECT id, label, created_at AS createdAt, json FROM site_snapshots WHERE id = ?').get(norm(id))
  if (!row) return null
  const doc = parseJsonObject(row.json)
  if (!doc) return null
  return { id: row.id, label: row.label ?? null, createdAt: row.createdAt, doc }
}

/** 一条 cookie 的身份。比对时用它，别拿整个对象比对（lastSeen 每次都变） */
function cookieIdent(cookie) {
  return String(cookie.domain).toLowerCase() + '|' + (cookie.path || '/') + '|' + cookie.name
}

function cookieShape(cookie) {
  return [cookie.valueLen, cookie.session, cookie.secure, cookie.httpOnly, cookie.sameSite ?? '', cookie.expires ?? '', cookie.partitionKey ?? ''].join('|')
}

function siteSnapshotDiff(args) {
  const base = loadSiteSnapshot(args.baseId)
  if (!base) return { error: '没有这个站点快照：' + String(args.baseId) }
  const current = currentSiteDoc()

  const baseOrigins = new Map(base.doc.origins.map((item) => [item.origin, item]))
  const currOrigins = new Map(current.origins.map((item) => [item.origin, item]))
  const addedOrigins = []
  const removedOrigins = []
  const changedOrigins = []
  for (const [origin, item] of currOrigins) {
    const prev = baseOrigins.get(origin)
    if (!prev) {
      addedOrigins.push(origin)
      continue
    }
    const notes = []
    if ((prev.localCount ?? 0) !== (item.localCount ?? 0)) notes.push('localStorage ' + (prev.localCount ?? 0) + ' → ' + (item.localCount ?? 0))
    if ((prev.sessionCount ?? 0) !== (item.sessionCount ?? 0)) notes.push('sessionStorage ' + (prev.sessionCount ?? 0) + ' → ' + (item.sessionCount ?? 0))
    if ((prev.cookieCount ?? 0) !== (item.cookieCount ?? 0)) notes.push('cookie ' + (prev.cookieCount ?? 0) + ' → ' + (item.cookieCount ?? 0))
    if ((prev.swCount ?? 0) !== (item.swCount ?? 0)) notes.push('Service Worker ' + (prev.swCount ?? 0) + ' → ' + (item.swCount ?? 0))
    if ((prev.cacheNames ?? []).join(',') !== (item.cacheNames ?? []).join(',')) notes.push('缓存清单变了')
    if ((prev.idbNames ?? []).join(',') !== (item.idbNames ?? []).join(',')) notes.push('IndexedDB 清单变了')
    if (notes.length > 0) changedOrigins.push({ origin, summary: notes })
  }
  for (const origin of baseOrigins.keys()) {
    if (!currOrigins.has(origin)) removedOrigins.push(origin)
  }

  const baseCookies = new Map(base.doc.cookies.map((item) => [cookieIdent(item), item]))
  const currCookies = new Map(current.cookies.map((item) => [cookieIdent(item), item]))
  const brief = (item) => ({ name: item.name, domain: item.domain, path: item.path })
  const addedCookies = []
  const removedCookies = []
  const changedCookies = []
  for (const [id, item] of currCookies) {
    const prev = baseCookies.get(id)
    if (!prev) {
      addedCookies.push(brief(item))
      continue
    }
    const fields = []
    if ((prev.value ?? '') !== (item.value ?? '')) fields.push('value')
    if (Boolean(prev.session) !== Boolean(item.session)) fields.push('session')
    if (Boolean(prev.secure) !== Boolean(item.secure)) fields.push('secure')
    if (Boolean(prev.httpOnly) !== Boolean(item.httpOnly)) fields.push('httpOnly')
    if ((prev.sameSite ?? '') !== (item.sameSite ?? '')) fields.push('sameSite')
    if ((prev.expires ?? 0) !== (item.expires ?? 0)) fields.push('expires')
    if (fields.length > 0) changedCookies.push({ ...brief(item), fields })
  }
  for (const [id, item] of baseCookies) {
    if (!currCookies.has(id)) removedCookies.push(brief(item))
  }

  const baseKeys = new Set()
  for (const item of base.doc.origins) for (const key of item.keys ?? []) baseKeys.add(item.origin + '::' + key)
  const currKeys = new Set()
  for (const item of current.origins) for (const key of item.keys ?? []) currKeys.add(item.origin + '::' + key)
  const keysAdded = [...currKeys].filter((key) => !baseKeys.has(key))
  const keysRemoved = [...baseKeys].filter((key) => !currKeys.has(key))
  /* 键还在但内容变了也要算出来 —— 只看「有没有这个键」会漏掉一半的真相 */
  const baseSizes = new Map()
  for (const item of base.doc.origins) for (const [key, bytes] of Object.entries(item.keyBytes ?? {})) baseSizes.set(item.origin + '::' + key, bytes)
  const currSizes = new Map()
  for (const item of current.origins) for (const [key, bytes] of Object.entries(item.keyBytes ?? {})) currSizes.set(item.origin + '::' + key, bytes)
  const keysChanged = []
  for (const [key, bytes] of currSizes) {
    if (!baseSizes.has(key)) continue
    if (baseSizes.get(key) !== bytes) keysChanged.push(key)
  }

  return {
    baseId: base.id,
    baseLabel: base.label,
    createdAt: base.createdAt,
    origins: { added: addedOrigins, removed: removedOrigins, changed: changedOrigins },
    cookies: { added: addedCookies, removed: removedCookies, changed: changedCookies },
    localStorage: { added: keysAdded, removed: keysRemoved, changed: keysChanged },
    summary: {
      originsAdded: addedOrigins.length,
      originsRemoved: removedOrigins.length,
      cookiesAdded: addedCookies.length,
      cookiesRemoved: removedCookies.length,
      cookiesChanged: changedCookies.length,
      keysAdded: keysAdded.length,
      keysRemoved: keysRemoved.length,
      keysChanged: keysChanged.length
    }
  }
}

function siteSnapshotDelete(args) {
  const info = db.prepare('DELETE FROM site_snapshots WHERE id = ?').run(norm(args.id))
  return { deleted: Number(info.changes) || 0 }
}

const OPS = {
  open(args) {
    if (db) db.close()
    Object.assign(config, args.config || {})
    const workspaceId = args.config?.workspaceId ?? 'default'
    const profileId = args.config?.profileId ?? 'primary'
    if (typeof workspaceId !== 'string' || !workspaceId || typeof profileId !== 'string' || !profileId) {
      throw new Error('workspaceId/profileId must be nonempty strings')
    }
    dbScope = { workspaceId, profileId }
    db = openDatabase(args.dbPath, dbScope)
    dbFilePath = args.dbPath
    S = buildStatements()
    return { schemaVersion: SCHEMA_VERSION, dbPath: args.dbPath, config: { ...config } }
  },

  extensionSetDesired(args) {
    const id = String(args.extensionId ?? '')
    if (!/^[a-p]{32}$/.test(id)) throw new Error('invalid extension ID')
    const version = args.version == null ? null : String(args.version).slice(0, 80)
    const permissions = Array.isArray(args.permissions) ? [...new Set(args.permissions.map(String))].sort() : null
    if (permissions?.some(value => value.length > 200) || (permissions && permissions.length > 100)) throw new Error('invalid permissions')
    const now = Date.now()
    db.prepare(`INSERT INTO extension_desired(workspace_id,profile_id,extension_id,version,permissions,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id,profile_id,extension_id) DO UPDATE SET
      version=excluded.version,permissions=excluded.permissions,updated_at=excluded.updated_at`)
      .run(dbScope.workspaceId, dbScope.profileId, id, version, permissions ? JSON.stringify(permissions) : null, now)
    return { extensionId: id, version, permissions, updatedAt: now }
  },

  extensionObserve(args) {
    const source = String(args.source ?? '')
    if (!['profile', 'management'].includes(source)) throw new Error('invalid extension observation source')
    const complete = source === 'management' && args.complete === true
    const rows = Array.isArray(args.rows) ? args.rows : []
    if (rows.length > 1000) throw new Error('too many extensions')
    const now = Date.now()
    db.exec('BEGIN IMMEDIATE')
    try {
      const put = db.prepare(`INSERT INTO extension_observed(workspace_id,profile_id,extension_id,name,version,permissions,enabled,source,observed_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,profile_id,extension_id) DO UPDATE SET
        name=excluded.name,version=excluded.version,permissions=excluded.permissions,
        enabled=excluded.enabled,source=excluded.source,observed_at=excluded.observed_at`)
      for (const row of rows) {
        const id = String(row.id ?? '')
        if (!/^[a-p]{32}$/.test(id)) throw new Error('invalid observed extension ID')
        const perms = Array.isArray(row.permissions) ? [...new Set(row.permissions.map(String))].sort() : null
        put.run(dbScope.workspaceId, dbScope.profileId, id, String(row.name ?? '').slice(0, 200),
          row.version == null ? null : String(row.version).slice(0, 80), perms ? JSON.stringify(perms) : null,
          typeof row.enabled === 'boolean' ? Number(row.enabled) : null, source, now)
      }
      if (complete) {
        const ids = new Set(rows.map(row => String(row.id)))
        for (const old of db.prepare('SELECT extension_id FROM extension_observed WHERE workspace_id=? AND profile_id=?').all(dbScope.workspaceId, dbScope.profileId)) {
          if (!ids.has(old.extension_id)) db.prepare('DELETE FROM extension_observed WHERE workspace_id=? AND profile_id=? AND extension_id=?').run(dbScope.workspaceId, dbScope.profileId, old.extension_id)
        }
      }
      db.prepare(`INSERT INTO extension_scans(workspace_id,profile_id,source,complete,reason,observed_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(workspace_id,profile_id) DO UPDATE SET source=excluded.source,complete=excluded.complete,reason=excluded.reason,observed_at=excluded.observed_at`)
        .run(dbScope.workspaceId, dbScope.profileId, source, Number(complete), args.reason ? String(args.reason).slice(0, 300) : null, now)
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    return { count: rows.length, complete, observedAt: now }
  },

  extensionSummary() {
    const scan = db.prepare('SELECT source,complete,reason,observed_at FROM extension_scans WHERE workspace_id=? AND profile_id=?').get(dbScope.workspaceId, dbScope.profileId) ?? null
    const desired = db.prepare('SELECT extension_id,version,permissions,updated_at FROM extension_desired WHERE workspace_id=? AND profile_id=?').all(dbScope.workspaceId, dbScope.profileId)
    const observed = db.prepare('SELECT extension_id,name,version,permissions,enabled,source,observed_at FROM extension_observed WHERE workspace_id=? AND profile_id=?').all(dbScope.workspaceId, dbScope.profileId)
    const actual = new Map(observed.map(row => [row.extension_id, row]))
    return { workspaceId: dbScope.workspaceId, profileId: dbScope.profileId, scan, items: [
      ...desired.map(want => {
        const got = actual.get(want.extension_id)
        const expectedPermissions = want.permissions ? JSON.parse(want.permissions) : null
        const actualPermissions = got?.permissions ? JSON.parse(got.permissions) : null
        const reasons = []
        const stale = got && scan && got.observed_at !== scan.observed_at
        if (stale) reasons.push('not_observed_in_latest_scan')
        if (!got) reasons.push(scan?.complete ? 'missing' : 'not_observed_in_partial_scan')
        if (got && want.version && got.version && want.version !== got.version) reasons.push('version_mismatch')
        if (got && expectedPermissions && actualPermissions && JSON.stringify(expectedPermissions) !== JSON.stringify(actualPermissions)) reasons.push('permissions_mismatch')
        if (got && got.enabled === 0) reasons.push('disabled')
        if (got && (want.version && !got.version || expectedPermissions && !actualPermissions)) reasons.push('insufficient_observation')
        return { extensionId: want.extension_id, desired: { version: want.version, permissions: expectedPermissions, updatedAt: want.updated_at },
          observed: got ? { name: got.name, version: got.version, permissions: actualPermissions, enabled: got.enabled === null ? null : Boolean(got.enabled), source: got.source, observedAt: got.observed_at } : null,
          state: stale ? 'unknown' : reasons.length ? reasons.every(reason => ['not_observed_in_partial_scan','insufficient_observation'].includes(reason)) ? 'unknown' : 'drift' : 'aligned', reasons }
      }),
      ...observed.filter(row => !desired.some(want => want.extension_id === row.extension_id)).map(row => ({ extensionId: row.extension_id,
        desired: null, observed: { name: row.name, version: row.version, permissions: row.permissions ? JSON.parse(row.permissions) : null,
          enabled: row.enabled === null ? null : Boolean(row.enabled), source: row.source, observedAt: row.observed_at },
        state: scan && row.observed_at !== scan.observed_at ? 'unknown' : 'observed_only',
        reasons: scan && row.observed_at !== scan.observed_at ? ['not_observed_in_latest_scan'] : [] }))
    ] }
  },

  authSummary() {
    const now = Date.now()
    return db.prepare('SELECT origin, state, account_label, source, observed_at, verified_at, fresh_until FROM site_identities WHERE workspace_id = ? AND profile_id = ? ORDER BY observed_at DESC')
      .all(dbScope.workspaceId, dbScope.profileId)
      .map(row => ({ ...row, state: row.state === 'verified' && row.fresh_until < now ? 'stale' : row.state }))
  },

  authRecord(args) {
    const origin = new URL(String(args.origin)).origin
    if (!/^https?:/.test(origin)) throw new Error('auth origin must be HTTP(S)')
    let state = String(args.state)
    const source = String(args.source)
    if (!['suspected', 'verified', 'logged_out', 'unknown', 'stale'].includes(state)) throw new Error('invalid auth state')
    if (!['cookie', 'navigation', 'fixture', 'restore'].includes(source)) throw new Error('invalid auth source')
    if (state === 'verified' && source !== 'fixture') throw new Error('verified requires active fixture evidence')
    const previous = db.prepare('SELECT state FROM site_identities WHERE workspace_id=? AND profile_id=? AND origin=?')
      .get(dbScope.workspaceId, dbScope.profileId, origin)
    // A restored browser may still carry an old cookie. Seeing it again is not
    // fresh proof of login and must not erase the explicit stale verdict.
    if (source === 'cookie' && state === 'suspected' && previous?.state === 'stale') state = 'stale'
    const account = state === 'verified' ? String(args.accountLabel ?? '').slice(0, 160) : null
    if (state === 'verified' && !account) throw new Error('verified account label required')
    const now = Date.now()
    const freshUntil = state === 'verified' ? now + 5 * 60_000 : null
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(`INSERT INTO site_identities(workspace_id,profile_id,origin,state,account_label,source,observed_at,verified_at,fresh_until)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,profile_id,origin) DO UPDATE SET
        state=excluded.state,account_label=excluded.account_label,source=excluded.source,
        observed_at=excluded.observed_at,verified_at=excluded.verified_at,fresh_until=excluded.fresh_until`)
        .run(dbScope.workspaceId, dbScope.profileId, origin, state, account, source, now,
          state === 'verified' ? now : null, freshUntil)
      db.prepare(`INSERT INTO auth_observations(workspace_id,profile_id,origin,state,source,account_label,observed_at,detail)
        VALUES(?,?,?,?,?,?,?,?)`).run(dbScope.workspaceId, dbScope.profileId, origin, state, source, account, now,
          args.detail ? String(args.detail).slice(0, 500) : null)
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    return { origin, state, accountLabel: account, source, observedAt: now, freshUntil }
  },

  authMarkStale() {
    const rows = db.prepare("SELECT origin FROM site_identities WHERE workspace_id=? AND profile_id=? AND state='verified'")
      .all(dbScope.workspaceId, dbScope.profileId)
    const now = Date.now()
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare("UPDATE site_identities SET state='stale', source='restore', observed_at=?, fresh_until=NULL WHERE workspace_id=? AND profile_id=? AND state='verified'")
        .run(now, dbScope.workspaceId, dbScope.profileId)
      const insert = db.prepare("INSERT INTO auth_observations(workspace_id,profile_id,origin,state,source,observed_at) VALUES(?,?,?,'stale','restore',?)")
      for (const row of rows) insert.run(dbScope.workspaceId, dbScope.profileId, row.origin, now)
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    return { stale: rows.length }
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
          if (column === 'workspace_id') return dbScope.workspaceId
          if (column === 'profile_id') return dbScope.profileId
          if (column === 'legacy_origin') return 'observed'
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
  appendBodyRefs(args) {
    return appendBodyRefs(args.inst, args.items || [])
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
          item.seq,
          norm(item.state) || 'none'
        )
        if (Number(info.changes) > 0) updated += 1
        else if (!S.getBodyState.get(inst, item.seq) && missing.length < 512) missing.push(item.seq)
        if (Number(info.changes) > 0) {
          if (item.hash) {
            db.prepare('INSERT INTO body_refs(workspace_id, profile_id, inst, seq, hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, profile_id, inst, seq) DO UPDATE SET hash = excluded.hash')
              .run(dbScope.workspaceId, dbScope.profileId, inst, item.seq, item.hash)
          } else {
            db.prepare('DELETE FROM body_refs WHERE workspace_id = ? AND profile_id = ? AND inst = ? AND seq = ?')
              .run(dbScope.workspaceId, dbScope.profileId, inst, item.seq)
          }
        }
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
  contentRefs(args) {
    return db.prepare('SELECT inst, seq, COALESCE(body_size, 0) AS size FROM requests WHERE body_hash = ?').all(norm(args.hash))
  },
  markRetainedDeleted(args) {
    const info = db.prepare("UPDATE requests SET body_state = 'retained_deleted' WHERE body_hash = ?").run(norm(args.hash))
    db.prepare('UPDATE bodies SET stored = 0, blob = NULL WHERE hash = ?').run(norm(args.hash))
    return { affected: Number(info.changes) }
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
          norm(item.ts) ?? Date.now(),
          norm(item.kind),
          norm(item.level) ?? 'info',
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
    const names = [
      'instances', 'requests', 'bodies', 'scripts', 'script_refs', 'events', 'ws_frames', 'contracts',
      // 站点资源那三张也跟着报：不然面板上「用了多少」是漏的
      'cookies', 'site_origins', 'site_snapshots'
    ]
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

  /* ---- 本轮新增：事件流 / WebSocket / 接口画像 / 调用图 / 关联 / 导出 / 契约 ---- */

  queryEvents,
  eventStats,

  /**
   * WS 帧入库。分帧方向是「相对浏览器」的：sent = 页面发出去。
   * payload 在采集侧已经按上限截断过，这里只负责落库，不再做二次裁剪。
   */
  appendWsFrames(args) {
    const items = args.items || []
    if (items.length === 0) return { inserted: 0 }
    const inst = args.inst
    db.exec('BEGIN')
    try {
      for (const item of items) {
        S.insertWsFrame.run(
          inst,
          norm(item.seq),
          norm(item.ts) ?? Date.now(),
          norm(item.requestId),
          norm(item.url),
          item.direction === 'sent' ? 'sent' : 'received',
          norm(item.opcode),
          norm(item.payload),
          norm(item.size),
          item.truncated ? 1 : 0,
          item.binary ? 1 : 0
        )
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    return { inserted: items.length }
  },

  queryWsFrames,
  wsConnections,

  endpointProfiles,
  endpointDetail,
  requestGraph,
  relations,

  exportHar,
  exportJsonl,
  exportBodies,

  cookieSync,
  cookieList,
  cookieStats,
  cookieRememberSent,
  siteOriginsSeen,
  siteUpsert(args) {
    const inst = norm(args.inst)
    const now = Number(args.now) || Date.now()
    const rows = args.rows || []
    db.exec('BEGIN')
    try {
      for (const row of rows) {
        S.upsertSiteOrigin.run(
          dbScope.workspaceId, dbScope.profileId,
          String(row.origin), now, now, inst,
          row.cookieCount ?? 0, row.localStorageCount ?? 0, row.localStorageBytes ?? 0,
          row.sessionStorageCount ?? 0, row.sessionStorageBytes ?? 0,
          JSON.stringify(row.idbNames ?? []), row.idbStores ?? 0,
          JSON.stringify(row.cacheNames ?? []), row.cacheEntries ?? 0, row.swCount ?? 0,
          norm(row.usageBytes), norm(row.quotaBytes), JSON.stringify(row.usageBreakdown ?? []),
          JSON.stringify(row.detail ?? null)
        )
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    return { saved: rows.length }
  },
  siteOverview,
  siteDetail,
  siteSnapshot,
  siteSnapshotList,
  siteSnapshotGet(args) {
    const found = loadSiteSnapshot(args.id)
    return found ? { found: true, id: found.id, label: found.label, createdAt: found.createdAt, doc: found.doc } : { found: false, id: norm(args.id) }
  },
  siteSnapshotDiff,
  siteSnapshotDelete,

  contractSnapshot,
  contractList,
  contractGet,
  contractDelete,
  contractDiff,
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
    if (msg.op !== 'open') {
      const requestedWorkspace = msg.args?.workspaceId
      const requestedProfile = msg.args?.profileId
      if ((requestedWorkspace !== undefined && requestedWorkspace !== dbScope.workspaceId) ||
          (requestedProfile !== undefined && requestedProfile !== dbScope.profileId)) {
        throw new Error('scope mismatch: requested workspace/profile does not own this database')
      }
    }
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
