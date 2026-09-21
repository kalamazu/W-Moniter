/**
 * 分析层落地：schema 7 + 事件流 / WS / 画像 / 调用图 / 导出 / 契约。
 * 大块代码放在 frag-*.mjs 里，这个 spec 只负责「插在哪」。
 */
import { readFileSync } from 'node:fs'

const analytics = readFileSync('work/frag-analytics.mjs', 'utf8')
const ops = readFileSync('work/frag-ops.mjs', 'utf8')

const DDL_EVENTS_OLD = [
  'CREATE TABLE IF NOT EXISTS events (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  inst INTEGER NOT NULL,',
  '  ts REAL NOT NULL,',
  '  kind TEXT NOT NULL,',
  '  target_type TEXT,',
  '  url TEXT,',
  '  detail TEXT',
  ');',
  '',
  'CREATE INDEX IF NOT EXISTS ix_events_inst_ts ON events (inst, ts);'
].join('\n')

const DDL_EVENTS_NEW = [
  'CREATE TABLE IF NOT EXISTS events (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  inst INTEGER NOT NULL,',
  '  ts REAL NOT NULL,',
  '  kind TEXT NOT NULL,',
  "  /* info / warn / error。事件流面板要能只看告警，别让详情里塞 */",
  "  level TEXT DEFAULT 'info',",
  '  target_type TEXT,',
  '  url TEXT,',
  '  detail TEXT',
  ');',
  '',
  'CREATE INDEX IF NOT EXISTS ix_events_inst_ts ON events (inst, ts);',
  '',
  '/*',
  ' * WebSocket / SSE 的帧。握手本身还是 requests 表里的一行（resourceType=WebSocket），',
  ' * 这里只放「握手之后双向跑的东西」—— 那部分 CDP 只在帧事件里给，别处拿不到。',
  ' * payload 对二进制帧是 base64（CDP 的约定），用 binary 列标出来，读的人不用猜。',
  ' */',
  'CREATE TABLE IF NOT EXISTS ws_frames (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  inst INTEGER NOT NULL,',
  '  seq INTEGER,',
  '  ts REAL NOT NULL,',
  '  request_id TEXT,',
  '  url TEXT,',
  '  direction TEXT NOT NULL,',
  '  opcode INTEGER,',
  '  payload TEXT,',
  '  size INTEGER,',
  '  truncated INTEGER DEFAULT 0,',
  '  binary INTEGER DEFAULT 0',
  ');',
  '',
  'CREATE INDEX IF NOT EXISTS ix_ws_inst_id ON ws_frames (inst, id);',
  'CREATE INDEX IF NOT EXISTS ix_ws_req ON ws_frames (inst, request_id);',
  '',
  '/*',
  ' * 接口契约快照。json 列存的是整份契约（端点 + 状态码 + 字段表 + 响应形状），',
  ' * 回归时拿它和「当前」比出增删 —— 存结构化查询条件而不是原始行，',
  ' * 是因为契约的意义就是「压缩成可比对的形式」。',
  ' */',
  'CREATE TABLE IF NOT EXISTS contracts (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  label TEXT,',
  '  inst INTEGER,',
  '  created_at INTEGER NOT NULL,',
  '  json TEXT NOT NULL',
  ');'
].join('\n')

export default [
  {
    file: 'storage/server.mjs',
    label: 'schema 7',
    old: 'const SCHEMA_VERSION = 6',
    new: 'const SCHEMA_VERSION = 7'
  },
  {
    file: 'storage/server.mjs',
    label: 'imports: writeFileSync / join',
    old: "import { mkdirSync, statSync } from 'node:fs'\nimport { dirname } from 'node:path'",
    new: "import { mkdirSync, statSync, writeFileSync } from 'node:fs'\nimport { dirname, join } from 'node:path'"
  },
  {
    file: 'storage/server.mjs',
    label: 'DDL: events.level + ws_frames + contracts',
    old: DDL_EVENTS_OLD,
    new: DDL_EVENTS_NEW
  },
  {
    file: 'storage/server.mjs',
    label: '迁移 events.level',
    old: "  for (const [column, decl] of PROXY_COLUMNS) ensureColumn(handle, 'requests', column, decl)",
    new: "  for (const [column, decl] of PROXY_COLUMNS) ensureColumn(handle, 'requests', column, decl)\n  // v7：事件流加了 level（info/warn/error），老库的 events 没有这一列\n  ensureColumn(handle, 'events', 'level', \"TEXT DEFAULT 'info'\")"
  },
  {
    file: 'storage/server.mjs',
    label: 'insertEvent 带 level + insertWsFrame',
    old: [
      '    insertEvent: db.prepare(',
      "      'INSERT INTO events (inst, ts, kind, target_type, url, detail) VALUES (?, ?, ?, ?, ?, ?)'",
      '    ),'
    ].join('\n'),
    new: [
      '    insertEvent: db.prepare(',
      "      'INSERT INTO events (inst, ts, kind, level, target_type, url, detail) VALUES (?, ?, ?, ?, ?, ?, ?)'",
      '    ),',
      '    insertWsFrame: db.prepare(',
      "      'INSERT INTO ws_frames (inst, seq, ts, request_id, url, direction, opcode, payload, size, truncated, binary) ' +",
      "        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'",
      '    ),'
    ].join('\n')
  },
  {
    file: 'storage/server.mjs',
    label: 'appendEvents 写 level',
    old: [
      '        S.insertEvent.run(',
      '          args.inst,',
      '          item.ts ?? Date.now(),',
      '          norm(item.kind),',
      '          norm(item.targetType),',
      '          norm(item.url),',
      '          norm(item.detail)',
      '        )'
    ].join('\n'),
    new: [
      '        S.insertEvent.run(',
      '          args.inst,',
      '          norm(item.ts) ?? Date.now(),',
      '          norm(item.kind),',
      "          norm(item.level) ?? 'info',",
      '          norm(item.targetType),',
      '          norm(item.url),',
      '          norm(item.detail)',
      '        )'
    ].join('\n')
  },
  {
    file: 'storage/server.mjs',
    label: 'storageSummary 认新表',
    old: "    const names = ['instances', 'requests', 'bodies', 'scripts', 'script_refs', 'events']",
    new: "    const names = ['instances', 'requests', 'bodies', 'scripts', 'script_refs', 'events', 'ws_frames', 'contracts']"
  },
  {
    file: 'storage/server.mjs',
    label: '插入分析层',
    old: 'const OPS = {',
    new: analytics + '\nconst OPS = {'
  },
  {
    file: 'storage/server.mjs',
    label: '插入 OPS 成员',
    old: '  flush() {\n    S.flush.run()',
    new: ops + '  flush() {\n    S.flush.run()'
  }
]