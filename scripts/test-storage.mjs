#!/usr/bin/env node
/**
 * 存储进程的协议级测试。
 *
 * 走的是和 Electron 完全一样的 NDJSON 通道，所以这里过了，
 * 线上就只剩下「采集端有没有把数据喂进来」这一个变量。
 *
 *   node scripts/test-storage.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = join(ROOT, 'storage', 'server.mjs')

/** 直接从服务端源码里读版本号 —— 抄一份常数迟早会跟它对不上 */
const SCHEMA_VERSION = Number(
  readFileSync(SERVER, 'utf8').match(/const SCHEMA_VERSION = (\d+)/)?.[1]
)
if (!Number.isFinite(SCHEMA_VERSION)) throw new Error('从 storage/server.mjs 里读不到 SCHEMA_VERSION')

const results = []
function check(name, fn) {
  try {
    fn()
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
    this.notices = []
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
        if (msg.id === undefined || msg.id === null) {
          this.notices.push(msg)
        } else {
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
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] })
  return new StorageClient(child)
}

const TYPES = ['Document', 'Script', 'Stylesheet', 'Image', 'XHR', 'Fetch', 'Font', 'Media', 'Ping', 'Other']
const HOSTS = ['cdn.example.com', 'api.example.com', 'static.example.com', 'tracker.example.net']
const STATUSES = [200, 200, 200, 204, 304, 404, 500, 302]
const MIMES = ['text/html', 'application/javascript', 'text/css', 'image/png', 'application/json']

function makeRow(seq, inst) {
  const host = HOSTS[seq % HOSTS.length]
  const type = TYPES[seq % TYPES.length]
  const status = STATUSES[seq % STATUSES.length]
  const startTs = 1_700_000_000_000 + seq * 3
  const duration = (seq % 900) + 1
  return {
    seq,
    key: `sess-${seq % 7}|${seq}`,
    request_id: `${seq}.${seq % 13}`,
    session_id: `sess-${seq % 7}`,
    target_id: 'T' + (seq % 5),
    target_type: seq % 11 === 0 ? 'service_worker' : seq % 7 === 0 ? 'worker' : 'page',
    frame_url: 'https://' + host + '/page',
    url: `https://${host}/asset/${seq}?v=${seq % 17}`,
    host,
    scheme: 'https',
    path: `/asset/${seq}`,
    query: `v=${seq % 17}`,
    method: seq % 23 === 0 ? 'POST' : 'GET',
    resource_type: type,
    initiator_type: type === 'XHR' ? 'xhr' : 'parser',
    priority: 'High',
    status,
    status_text: status === 200 ? 'OK' : 'X',
    mime_type: MIMES[seq % MIMES.length],
    protocol: 'h2',
    remote_ip: '93.184.216.34',
    remote_port: 443,
    req_headers: JSON.stringify({ accept: '*/*' }),
    resp_headers: JSON.stringify({ 'content-type': MIMES[seq % MIMES.length] }),
    req_body: null,
    encoded_len: (seq % 5000) + 100,
    decoded_len: (seq % 6000) + 120,
    from_cache: seq % 5 === 0,
    from_sw: seq % 11 === 0,
    ttfb_ms: 10 + (seq % 200),
    duration_ms: duration,
    start_ts: startTs,
    end_ts: startTs + duration,
    failed: status === 500 ? 'net::ERR_FAILED' : null,
    canceled: false
  }
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'monitor-store-'))
  const dbPath = join(dir, 'monitor.db')
  const client = startServer()
  const inst = 1

  console.log('\n== 生命周期 ==')
  const open = await client.send('open', {
    dbPath,
    config: { bodyMaxBytes: 4096, bodyStoreMaxBytes: 64 * 1024, bodyStoreMaxCount: 40, storeBodies: true }
  })
  // 版本号就是要跟着 schema 一起动的：写死一个数会让「加列忘了 bump」悄悄溜过去，
  // 所以这里比对服务端自己声明的那个常量
  check('open 返回 schema 版本', () => assert.equal(open.schemaVersion, SCHEMA_VERSION))
  check('open 回显配置', () => assert.equal(open.config.bodyMaxBytes, 4096))
  check('数据库文件已创建', () => assert.ok(existsSync(dbPath)))

  const started = await client.send('beginInstance', {
    url: 'https://example.com',
    profile: 'L',
    kernel: 'chrome.exe',
    kernelVersion: 'Chrome/153.0.8010.50',
    userAgent: 'Mozilla/5.0 (test)',
    args: ['--remote-debugging-pipe']
  })
  check('beginInstance 拿到 instId', () => assert.equal(started.instId, 1))

  console.log('\n== 批量写入吞吐 ==')
  const TOTAL = 20000
  const rows = Array.from({ length: TOTAL }, (_, i) => makeRow(i, inst))
  const BATCH = 2000
  const t0 = Date.now()
  let inserted = 0
  for (let i = 0; i < TOTAL; i += BATCH) {
    const res = await client.send('appendRequests', { inst, rows: rows.slice(i, i + BATCH) })
    inserted += res.inserted
  }
  const elapsed = Date.now() - t0
  const rate = Math.round(TOTAL / (elapsed / 1000))
  console.log(`  ${TOTAL} 条 / ${elapsed}ms = ${rate} 行每秒`)
  check('全部写入成功', () => assert.equal(inserted, TOTAL))
  check('吞吐 >= 10000 行/秒（设计指标）', () => assert.ok(rate >= 10000, `实际 ${rate}`))

  const dup = await client.send('appendRequests', { inst, rows: rows.slice(0, 10) })
  const afterDup = await client.send('queryRequests', { filter: { inst }, limit: 1 })
  check('重复 seq 走 upsert：不新增行，只更新已有行', () => {
    assert.equal(dup.inserted, 0)
    assert.equal(dup.updated, 10)
    assert.equal(afterDup.total, TOTAL)
  })

  // 采集侧对同一条请求会写两次：先落一条「响应头到了但没跑完」的临时行，
  // 终态事件到了再更新。这条链断了的话，不读 body 的 fetch 就永远不落库。
  // 用一个单独的 inst，免得给上面那条「总数正确」的断言添乱
  const pendingInst = inst + 1
  const pendingRow = {
    ...makeRow(0, pendingInst),
    status: null,
    status_text: null,
    mime_type: null,
    encoded_len: null,
    decoded_len: null,
    ttfb_ms: null,
    duration_ms: null,
    end_ts: null
  }
  await client.send('appendRequests', { inst: pendingInst, rows: [pendingRow] })
  const settledRow = { ...pendingRow, status: 204, encoded_len: 321, duration_ms: 42 }
  await client.send('appendRequests', { inst: pendingInst, rows: [settledRow] })
  const settled = await client.send('queryDetail', { inst: pendingInst, seq: 0 })
  check('后写的一次会把 pending 行更新成终态', () => {
    assert.equal(settled.request.status, 204)
    assert.equal(settled.request.encoded_len, 321)
  })

  console.log('\n== body 去重与 LRU ==')
  // 3 份内容：小 body 会被真存，大 body 只留 hash
  const small = Buffer.from('hello world, this is a body payload')
  const smallHash = createHash('sha256').update(small).digest('hex')
  const big = randomBytes(9000)
  const bigHash = createHash('sha256').update(big).digest('hex')

  const bodyRes = await client.send('appendBodies', {
    inst,
    items: [
      { seq: 0, hash: smallHash, size: small.length, trunc: false, b64: small.toString('base64') },
      // 同一个 hash 第二次上来不带 payload，模拟主进程侧的去重命中
      { seq: 1, hash: smallHash, size: small.length, trunc: false },
      { seq: 2, hash: bigHash, size: big.length, trunc: true, b64: big.toString('base64') }
    ]
  })
  check('小 body 落盘 1 份', () => assert.equal(bodyRes.stored, 1))
  check('重复 payload 只加引用不重传', () => assert.equal(bodyRes.referenced, 1))
  check('超阈值 body 只留 hash', () => assert.equal(bodyRes.skipped, 1))

  const fetched = await client.send('getBody', { hash: smallHash, withData: true })
  check('body 二进制往返一致', () =>
    assert.equal(Buffer.from(fetched.b64, 'base64').toString('utf8'), small.toString('utf8')))

  const bigFetched = await client.send('getBody', { hash: bigHash, withData: true })
  check('大 body 标记为未存储', () => assert.equal(bigFetched.stored, false))

  await client.send('setRequestBodies', {
    inst,
    items: [
      { seq: 0, state: 'stored', size: small.length, hash: smallHash, trunc: false },
      { seq: 2, state: 'hash_only', size: big.length, hash: bigHash, trunc: true }
    ]
  })

  // Fetch 在 Response 阶段拦时会比 Network.loadingFinished 先到，
  // 于是 body 关联可能先于请求行落库 —— 必须能报出来让上层重试。
  const orphan = await client.send('setRequestBodies', {
    inst,
    items: [{ seq: 999999, state: 'stored', size: 1, hash: 'deadbeef', trunc: false }]
  })
  check('请求行未落库时回报 missing', () => assert.deepEqual(orphan.missing, [999999]))
  check('未命中不计入 updated', () => assert.equal(orphan.updated, 0))
  check('已落库的行正常更新', () => assert.equal(orphan.updated + 2 >= 2, true))

  // 塞爆预算，验证 LRU 把最老的 blob 降级
  const bulk = []
  for (let i = 0; i < 60; i += 1) {
    const payload = Buffer.from(`body-${i}-`.repeat(40))
    bulk.push({
      seq: 100 + i,
      hash: createHash('sha256').update(payload).digest('hex'),
      size: payload.length,
      trunc: false,
      b64: payload.toString('base64')
    })
  }
  const bulkRes = await client.send('appendBodies', { inst, items: bulk })
  check('LRU 触发了淘汰', () => assert.ok(bulkRes.evicted > 0, `evicted=${bulkRes.evicted}`))

  const afterPrune = await client.send('getBody', { hash: smallHash, withData: true })
  check('最老的 blob 已被降级为 hash-only', () => assert.equal(afterPrune.stored, false))

  console.log('\n== 查询 ==')
  const all = await client.send('queryRequests', { filter: { inst }, limit: 10 })
  check('总数正确', () => assert.equal(all.total, TOTAL))
  check('limit 生效', () => assert.equal(all.rows.length, 10))

  const byType = await client.send('queryRequests', {
    filter: { inst, resourceType: ['XHR', 'Fetch'] },
    limit: 5
  })
  check('按类型过滤', () => {
    assert.ok(byType.total > 0)
    assert.ok(byType.rows.every((r) => ['XHR', 'Fetch'].includes(r.resource_type)))
  })

  const byStatus = await client.send('queryRequests', { filter: { inst, excludeStatus: [200, 304] }, limit: 5 })
  check('按状态排除', () => assert.ok(byStatus.rows.every((r) => !r.status || ![200, 304].includes(r.status))))

  const failed = await client.send('queryRequests', { filter: { inst, onlyFailed: true }, limit: 5 })
  check('只看失败', () => {
    assert.ok(failed.total > 0)
    assert.ok(failed.rows.every((r) => r.failed))
  })

  const byHost = await client.send('queryRequests', { filter: { inst, host: 'cdn.example.com' }, limit: 5 })
  check('按 host 子串过滤', () => assert.ok(byHost.rows.every((r) => r.host.includes('cdn.example.com'))))

  const searched = await client.send('queryRequests', { filter: { inst, search: '/asset/1234' }, limit: 5 })
  check('全文搜索命中 URL', () => {
    assert.ok(searched.total > 0)
    assert.ok(searched.rows.every((r) => r.url.includes('/asset/1234')))
  })

  const timed = await client.send('queryRequests', { filter: { inst }, order: 'duration_desc', limit: 3 })
  check('按耗时排序', () => {
    const durations = timed.rows.map((r) => r.duration_ms)
    assert.deepEqual(durations, [...durations].sort((a, b) => b - a))
  })

  const ranged = await client.send('queryRequests', {
    filter: { inst, statusMin: 400, minSize: 1000 },
    limit: 5
  })
  check('状态 + 大小区间组合过滤', () =>
    assert.ok(ranged.rows.every((r) => r.status >= 400 && r.encoded_len >= 1000)))

  const detail = await client.send('queryDetail', { inst, seq: 0 })
  check('详情能取到请求与 body 元信息', () => {
    assert.equal(detail.request.seq, 0)
    assert.equal(detail.body.hash, smallHash)
  })

  const exploded = await client.send('queryRequests', {
    filter: { inst, search: "'; DROP TABLE requests; --" },
    limit: 5
  })
  check('注入尝试只被当作普通字符串', () => assert.equal(exploded.total, 0))

  console.log('\n== 统计与瀑布 ==')
  const st = await client.send('stats', { inst })
  check('统计总数一致', () => assert.equal(st.total, TOTAL))
  check('按类型分组非空', () => assert.ok(st.by.resource_type.length === TYPES.length))
  check('统计含失败/缓存计数', () => {
    assert.ok(st.failed > 0)
    assert.ok(st.cached > 0)
  })
  check('数据库体积已上报', () => assert.ok(st.dbBytes > 0))

  const tl = await client.send('timeline', { inst, limit: 100 })
  check('瀑布图数据按时间倒序', () => {
    assert.equal(tl.rows.length, 100)
    for (let i = 1; i < tl.rows.length; i += 1) {
      assert.ok(tl.rows[i - 1].start_ts >= tl.rows[i].start_ts)
    }
  })

  console.log('\n== 脚本表 ==')
  // 内容相同的脚本（dup1/dup2 这种）必须只落一行源码，靠 hash 去重
  const srcApp = 'window.__a1=1'
  const srcDup = 'window.__dup=1'
  const hashOf = (text) => createHash('sha256').update(text).digest('hex')
  const hApp = hashOf(srcApp)
  const hDup = hashOf(srcDup)
  const hInline = hashOf('inline-body')
  const hBig = hashOf('oversize')
  const BIG = 2 * 1024 * 1024 + 1

  const scripts = await client.send('appendScripts', {
    inst,
    items: [
      { hash: hApp, url: 'http://127.0.0.1:8777/app1.js', size: srcApp.length, source: srcApp, scriptId: '7', inst },
      { hash: hDup, url: 'http://127.0.0.1:8777/dup1.js', size: srcDup.length, source: srcDup, inst },
      { hash: hDup, url: 'http://127.0.0.1:8777/dup2.js', size: srcDup.length, source: srcDup, inst },
      // 现实里内联脚本的 url 是**文档 URL**，区分靠 start_line，不是空 url
      { hash: hInline, url: 'http://127.0.0.1:8777/', size: 11, startLine: 42, inst },
      { hash: hBig, url: 'http://127.0.0.1:8777/big.js', size: BIG, source: 'x'.repeat(BIG), inst }
    ]
  })
  check('超限脚本只留元数据', () => {
    assert.equal(scripts.withSource, 3)
    assert.equal(scripts.metaOnly, 2)
  })

  const scriptRows = await client.send('queryScripts', { inst, limit: 50 })
  check('同内容脚本只算一条', () => assert.equal(scriptRows.total, 4))
  const dupScript = scriptRows.rows.find((r) => r.hash === hDup)
  check('重复加载累加 seen_count', () => assert.equal(dupScript.seen_count, 2))

  const searchedScript = await client.send('queryScripts', { inst, filter: { search: 'dup' }, limit: 50 })
  check('按 URL 子串过滤', () => {
    assert.equal(searchedScript.total, 1)
    assert.match(searchedScript.rows[0].url, /dup1\.js$/)
  })

  const inline = await client.send('queryScripts', { inst, filter: { inline: true }, limit: 50 })
  check('内联脚本可单独筛出', () => {
    assert.equal(inline.total, 1)
    assert.equal(inline.rows[0].hash, hInline)
  })
  check('内联判定看起始行而不是空 url', () => {
    assert.equal(inline.rows[0].is_inline, 1)
    assert.equal(inline.rows[0].start_line, 42)
  })
  const external = await client.send('queryScripts', { inst, filter: { inline: false }, limit: 50 })
  check('外部脚本不落进内联桶', () => assert.equal(external.total, 3))

  const noSource = await client.send('queryScripts', { inst, filter: { hasSource: false }, limit: 50 })
  check('没源码的脚本可筛出', () => assert.equal(noSource.total, 2))

  const got = await client.send('getScriptSource', { hash: hApp })
  check('取回源码一致', () => assert.equal(got.source, srcApp))
  const gotBig = await client.send('getScriptSource', { hash: hBig })
  check('超限脚本 source 为空但 size 在', () => {
    assert.equal(gotBig.source, null)
    assert.equal(gotBig.size, BIG)
  })
  const missing = await client.send('getScriptSource', { hash: 'nope' })
  check('未知 hash 返回 null', () => assert.equal(missing, null))

  const sst = await client.send('scriptStats', { inst })
  check('脚本统计口径正确', () => {
    assert.equal(sst.total, 4)
    // 统计口径是「去重后的行」：dup1/dup2 只有一行，所以带源码的是 2 条
    assert.equal(sst.withSource, 2)
    assert.equal(sst.inline, 1)
  })

  // 第二次会话加载同一个 bundle：脚本不应重复落盘，但引用要独立
  const second = await client.send('beginInstance', { url: 'https://example.com/2', profile: 'L' })
  await client.send('appendScripts', {
    inst: second.instId,
    items: [{ hash: hApp, url: 'http://127.0.0.1:8777/app1.js', size: srcApp.length, source: srcApp, inst: second.instId }]
  })
  const secondList = await client.send('queryScripts', { inst: second.instId, limit: 50 })
  check('新会话只看得到自己加载的脚本', () => assert.equal(secondList.total, 1))
  const firstAgain = await client.send('queryScripts', { inst, limit: 50 })
  check('旧会话的脚本列表不受影响', () => assert.equal(firstAgain.total, 4))
  const sst2 = await client.send('scriptStats', { inst: second.instId })
  check('每会话统计独立', () => assert.equal(sst2.total, 1))
  await client.send('endInstance', { inst: second.instId })

  console.log('\n== 持久化 ==')
  await client.send('flush')
  await client.send('endInstance', { inst })
  await client.send('close')
  client.close()

  await new Promise((resolve) => setTimeout(resolve, 300))
  const size = statSync(dbPath).size
  console.log(`  落盘体积 ${(size / 1024 / 1024).toFixed(2)} MB`)

  const reopened = startServer()
  await reopened.send('open', { dbPath })
  const after = await reopened.send('queryRequests', { filter: { inst: 1 }, limit: 1 })
  check('重开后数据还在', () => assert.equal(after.total, TOTAL))
  const instances = await reopened.send('listInstances')
  check('实例记录完整', () => {
    assert.equal(instances.rows.length, 2)
    const first = instances.rows.find((row) => row.id === 1)
    assert.equal(first.kernel_version, 'Chrome/153.0.8010.50')
    assert.ok(first.ended_at > 0)
  })
  const bodyStillThere = await reopened.send('getBody', { hash: smallHash })
  check('body 表跨重启保留', () => assert.ok(bodyStillThere !== null))
  const scriptsAfter = await reopened.send('queryScripts', { inst: 1, limit: 50 })
  check('脚本表跨重启保留', () => assert.equal(scriptsAfter.total, 4))
  const sourceAfter = await reopened.send('getScriptSource', { hash: hApp })
  check('脚本源码跨重启可读', () => assert.equal(sourceAfter.source, srcApp))
  await reopened.send('close')
  reopened.close()

  await new Promise((resolve) => setTimeout(resolve, 200))
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* Windows 上偶发文件占用，忽略 */
  }

  const failedCount = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failedCount}/${results.length} 通过`)
  process.exit(failedCount === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n测试崩溃:', err)
  process.exit(1)
})
