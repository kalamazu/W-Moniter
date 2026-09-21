#!/usr/bin/env node
/**
 * 分析层的协议级验收（不起浏览器）。
 *
 * 数据直接按列灌进存储进程，判据全部落在「算出来的东西对不对」上：
 * 端点画像的分位数、共享体的去重、调用图的边、HAR 的结构、
 * 契约回归的增删。采集端有没有把数据喂进来由 test-realtime.mjs 负责，
 * 两层分开，出问题时能立刻定位在哪一层。
 *
 *   node scripts/test-analytics.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = join(ROOT, 'storage', 'server.mjs')
const SCHEMA_VERSION = Number(readFileSync(SERVER, 'utf8').match(/const SCHEMA_VERSION = (\d+)/)?.[1])
if (!Number.isFinite(SCHEMA_VERSION)) throw new Error('从 storage/server.mjs 里读不到 SCHEMA_VERSION')

const results = []
async function check(name, fn) {
  try {
    // 回调可以是 async：这里必须 await，否则断言失败会变成未捕获的 rejection，
    // 面板上一片绿其实是假的（app-harness 里踩过同一个坑）
    const out = fn()
    if (out && typeof out.then === 'function') await out
    results.push({ name, ok: true })
    console.log(`  \u2713 ${name}`)
  } catch (err) {
    results.push({ name, ok: false, message: err.message })
    console.log(`  \u2717 ${name}\n      ${err.message}`)
  }
}

class StorageClient {
  constructor(child) {
    this.child = child
    this.nextId = 1
    this.pending = new Map()
    this.carry = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.consume(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => process.stderr.write('[server] ' + chunk))
  }

  consume(chunk) {
    const text = this.carry + chunk
    let start = 0
    let index = text.indexOf('\n', start)
    while (index !== -1) {
      const line = text.slice(start, index)
      if (line.length > 0) {
        const msg = JSON.parse(line)
        if (msg.id !== undefined && msg.id !== null) {
          const slot = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          if (slot) slot(msg)
        }
      }
      start = index + 1
      index = text.indexOf('\n', start)
    }
    this.carry = text.slice(start)
  }

  send(op, args = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`op ${op} 超时`))
      }, 30000)
      this.pending.set(id, (msg) => {
        clearTimeout(timer)
        if (msg.ok) resolve(msg.result)
        else reject(new Error(`${op}: ${msg.error}`))
      })
      this.child.stdin.write(JSON.stringify({ id, op, args }) + '\n')
    })
  }

  close() {
    this.child.stdin.end()
  }
}

function startServer() {
  return new StorageClient(spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] }))
}

const BASE = 1_700_000_000_000
const sha = (text) => createHash('sha256').update(text).digest('hex')

function rowOf(overrides) {
  const base = {
    seq: 0,
    key: 'sess1|0',
    request_id: 'r0',
    session_id: 'sess1',
    target_id: 'T1',
    target_type: 'page',
    frame_url: 'https://app.test/index.html',
    url: 'https://app.test/',
    host: 'app.test',
    scheme: 'https',
    path: '/',
    query: null,
    method: 'GET',
    resource_type: 'Document',
    initiator_type: 'other',
    initiator_stack: null,
    priority: 'High',
    status: 200,
    status_text: 'OK',
    mime_type: 'text/html',
    protocol: 'h2',
    remote_ip: '127.0.0.1',
    remote_port: 8080,
    req_headers: JSON.stringify({ accept: '*/*' }),
    resp_headers: JSON.stringify({ 'content-type': 'text/html' }),
    req_body: null,
    encoded_len: 100,
    decoded_len: 200,
    from_cache: 0,
    from_sw: 0,
    ttfb_ms: 20,
    duration_ms: 100,
    start_ts: BASE,
    end_ts: BASE + 100,
    failed: null,
    canceled: 0
  }
  const merged = { ...base, ...overrides }
  merged.end_ts = merged.start_ts + (merged.duration_ms ?? 0)
  return merged
}

const SCRIPT_STACK = JSON.stringify({
  type: 'script',
  url: 'https://cdn.test/app.js',
  lineNumber: 12,
  frames: [{ functionName: 'loadUser', url: 'https://cdn.test/app.js', lineNumber: 12, columnNumber: 4 }]
})

const JSON_BODY_A = '{"id":42,"name":"alpha"}'
const JSON_BODY_B = '{"id":43,"name":"bravo"}'
const JSON_BODY_C = '{"id":45,"name":"charlie","extra":true}'
const JS_BODY = 'window.__app = 1\n'

/** 逐条真值：seq → 期望的端点 key，用于交叉验证画像聚合 */
function buildRows() {
  return [
    rowOf({ seq: 1, url: 'https://api.test/user/42', path: '/user/42', host: 'api.test', resource_type: 'XHR', initiator_type: 'script', initiator_stack: SCRIPT_STACK, mime_type: 'application/json', status: 200, duration_ms: 100, ttfb_ms: 20, start_ts: BASE + 10 }),
    rowOf({ seq: 2, url: 'https://api.test/user/43', path: '/user/43', host: 'api.test', resource_type: 'XHR', initiator_type: 'script', initiator_stack: SCRIPT_STACK, mime_type: 'application/json', status: 200, duration_ms: 120, ttfb_ms: 25, start_ts: BASE + 20 }),
    rowOf({ seq: 3, url: 'https://api.test/user/44', path: '/user/44', host: 'api.test', resource_type: 'Fetch', initiator_type: 'script', initiator_stack: SCRIPT_STACK, mime_type: 'application/json', status: 500, status_text: 'Internal Server Error', failed: 'net::ERR_FAILED', duration_ms: 200, ttfb_ms: 180, start_ts: BASE + 30 }),
    rowOf({ seq: 4, url: 'https://api.test/user/42/posts?trace=T1&page=1', path: '/user/42/posts', query: 'trace=T1&page=1', host: 'api.test', method: 'POST', resource_type: 'XHR', initiator_type: 'script', initiator_stack: SCRIPT_STACK, mime_type: 'application/json', status: 201, status_text: 'Created', req_body: '{"title":"hello","tags":["a","b"]}', duration_ms: 60, start_ts: BASE + 40 }),
    rowOf({ seq: 5, url: 'https://api.test/user/43/posts?trace=T1&page=2', path: '/user/43/posts', query: 'trace=T1&page=2', host: 'api.test', method: 'POST', resource_type: 'XHR', initiator_type: 'script', initiator_stack: SCRIPT_STACK, mime_type: 'application/json', status: 201, status_text: 'Created', req_body: '{"title":"world","tags":["c"]}', duration_ms: 80, start_ts: BASE + 50 }),
    rowOf({ seq: 6, url: 'https://cdn.test/app.js', path: '/app.js', host: 'cdn.test', resource_type: 'Script', initiator_type: 'parser', mime_type: 'application/javascript', duration_ms: 30, start_ts: BASE + 60 }),
    rowOf({ seq: 7, url: 'https://cdn.test/vendor.8f3a2b1c.js', path: '/vendor.8f3a2b1c.js', host: 'cdn.test', resource_type: 'Script', initiator_type: 'parser', mime_type: 'application/javascript', duration_ms: 40, start_ts: BASE + 70 }),
    // 重定向：同一 request_id 两跳，且是同一个 URL 走 302 到最终地址
    rowOf({ seq: 8, url: 'https://api.test/redirect', path: '/redirect', host: 'api.test', request_id: 'R1', resource_type: 'Document', status: 302, status_text: 'Found', mime_type: 'text/html', resp_headers: JSON.stringify({ location: 'https://api.test/final' }), duration_ms: 15, start_ts: BASE + 80 }),
    rowOf({ seq: 9, url: 'https://api.test/final', path: '/final', host: 'api.test', request_id: 'R1', resource_type: 'Document', mime_type: 'application/json', duration_ms: 25, start_ts: BASE + 100 }),
    // 长 hex 段：模板化应该收成 {hex}
    rowOf({ seq: 10, url: 'https://api.test/item/9f8e7d6c5b4a39281706', path: '/item/9f8e7d6c5b4a39281706', host: 'api.test', resource_type: 'XHR', initiator_type: 'script', initiator_stack: SCRIPT_STACK, mime_type: 'application/json', duration_ms: 45, start_ts: BASE + 120 }),
    // 与 seq 4/5 共享同一个 query 取值，但属于另一个端点 —— 关联分析的判据
    rowOf({ seq: 11, url: 'https://api.test/beacon?trace=T1', path: '/beacon', query: 'trace=T1', host: 'api.test', resource_type: 'Ping', initiator_type: 'script', initiator_stack: SCRIPT_STACK, mime_type: 'application/json', duration_ms: 5, start_ts: BASE + 140 }),
    // 与 seq 6 共享同一份响应体（不同 URL）
    rowOf({ seq: 12, url: 'https://cdn2.test/app.js', path: '/app.js', host: 'cdn2.test', resource_type: 'Script', initiator_type: 'parser', mime_type: 'application/javascript', duration_ms: 35, start_ts: BASE + 160 })
  ]
}

/** seq → body 内容（真值），落库后由 setRequestBodies 挂上去 */
const BODY_OF = {
  1: JSON_BODY_A,
  2: JSON_BODY_B,
  3: '{"error":"boom"}',
  6: JS_BODY,
  12: JS_BODY,
  9: '{"ok":true}'
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'monitor-analytics-'))
  const dbPath = join(dir, 'monitor.db')
  const storage = startServer()
  await storage.send('open', { dbPath, config: { storeBodies: true } })

  const info = await storage.send('beginInstance', { url: 'https://app.test/', profile: 'L', kernel: 'chrome', kernelVersion: 'TEST' })
  const inst = info.instId

  const rows = buildRows()
  await storage.send('appendRequests', { inst, rows })

  const bodyItems = []
  const linkItems = []
  for (const [seqText, text] of Object.entries(BODY_OF)) {
    const seq = Number(seqText)
    const hash = sha(text)
    bodyItems.push({ seq, hash, size: Buffer.byteLength(text), trunc: false, b64: Buffer.from(text).toString('base64') })
    linkItems.push({ seq, state: 'stored', size: Buffer.byteLength(text), hash, trunc: false })
  }
  await storage.send('appendBodies', { inst, items: bodyItems })
  const linked = await storage.send('setRequestBodies', { inst, items: linkItems })

  console.log('\n--- schema 与迁移 ---')
  const summary = await storage.send('storageSummary', {})
  await check('schema 版本已升到 ' + SCHEMA_VERSION, () => {
    assert.equal(SCHEMA_VERSION, 8)
  })
  await check('新表 ws_frames / contracts / cookies / site_origins / site_snapshots 都在存储分区里', () => {
    const names = summary.tables.map((item) => item.name)
    for (const table of ['ws_frames', 'contracts', 'cookies', 'site_origins', 'site_snapshots']) {
      assert.ok(names.includes(table), '缺 ' + table)
    }
  })
  await check('body 关联全部落地（' + Object.keys(BODY_OF).length + ' 条）', () => {
    assert.equal(linked.updated, Object.keys(BODY_OF).length)
    assert.equal(linked.missing.length, 0)
  })

  console.log('\n--- 事件流 ---')
  const eventItems = [
    { ts: BASE + 5, kind: 'navigation', level: 'info', targetType: 'page', url: 'https://app.test/index.html', detail: { frameId: 'F1' } },
    { ts: BASE + 6, kind: 'console', level: 'error', targetType: 'page', url: 'https://app.test/index.html', detail: { text: 'boom', line: 3 } },
    { ts: BASE + 7, kind: 'websocket', level: 'info', targetType: 'page', url: 'wss://api.test/live', detail: { event: 'created' } }
  ]
  await storage.send('appendEvents', { inst, items: eventItems })
  const events = await storage.send('queryEvents', { inst, since: 0 })
  await check('事件落库并按 id 升序返回', () => {
    assert.equal(events.rows.length, 3)
    assert.deepEqual(events.rows.map((item) => item.kind), ['navigation', 'console', 'websocket'])
    assert.equal(events.rows[0].id < events.rows[2].id, true)
  })
  await check('detail 以结构返回（不是一串 JSON 文本）', () => {
    assert.deepEqual(events.rows[0].detail, { frameId: 'F1' })
    assert.equal(events.rows[1].level, 'error')
  })
  await check('since 游标只给增量', () => {
    const second = events.rows[1].id
    return storage.send('queryEvents', { inst, since: second }).then((more) => {
      assert.equal(more.rows.length, 1)
      assert.equal(more.rows[0].kind, 'websocket')
      assert.equal(more.nextSince, events.latest)
    })
  })
  await check('按 kind / level 过滤', () => storage.send('queryEvents', { inst, kinds: ['console'], level: 'error' }).then((hit) => {
    assert.equal(hit.rows.length, 1)
  }))
  const evStats = await storage.send('eventStats', { inst })
  await check('事件统计按 kind 分组', () => {
    assert.equal(evStats.total, 3)
    assert.equal(evStats.rows.length, 3)
  })

  console.log('\n--- WebSocket 帧 ---')
  const wsItems = [
    { seq: 4, ts: BASE + 200, requestId: 'WS1', url: 'wss://api.test/live', direction: 'sent', opcode: 1, payload: '{"subscribe":"ticker"}', size: 22, truncated: false, binary: false },
    { seq: 4, ts: BASE + 210, requestId: 'WS1', url: 'wss://api.test/live', direction: 'received', opcode: 1, payload: '{"ticker":1}', size: 13, truncated: false, binary: false },
    { seq: 4, ts: BASE + 220, requestId: 'WS1', url: 'wss://api.test/live', direction: 'received', opcode: 2, payload: 'AAECAw==', size: 4, truncated: true, binary: true },
    { seq: 4, ts: BASE + 230, requestId: 'WS2', url: 'wss://echo.test/s', direction: 'sent', opcode: 1, payload: 'ping', size: 4, truncated: false, binary: false }
  ]
  await storage.send('appendWsFrames', { inst, items: wsItems })
  const frames = await storage.send('queryWsFrames', { inst, since: 0 })
  await check('帧按方向/操作码落地', () => {
    assert.equal(frames.rows.length, 4)
    assert.equal(frames.rows[1].direction, 'received')
    assert.equal(frames.rows[2].opcodeName, 'binary')
    assert.equal(frames.rows[2].binary, true)
    assert.equal(frames.rows[2].truncated, true)
  })
  await check('帧增量游标可用', () => storage.send('queryWsFrames', { inst, since: frames.rows[0].id, direction: 'sent' }).then((sent) => {
    assert.equal(sent.rows.length, 1)
    assert.equal(sent.rows[0].payload, 'ping')
  }))
  await check('按连接汇总', () => storage.send('wsConnections', { inst }).then((conns) => {
    assert.equal(conns.rows.length, 2)
    const first = conns.rows.find((item) => item.requestId === 'WS1')
    assert.equal(first.frames, 3)
    assert.equal(first.sent, 1)
    assert.equal(first.received, 2)
    assert.equal(first.binaryFrames, 1)
    assert.equal(first.truncatedFrames, 1)
  }))

  console.log('\n--- 接口画像 ---')
  const profiles = await storage.send('endpointProfiles', { inst })
  const find = (key) => profiles.endpoints.find((item) => item.key === key)
  await check('路径模板化：/user/42 收成 {int}', () => {
    assert.ok(find('GET api.test/user/{int}'), '缺少 GET api.test/user/{int}：' + profiles.endpoints.map((item) => item.key).join(' | '))
    assert.ok(find('GET api.test/item/{hex}'), '缺少 {hex} 模板')
    assert.ok(find('GET cdn.test/vendor.{hash}.js'), '缺少 {hash} 模板')
  })
  await check('调用次数与状态分布', () => {
    const slot = find('GET api.test/user/{int}')
    assert.equal(slot.calls, 3)
    assert.deepEqual(slot.statuses, [{ key: '200', count: 2 }, { key: '500', count: 1 }])
    assert.equal(slot.failed, 1)
  })
  await check('耗时分位数 p50=120 / p95=200', () => {
    const slot = find('GET api.test/user/{int}')
    assert.equal(slot.durationMs.p50, 120)
    assert.equal(slot.durationMs.p95, 200)
    assert.equal(slot.durationMs.max, 200)
  })
  await check('query 参数分布（trace/page 各 2 次）', () => {
    const slot = find('POST api.test/user/{int}/posts')
    assert.equal(slot.calls, 2)
    const trace = slot.query.find((item) => item.name === 'trace')
    assert.equal(trace.count, 2)
    assert.equal(trace.required, true)
    assert.deepEqual(trace.values, ['T1'])
    assert.equal(slot.query.find((item) => item.name === 'page').count, 2)
  })
  await check('请求体字段分布（JSON body 解出 title/tags）', () => {
    const slot = find('POST api.test/user/{int}/posts')
    assert.equal(slot.requestBody.samples, 2)
    const names = slot.requestBody.fields.map((item) => item.name).sort()
    assert.deepEqual(names, ['tags', 'title'])
    assert.equal(slot.requestBody.kinds[0].key, 'json')
  })
  await check('画像总数与端点枚举一致（' + profiles.matched + ' 个模板）', () => {
    assert.equal(profiles.matched, profiles.endpoints.length)
    assert.ok(profiles.matched >= 7)
  })

  const detail = await storage.send('endpointDetail', { inst, key: 'GET api.test/user/{int}' })
  await check('端点详情：最近调用 + 响应 schema', () => {
    assert.equal(detail.found, true)
    assert.equal(detail.totalCalls, 3)
    assert.equal(detail.recent.length, 3)
    assert.ok(detail.responseSchema, '响应 schema 为空')
    // 三条响应体都是 JSON（500 那条是 {"error":"boom"}），所以样本数是 3 不是 2
    assert.equal(detail.responseSamples, 3)
    const names = Object.keys(detail.responseSchema.fields).sort()
    assert.deepEqual(names, ['error', 'id', 'name'])
    // 必现 vs 可选：seen 记的是「几个样本里有这个字段」，count 是样本总数。
    // 500 那条的 body 是 {"error":"boom"}，所以 id/name 只出现 2 次 → 会被判成可选。
    assert.equal(detail.responseSchema.count, 3)
    assert.equal(detail.responseSchema.fields.id.seen, 2)
    assert.equal(detail.responseSchema.fields.name.seen, 2)
    assert.equal(detail.responseSchema.fields.error.seen, 1)
    const byPath = new Map(detail.responseFields.map((item) => [item.path, item]))
    assert.equal(byPath.get('id').optional, true, 'id 只出现在 3 个样本里的 2 个，应判为可选')
    assert.equal(byPath.get('error').type, 'string')
    assert.equal(detail.responseSchema.fields.name.t, 'string')
    assert.equal(detail.responseSchema.fields.id.t, 'int')
    assert.equal(detail.recent[0].seq, 3, '最近一条应该是 seq 3')
  })

  console.log('\n--- 调用图与关联 ---')
  const graph = await storage.send('requestGraph', { inst })
  await check('调用图：脚本节点 → 端点节点有边', () => {
    const node = graph.nodes.find((item) => item.key === 'script|https://cdn.test/app.js')
    assert.ok(node, '缺少脚本节点')
    const edge = graph.edges.find((item) => item.from === node.key && item.to === 'endpoint|GET api.test/user/{int}')
    assert.ok(edge, '缺少脚本→端点边')
    assert.equal(edge.count, 3)
    assert.equal(edge.failures, 1)
    assert.ok(edge.avgMs > 0)
  })
  await check('文档节点从 frame_url 来（parser 发起）', () => {
    const node = graph.nodes.find((item) => item.kind === 'document')
    assert.ok(node, '缺少文档节点')
    const edge = graph.edges.find((item) => item.from === node.key && item.to === 'endpoint|GET cdn.test/app.js')
    assert.ok(edge, '缺少文档→脚本边')
  })
  await check('连通分量（功能簇）非空', () => {
    assert.ok(graph.clusters.length >= 1)
    assert.ok(graph.clusters[0].size >= 2)
  })

  const rel = await storage.send('relations', { inst })
  await check('共享响应体：同一份 JS 被两个 URL 用到', () => {
    const shared = rel.sharedBodies.find((item) => item.hash === sha(JS_BODY))
    assert.ok(shared, '没认出共享体')
    assert.equal(shared.refs, 2)
    assert.equal(shared.distinctUrls, 2)
  })
  await check('重定向链：同 request_id 两跳', () => {
    const chain = rel.redirectChains.find((item) => item.requestId === 'R1')
    assert.ok(chain, '没认出重定向链')
    assert.equal(chain.hops, 2)
    assert.deepEqual(chain.steps.map((item) => item.status), [302, 200])
  })
  await check('跨端点共享 query 取值（trace=T1）', () => {
    const param = rel.sharedParams.find((item) => item.name === 'trace' && item.value === 'T1')
    assert.ok(param, '没认出共享参数')
    assert.equal(param.endpointCount, 2)
  })

  console.log('\n--- 导出 ---')
  const har = await storage.send('exportHar', { inst })
  await check('HAR 落盘且是合法 JSON', () => {
    assert.ok(existsSync(har.path), '文件没写出来')
    const parsed = JSON.parse(readFileSync(har.path, 'utf8'))
    assert.equal(parsed.log.version, '1.2')
    assert.equal(parsed.log.entries.length, rows.length)
    assert.equal(parsed.log.creator.name, 'chromium-monitor')
    assert.ok(parsed.log.pages.length >= 1)
    for (const entry of parsed.log.entries) {
      assert.ok(!Number.isNaN(Date.parse(entry.startedDateTime)), 'startedDateTime 不可解析')
      assert.equal(typeof entry.time, 'number')
      assert.equal(typeof entry.request.method, 'string')
      assert.equal(typeof entry.response.status, 'number')
      for (const [key, value] of Object.entries(entry.timings)) {
        assert.equal(typeof value, 'number', 'timings.' + key + ' 不是数字')
      }
      for (const header of entry.request.headers.concat(entry.response.headers)) {
        assert.ok(!header.name.startsWith(':'), 'HAR 里不该有伪头 ' + header.name)
      }
    }
  })
  await check('HAR 带上了等待/接收分段与 queryString', () => {
    const parsed = JSON.parse(readFileSync(har.path, 'utf8'))
    const entry = parsed.log.entries.find((item) => item._monitor.seq === 1)
    assert.equal(entry.timings.wait, 20)
    assert.equal(entry.timings.receive, 80)
    assert.equal(entry.response.content.mimeType, 'application/json')
    assert.ok(entry.response.content.text.includes('alpha'), '响应正文没进 HAR')
    const posts = parsed.log.entries.find((item) => item._monitor.seq === 4)
    assert.deepEqual(posts.request.queryString, [{ name: 'trace', value: 'T1' }, { name: 'page', value: '1' }])
    assert.equal(posts.request.postData.mimeType, 'application/json')

  })

  const jsonl = await storage.send('exportJsonl', { inst })
  await check('JSONL 一行一条且可逐行解析', () => {
    const lines = readFileSync(jsonl.path, 'utf8').trim().split('\n')
    assert.equal(lines.length, rows.length)
    const first = JSON.parse(lines[0])
    assert.equal(first.method, 'GET')
    assert.ok(Array.isArray(first.responseHeaders))
  })

  const bodies = await storage.send('exportBodies', { inst })
  await check('资源采集：文件落盘 + 去重（同一份 JS 只写一次）', () => {
    assert.ok(existsSync(bodies.manifest), '没有 manifest')
    const manifest = JSON.parse(readFileSync(bodies.manifest, 'utf8'))
    assert.equal(manifest.files, bodies.files)
    const js = manifest.entries.find((item) => item.hash === sha(JS_BODY))
    assert.equal(js.refs, 2)
    assert.equal(js.urls.length, 2)
    assert.ok(existsSync(join(manifest.dir, js.file)), '文件不存在：' + js.file)
    assert.equal(readFileSync(join(manifest.dir, js.file), 'utf8'), JS_BODY)
  })
  await check('资源按类型分目录（image/script/json…）', () => {
    const manifest = JSON.parse(readFileSync(bodies.manifest, 'utf8'))
    const buckets = new Set(manifest.entries.map((item) => item.file.split('/')[0]))
    assert.ok(buckets.has('script'), '没有 script 目录')
    assert.ok(buckets.has('xhr') || buckets.has('json'), '没有按接口类型分目录')
  })

  console.log('\n--- 契约快照与回归 ---')
  const snap = await storage.send('contractSnapshot', { inst, label: 'v1' })
  await check('快照写入并给出端点计数', () => {
    assert.ok(snap.id > 0)
    assert.equal(snap.label, 'v1')
    assert.equal(snap.endpoints, profiles.matched)
  })
  await check('快照列表 / 取出', () => storage.send('contractList', {}).then((list) => {
    assert.equal(list.rows.length, 1)
    assert.equal(list.rows[0].id, snap.id)
    return storage.send('contractGet', { id: snap.id }).then((got) => {
      assert.equal(got.found, true)
      assert.equal(got.endpoints.length, snap.endpoints)
      const one = got.endpoints.find((item) => item.key === 'GET api.test/user/{int}')
      assert.deepEqual(one.statuses, ['200', '500'])
      assert.ok(one.responseSchema, '契约里没有响应形状')
    })
  }))

  // 变化：同一个接口多了一次带新字段的响应，另外出现一个新端点与一个新状态码
  const extra = [
    rowOf({ seq: 20, url: 'https://api.test/user/45', path: '/user/45', host: 'api.test', resource_type: 'XHR', initiator_type: 'script', initiator_stack: SCRIPT_STACK, mime_type: 'application/json', status: 200, duration_ms: 90, ttfb_ms: 15, start_ts: BASE + 500 }),
    rowOf({ seq: 21, url: 'https://api.test/user/42', path: '/user/42', host: 'api.test', method: 'DELETE', resource_type: 'Fetch', initiator_type: 'script', initiator_stack: SCRIPT_STACK, mime_type: 'application/json', status: 204, status_text: 'No Content', duration_ms: 30, start_ts: BASE + 510 })
  ]
  await storage.send('appendRequests', { inst, rows: extra })
  const extraHash = sha(JSON_BODY_C)
  await storage.send('appendBodies', { inst, items: [{ seq: 20, hash: extraHash, size: Buffer.byteLength(JSON_BODY_C), trunc: false, b64: Buffer.from(JSON_BODY_C).toString('base64') }] })
  await storage.send('setRequestBodies', { inst, items: [{ seq: 20, state: 'stored', size: Buffer.byteLength(JSON_BODY_C), hash: extraHash, trunc: false }] })

  const diff = await storage.send('contractDiff', { inst, baseId: snap.id })
  await check('回归：新增端点被认出来', () => {
    assert.deepEqual(diff.added.map((item) => item.key), ['DELETE api.test/user/{int}'])
    assert.equal(diff.summary.addedEndpoints, 1)
  })
  await check('回归：字段级变化（响应里多了 extra）', () => {
    const changed = diff.changed.find((item) => item.key === 'GET api.test/user/{int}')
    assert.ok(changed, '没认出字段变化：' + JSON.stringify(diff.changed.map((item) => item.key)))
    assert.deepEqual(changed.response.added.map((item) => item.path), ['extra'])
    assert.equal(changed.response.added[0].type, 'bool')
    assert.ok(diff.summary.newResponseFields.includes('GET api.test/user/{int} extra'))
  })
  await check('回归：新增状态码 204', () => {
    assert.ok(diff.summary.newStatusCodes.includes('204'))
  })
  await check('回归：调用次数变化也报出来', () => {
    const changed = diff.changed.find((item) => item.key === 'GET api.test/user/{int}')
    assert.equal(changed.callsBefore, 3)
    assert.equal(changed.callsAfter, 4)
  })
  await check('回归：没变的端点计数正确（总数 - 新增 - 变化）', () => {
    assert.equal(diff.summary.changedEndpoints + diff.summary.unchangedEndpoints + diff.summary.addedEndpoints, diff.current.endpoints)
  })
  await check('删除快照', () => storage.send('contractDelete', { id: snap.id }).then((gone) => {
    assert.equal(gone.deleted, 1)
    return storage.send('contractList', {}).then((list) => assert.equal(list.rows.length, 0))
  }))

  console.log('\n--- 站点资源：cookie 罐对账 / 站点清单 / 快照回归 ---')

  // 罐里的事一律「问浏览器再对账」：这里直接喂罐的内容，验的是对账这一步算得对不对
  const jarCookie = {
    name: 'sid',
    value: 'v1',
    domain: '.a.test',
    host: 'a.test',
    path: '/',
    session: true,
    secure: true,
    sameSite: 'Lax',
    size: 12
  }
  const sync1 = await storage.send('cookieSync', { inst, now: Date.now(), cookies: [jarCookie] })
  await check('对账第一趟：全是新增，主键口径是 domain|path|name|partition', () => {
    assert.equal(sync1.added, 1)
    assert.equal(sync1.changed, 0)
    assert.equal(sync1.removed, 0)
    assert.equal(sync1.changes[0].action, 'added')
    // 前导点要去掉，不然 .a.test 与 a.test 会被当成两条
    assert.equal(sync1.changes[0].domain, 'a.test')
  })

  const sync2 = await storage.send('cookieSync', {
    inst,
    now: Date.now(),
    cookies: [{ ...jarCookie, value: 'v2' }],
    attribution: [{ url: 'https://a.test/login', names: ['sid'] }]
  })
  await check('对账第二趟：值变了 → changed，且归因到那条响应 URL', () => {
    assert.equal(sync2.added, 0)
    assert.equal(sync2.changed, 1)
    assert.equal(sync2.changes[0].action, 'changed')
    assert.equal(sync2.changes[0].source, 'set-cookie')
    assert.equal(sync2.changes[0].url, 'https://a.test/login')
  })

  const sync3 = await storage.send('cookieSync', { inst, now: Date.now(), cookies: [{ ...jarCookie, value: 'v2' }] })
  await check('对账第三趟：一摸一样 → 只 touch，不报变化', () => {
    assert.equal(sync3.added + sync3.changed + sync3.removed, 0)
    assert.equal(sync3.touched, 1)
  })

  const sync4 = await storage.send('cookieSync', { inst, now: Date.now(), cookies: [] })
  await check('对账第四趟：罐里没了 → removed', () => {
    assert.equal(sync4.removed, 1)
    assert.equal(sync4.changes[0].reason, 'gone')
  })

  // 再种四条：两条同名不同域（跟踪器特征）、一条会被带去别的站、一条分区 cookie
  await storage.send('cookieSync', {
    inst,
    now: Date.now(),
    cookies: [
      { ...jarCookie, value: 'v3' },
      { name: 'tid', value: 'zzz', domain: '.tracker.test', host: 'tracker.test', path: '/', expires: 1900000000, size: 30 },
      { name: '_ga', value: 'GA1.1', domain: '.a.test', host: 'a.test', path: '/', expires: 1900000000, size: 20 },
      { name: '_ga', value: 'GA2.2', domain: '.b.test', host: 'b.test', path: '/', expires: 1900000000, size: 22 },
      { name: 'chips', value: 'p1', domain: '.a.test', host: 'a.test', path: '/', partitionKey: 'top.example', size: 8 }
    ]
  })

  const cookieRows = await storage.send('cookieList', { query: { limit: 20 } })
  await check('cookieList：分区 cookie 单独认，同名不同域各算一条', () => {
    assert.equal(cookieRows.total, 5)
    const chips = cookieRows.rows.find((row) => row.name === 'chips')
    assert.equal(chips.partitionKey, 'top.example')
    assert.equal(chips.key, 'a.test|/|chips|top.example')
    assert.equal(cookieRows.rows.filter((row) => row.name === '_ga').length, 2)
  })

  const filtered = await storage.send('cookieList', { query: { name: '_ga', partitioned: false, limit: 20 } })
  await check('cookieList：按名字过滤，且 partitioned 条件能排除分区 cookie', () => {
    assert.equal(filtered.rows.length, 2)
    assert.ok(filtered.rows.every((row) => !row.partitionKey))
  })

  const cookieStats = await storage.send('cookieStats', { now: Date.now() })
  await check('cookieStats：分类之和 = 总数，同名跨域能认出来', () => {
    assert.equal(cookieStats.total, 5)
    assert.equal(cookieStats.session + cookieStats.persistent, cookieStats.total)
    assert.equal(cookieStats.partitioned, 1)
    assert.equal(cookieStats.secure, 1)
    // bySameSite 是按表达式分组的：它曾经和 cookies 自己的 key 列撞过名
    const bySameSite = cookieStats.bySameSite.reduce((sum, row) => sum + row.count, 0)
    assert.equal(bySameSite, cookieStats.total)
    const shared = cookieStats.sharedNames.find((row) => row.name === '_ga')
    assert.ok(shared, '同名跨域没认出来：' + JSON.stringify(cookieStats.sharedNames))
    assert.equal(shared.hosts, 2)
  })

  await storage.send('cookieRememberSent', {
    items: [
      { key: 'a.test|/|sid|', host: 'tracker.test' },
      { key: 'a.test|/|sid|', host: 'a.test' }
    ]
  })
  const crossRows = await storage.send('cookieList', { query: { crossSite: true, limit: 20 } })
  await check('「跨站使用过」＝用过它的站点既不是它自己、也不是它的子域', () => {
    assert.equal(crossRows.rows.length, 1)
    assert.equal(crossRows.rows[0].name, 'sid')
    assert.equal(crossRows.rows[0].sentCount, 1)
    assert.deepEqual(crossRows.rows[0].sentHosts.sort(), ['a.test', 'tracker.test'])
  })

  const stats2 = await storage.send('cookieStats', { now: Date.now() })
  await check('cookieStats.mostSent 按「被带出去最多」排序', () => {
    assert.equal(stats2.crossSite, 1)
    assert.equal(stats2.mostSent[0].name, 'sid')
    assert.equal(stats2.mostSent[0].sentCount, 1)
  })

  const siteDetailDoc = {
    localStorage: [
      { key: 'k1', value: 'v1', bytes: 2 },
      { key: 'k2', value: 'v2', bytes: 2 }
    ],
    sessionStorage: [],
    idb: [{ name: 'db1', version: 1, objectStores: [{ name: 's1', keyPath: 'id', indexes: [] }] }],
    caches: [{ name: 'c1', count: 2, entries: [{ url: 'https://a.test/app.js', size: 10 }] }],
    serviceWorkers: [{ scopeURL: 'https://a.test/', isDeleted: false }]
  }
  await storage.send('siteUpsert', {
    inst,
    rows: [
      {
        origin: 'https://a.test',
        localStorageCount: 2,
        localStorageBytes: 4,
        idbNames: ['db1'],
        idbStores: 1,
        cacheNames: ['c1'],
        cacheEntries: 2,
        swCount: 1,
        usageBytes: 1234,
        quotaBytes: 999999,
        usageBreakdown: [{ storageType: 'indexeddb', usage: 100 }],
        detail: siteDetailDoc
      }
    ]
  })
  const overview = await storage.send('siteOverview', { inst, limit: 10 })
  await check('siteOverview：扫过的域带全部计数', () => {
    const row = overview.rows.find((item) => item.origin === 'https://a.test')
    assert.ok(row, '没有 a.test：' + JSON.stringify(overview.rows.map((item) => item.origin)))
    assert.equal(row.scanned, true)
    assert.equal(row.localStorageCount, 2)
    assert.deepEqual(row.cacheNames, ['c1'])
    assert.equal(row.swCount, 1)
  })
  async function siteDetailCheck() {
    const detail = await storage.send('siteDetail', { origin: 'https://a.test' })
    assert.equal(detail.localStorage.length, 2)
    assert.equal(detail.idb[0].objectStores[0].keyPath, 'id')
    assert.equal(detail.caches[0].entries[0].url, 'https://a.test/app.js')
    assert.equal(detail.serviceWorkers.length, 1)
    // 这个域的 cookie 也要一起带出来（sid / _ga / chips 都是 .a.test 的）
    assert.ok(detail.cookies.some((cookie) => cookie.name === 'sid'), '明细里没有该域的 cookie')
  }
  await check('siteDetail：明细是完整的（存储 + 该域 cookie）', siteDetailCheck)

  await check('siteDetail：没扫过的域也给一份空壳，不是 null', () => {
    return storage.send('siteDetail', { origin: 'https://never-scanned.test' }).then((detail) => {
      assert.equal(detail.origin, 'https://never-scanned.test')
      assert.equal(detail.scanned, false)
      assert.deepEqual(detail.localStorage, [])
    })
  })

  const siteSnap = await storage.send('siteSnapshot', { inst, label: 'sd-base' })
  await check('siteSnapshot：给出域数 / cookie 数 / 体积', () => {
    assert.ok(siteSnap.id > 0)
    assert.equal(siteSnap.label, 'sd-base')
    assert.ok(siteSnap.origins >= 1)
    assert.equal(siteSnap.cookies, 5)
  })

  // 改三样：同一个键换值（keysChanged）、加一个键（keysAdded）、加一条 cookie
  await storage.send('siteUpsert', {
    inst,
    rows: [
      {
        origin: 'https://a.test',
        localStorageCount: 3,
        localStorageBytes: 8,
        idbNames: [],
        idbStores: 0,
        cacheNames: [],
        cacheEntries: 0,
        swCount: 0,
        detail: {
          ...siteDetailDoc,
          localStorage: [
            { key: 'k1', value: 'CHANGED', bytes: 7 },
            { key: 'k3', value: 'v3', bytes: 2 }
          ]
        }
      }
    ]
  })
  await storage.send('cookieSync', {
    inst,
    now: Date.now(),
    cookies: [{ name: 'fresh', value: 'f1', domain: '.a.test', host: 'a.test', path: '/', session: true, size: 6 }]
  })

  const siteDiff = await storage.send('siteSnapshotDiff', { baseId: siteSnap.id })
  await check('siteSnapshotDiff：新增的域 / 新增的 cookie 都报出来', () => {
    assert.equal(siteDiff.summary.cookiesAdded, 1)
    // 对账是「整罐替换」语义：这一趟只喂了 fresh，之前那 5 条就都算消失
    assert.equal(siteDiff.summary.cookiesRemoved, 5)
    assert.ok(siteDiff.cookies.added.some((cookie) => cookie.name === 'fresh'))
  })
  await check('siteSnapshotDiff：localStorage 的「新增 / 消失 / 内容变了」三件事分得开', () => {
    // k3 是新的，k2 没了，k1 换了值 —— 三种情况各归各的桶
    assert.ok(siteDiff.localStorage.added.some((key) => key.includes('k3')), JSON.stringify(siteDiff.localStorage))
    assert.ok(siteDiff.localStorage.removed.some((key) => key.includes('k2')), JSON.stringify(siteDiff.localStorage))
    assert.ok(siteDiff.localStorage.changed.some((key) => key.includes('k1')), JSON.stringify(siteDiff.localStorage))
    assert.equal(siteDiff.summary.keysAdded, 1)
    assert.equal(siteDiff.summary.keysRemoved, 1)
    assert.equal(siteDiff.summary.keysChanged, 1)
  })

  const siteSnapList = await storage.send('siteSnapshotList', { limit: 5 })
  await check('siteSnapshotList：刚拍的那份在列表里', () => {
    assert.ok(siteSnapList.rows.some((row) => row.id === siteSnap.id))
  })

  const siteSnapDel = await storage.send('siteSnapshotDelete', { id: siteSnap.id })
  await check('siteSnapshotDelete：删掉快照', () => {
    assert.equal(siteSnapDel.deleted, 1)
  })
  console.log('\n--- 老库迁移（v6 的 events 没有 level 列）---')
  await storage.send('close')
  storage.close()
  await new Promise((resolve) => setTimeout(resolve, 300))

  const raw = new DatabaseSync(dbPath)
  raw.exec('ALTER TABLE events DROP COLUMN level')
  const columns = raw.prepare('PRAGMA table_info(events)').all().map((item) => item.name)
  raw.close()
  await check('测试前提成立：level 列已被删掉', () => {
    assert.ok(!columns.includes('level'))
    assert.ok(columns.includes('kind'))
  })

  const reopened = startServer()
  const opened = await reopened.send('open', { dbPath })
  const migrated = await reopened.send('queryEvents', { inst, limit: 10 })
  await check('重开后 schema ' + SCHEMA_VERSION + ' 且自动补回 level 列', () => {
    assert.equal(opened.schemaVersion, SCHEMA_VERSION)
    assert.equal(migrated.rows.length, 3)
    // 列是被 DROP 掉的，老行的值本来就没了 —— 补列后走 DEFAULT，
    // 这里要的正是「补上了、且默认值合理」，而不是「旧值凭空回来」
    assert.equal(migrated.rows[1].level, 'info')
  })
  await reopened.send('appendEvents', { inst, items: [{ kind: 'console', level: 'warn', url: 'https://app.test/', detail: 'after-migration' }] })
  const afterMigration = await reopened.send('queryEvents', { inst, level: 'warn' })
  await check('迁移后新事件仍能按 level 写入与过滤', () => {
    assert.equal(afterMigration.rows.length, 1)
    assert.equal(afterMigration.rows[0].level, 'warn')
    assert.equal(afterMigration.rows[0].detail, 'after-migration')
  })
  await reopened.send('close')
  reopened.close()

  await new Promise((resolve) => setTimeout(resolve, 200))
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* Windows 上偶发占用，忽略 */
  }

  const failed = results.filter((item) => !item.ok).length
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n测试崩溃:', err)
  process.exit(1)
})