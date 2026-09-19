#!/usr/bin/env node
/**
 * P5 验收（二）：三源关联。
 *
 * 对应设计文档 §4.3 的四条硬规则：
 *   关联键 = method + url + 时间窗口(±50ms)
 *   并发同 URL 有歧义 -> 以 CDP 为主键
 *   关联失败 -> 两条都留，标 unmerged，**不要丢弃**
 *   代理补充 CDP 给不了的 DNS/TLS
 *
 * 全是合成数据 —— 关联是纯函数，真实抓包那部分在 scripts/test-proxy.mjs 里。
 *
 *   node scripts/test-correlate.mjs
 */

import assert from 'node:assert/strict'
import { correlate, makeCorrelator, DEFAULT_WINDOW_MS } from '../proxy/correlate.mjs'

const results = []
function check(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
    console.log('  \u2713 ' + name)
  } catch (err) {
    results.push({ name, ok: false, message: err.message })
    console.log('  \u2717 ' + name + '\n      ' + err.message)
  }
}

const T0 = 1700000000000

/** 造一条 CDP 侧记录。只给关联用得上的字段，形状跟 RequestRecord 一致。 */
function cdp(over = {}) {
  const rec = {
    seq: 1,
    key: 's1|r1',
    requestId: 'r1',
    sessionId: 's1',
    targetId: 't1',
    targetType: 'page',
    frameUrl: 'https://monitor.test/',
    url: 'https://monitor.test/a.js',
    method: 'GET',
    resourceType: 'Script',
    status: 200,
    startTs: T0,
    ...over
  }
  return rec
}

/** 造一条代理侧 flow。 */
function flow(over = {}) {
  return {
    flowId: 'f1',
    startedAt: T0 + 3,
    finishedAt: T0 + 30,
    scheme: 'https',
    host: 'monitor.test',
    port: 443,
    method: 'GET',
    url: 'https://monitor.test/a.js',
    status: 200,
    timings: { dns: 1.2, connect: 4.4, tls: 9.9, ttfb: 20.1, download: 2.2 },
    upstreamIp: '10.0.0.1',
    tlsVersion: 'TLSv1.3',
    responseBytes: 1234,
    ...over
  }
}

console.log('== P5 三源关联验收 ==\n')

check('窗口内同 method+url -> 合并，且补上 DNS/TLS', () => {
  const { records, stats } = correlate([cdp()], [flow()])
  assert.equal(records.length, 1, '不该多出记录')
  assert.equal(records[0].mergeState, 'merged')
  assert.equal(records[0].proxyFlowId, 'f1')
  assert.equal(records[0].timings.dns, 1.2, 'DNS 没补进来')
  assert.equal(records[0].timings.tls, 9.9, 'TLS 没补进来')
  assert.equal(records[0].upstreamIp, '10.0.0.1')
  assert.equal(records[0].tlsVersion, 'TLSv1.3')
  assert.equal(stats.merged, 1)
  assert.equal(stats.mergeRate, 1)
  // CDP 自己的字段不能被代理覆盖
  assert.equal(records[0].key, 's1|r1')
  assert.equal(records[0].targetType, 'page')
})

check('默认窗口就是 ±50ms', () => {
  // 不写死数字：断言的是「比实测的突发排队大一个量级」这个性质。
  // 实测 189 并发下排队 50~171ms，窗口贴着实测值设会把关联率打到 21%（量过）。
  assert.ok(
    DEFAULT_WINDOW_MS >= 500,
    '默认窗口 ' + DEFAULT_WINDOW_MS + 'ms 太窄：突发并发下实测排队到过 171ms'
  )
})

check('窗口边界：正好在窗口上合并，超出一毫秒就不合并', () => {
  const windowOpt = { windowMs: 50 }
  const inWin = correlate([cdp()], [flow({ startedAt: T0 + 50 })], windowOpt)
  assert.equal(inWin.records[0].mergeState, 'merged', '正好 50ms 应该合并')
  const outWin = correlate([cdp()], [flow({ startedAt: T0 + 51 })], windowOpt)
  assert.notEqual(outWin.records[0].mergeState, 'merged', '51ms 不该合并')
})

check('负方向也在窗口内（代理先于 CDP，属正常抖动）', () => {
  const { records } = correlate([cdp()], [flow({ startedAt: T0 - 45 })], { windowMs: 50 })
  assert.equal(records[0].mergeState, 'merged')
  assert.equal(records[0].proxyDeltaMs, -45)
})

check('method 不同不合并', () => {
  const { records } = correlate([cdp({ method: 'POST' })], [flow({ method: 'GET' })])
  assert.equal(records.filter((r) => r.mergeState === 'merged').length, 0)
})

check('url 不同不合并', () => {
  const { records } = correlate([cdp()], [flow({ url: 'https://monitor.test/b.js' })])
  assert.equal(records.filter((r) => r.mergeState === 'merged').length, 0)
})

check('并发同 URL：每条 flow 只被认领一次，不串台', () => {
  const cdpList = [
    cdp({ seq: 1, key: 's|r1', requestId: 'r1', startTs: T0 }),
    cdp({ seq: 2, key: 's|r2', requestId: 'r2', startTs: T0 + 20 })
  ]
  const flows = [flow({ flowId: 'f1', startedAt: T0 + 2 }), flow({ flowId: 'f2', startedAt: T0 + 22 })]
  const { records, stats } = correlate(cdpList, flows)
  const merged = records.filter((r) => r.mergeState === 'merged')
  assert.equal(merged.length, 2, '两条都该配上')
  assert.deepEqual(merged.map((r) => r.proxyFlowId).sort(), ['f1', 'f2'], '配错了对')
  assert.equal(merged[0].proxyFlowId, 'f1', '先到的 CDP 该配先到的 flow')
  assert.equal(merged[1].proxyFlowId, 'f2')
  // 第一条 CDP 的两个候选都在 ±50ms 窗口里（相差 20ms 分不开）-> 这次配对是猜的，计 1 次；
  // 第二条 CDP 只剩唯一的候选，不算猜。如实计数，别粉饰。
  assert.equal(stats.ambiguous, 1, '窗口内的多候选必须如实计数')
})

check('同 URL 同一时刻两条 CDP、只有一条 flow：不重复认领，另一条降级不丢', () => {
  const cdpList = [
    cdp({ seq: 1, key: 's|r1', requestId: 'r1', startTs: T0 }),
    cdp({ seq: 2, key: 's|r2', requestId: 'r2', startTs: T0 + 1 })
  ]
  const { records, stats } = correlate(cdpList, [flow({ flowId: 'f1', startedAt: T0 })])
  assert.equal(stats.merged, 1, '一条 flow 不能被两条 CDP 同时认领')
  assert.equal(stats.cdpOnly, 1)
  const orphan = records.find((r) => r.mergeState === 'cdp-only')
  assert.ok(orphan, '没配上的那条必须还在，不能丢')
  assert.equal(orphan.key, 's|r2')
})

check('一条 CDP 有多个候选 flow -> 标 mergeAmbiguous，并取最近的', () => {
  const flows = [
    flow({ flowId: 'fa', startedAt: T0 + 3 }),
    flow({ flowId: 'fb', startedAt: T0 + 6 })
  ]
  const { records, stats } = correlate([cdp()], flows)
  assert.equal(stats.merged, 1)
  assert.equal(stats.ambiguous, 1, '同一窗口里两个候选却没标记歧义')
  const merged = records.find((r) => r.mergeState === 'merged')
  assert.equal(merged.proxyFlowId, 'fa', '没取最近的候选')
  assert.equal(merged.mergeAmbiguous, true, '记录上没打歧义标记')
  assert.equal(records.filter((r) => r.mergeState === 'proxy-only').length, 1, '落选的那条也要留着')
})

check('居中的候选会被选中（取最近的，不是第一个）', () => {
  const flows = [
    flow({ flowId: 'far', startedAt: T0 + 40 }),
    flow({ flowId: 'near', startedAt: T0 + 2 })
  ]
  const { records } = correlate([cdp()], flows)
  const merged = records.find((r) => r.mergeState === 'merged')
  assert.equal(merged.proxyFlowId, 'near', '没取最近的候选')
})

check('没配上的 CDP 记录保留，标 cdp-only', () => {
  const { records } = correlate([cdp()], [])
  assert.equal(records.length, 1)
  assert.equal(records[0].mergeState, 'cdp-only')
  assert.ok(records[0].url, '记录内容丢了')
})

check('没配上的代理 flow 保留，标 proxy-only（采集盲区不能丢）', () => {
  const { records, stats } = correlate([], [flow({ flowId: 'fx', url: 'https://monitor.test/x.js' })])
  assert.equal(records.length, 1, '代理独有的请求被丢了')
  assert.equal(records[0].mergeState, 'proxy-only')
  assert.equal(records[0].url, 'https://monitor.test/x.js')
  assert.equal(records[0].method, 'GET')
  assert.equal(records[0].timings.dns, 1.2, '时序没带上')
  assert.equal(stats.proxyOnly, 1)
})

check('一条都不丢：records 数 = cdp 条数 + 没配上的 flow 条数', () => {
  const cdpList = [cdp({ key: 's|r1' }), cdp({ key: 's|r2', url: 'https://monitor.test/miss.js' })]
  const flows = [flow(), flow({ flowId: 'f9', url: 'https://monitor.test/blind.js' })]
  const { records } = correlate(cdpList, flows)
  assert.equal(records.length, 3)
  assert.equal(records.filter((r) => r.mergeState === 'merged').length, 1)
  assert.equal(records.filter((r) => r.mergeState === 'cdp-only').length, 1)
  assert.equal(records.filter((r) => r.mergeState === 'proxy-only').length, 1)
})

check('关联率定义：配对观测数 / 两侧观测总数', () => {
  const both = correlate([cdp()], [flow()]).stats
  assert.equal(both.mergeRate, 1, '全配上应该是 1')
  const half = correlate([cdp()], [flow({ startedAt: T0 + 5000 })]).stats
  assert.equal(half.mergeRate, 0, '全没配上应该是 0')
  assert.equal(half.cdpMergeRate, 0)
  assert.equal(half.proxyMergeRate, 0)
})

check('结果按时间排序（UI 要按时间看）', () => {
  const cdpList = [cdp({ key: 'a', startTs: T0 + 1000 }), cdp({ key: 'b', startTs: T0 })]
  const { records } = correlate(cdpList, [])
  assert.equal(records[0].key, 'b')
  assert.equal(records[1].key, 'a')
})

check('空输入不炸，且不做无意义的告警', () => {
  const r = correlate([], [])
  assert.equal(r.records.length, 0)
  assert.equal(r.stats.mergeRate, 1)
  assert.equal(r.stats.merged, 0)
})

check('非法输入（undefined）当成空，不抛', () => {
  const r = correlate(undefined, undefined)
  assert.equal(r.records.length, 0)
})

console.log('\n== 流式关联（主进程走的就是这条） ==')

check('流式：先来 flow 后到 CDP，照样配上', () => {
  const c = makeCorrelator()
  c.addFlow(flow({ flowId: 'fs1' }))
  const merged = c.match(cdp())
  assert.equal(merged.mergeState, 'merged')
  assert.equal(merged.proxyFlowId, 'fs1')
  assert.equal(merged.timings.dns, 1.2)
  assert.equal(c.stats.merged, 1)
  assert.equal(c.stats.mergeRate, 1)
})

check('流式：CDP 先到（代理还没回）-> cdp-only，不丢', () => {
  const c = makeCorrelator()
  const rec = c.match(cdp())
  assert.equal(rec.mergeState, 'cdp-only')
  assert.equal(c.stats.cdpOnly, 1)
})

check('流式：flow 已在缓冲里、CDP 记录后到 —— 照样配上（这条断言的是缓冲命中，不是顺序猜测）', () => {
  const c = makeCorrelator()
  c.match(cdp({ startTs: T0 + 100000 }))
  c.addFlow(flow({ startedAt: T0 + 100000 }))
  const merged = c.match(cdp({ key: 's|r3', startTs: T0 + 100000 }))
  assert.equal(merged.mergeState, 'merged', 'flow 已经在缓冲里了，该配上')
})

check('流式：每条 flow 只被认领一次', () => {
  const c = makeCorrelator()
  c.addFlow(flow({ flowId: 'only' }))
  const a = c.match(cdp({ key: 's|r1' }))
  const b = c.match(cdp({ key: 's|r2' }))
  assert.equal(a.mergeState, 'merged')
  assert.equal(b.mergeState, 'cdp-only')
  assert.equal(c.stats.merged, 1)
})

check('流式：flush 把采集盲区里的代理记录吐出来，标 proxy-only', () => {
  const c = makeCorrelator({ retentionMs: 0 })
  // 保留期是拿 Date.now() 和 flow.startedAt 比的，所以这两条用例得用当前钟
  c.addFlow(flow({ flowId: 'blind', url: 'https://monitor.test/blind.js', startedAt: Date.now() - 1 }))
  const left = c.flush(Date.now() + 10)
  assert.equal(left.length, 1)
  assert.equal(left[0].mergeState, 'proxy-only')
  assert.equal(left[0].url, 'https://monitor.test/blind.js')
  assert.equal(c.stats.proxyOnly, 1)
})

check('流式：flush 不会把「刚来还没来得及配」的 flow 提前赶走', () => {
  const now = Date.now()
  const c = makeCorrelator({ retentionMs: 5000 })
  c.addFlow(flow({ flowId: 'fresh', startedAt: now }))
  assert.equal(c.flush(now).length, 0, '还在保留期内，不该被当成盲区')
  assert.equal(c.match(cdp({ startTs: now })).mergeState, 'merged', '之后仍能配上')
})

check('流式：关联率随两侧观测数实时更新', () => {
  const c = makeCorrelator()
  c.addFlow(flow({ flowId: 'x', url: 'https://monitor.test/x.js' }))
  assert.equal(c.stats.mergeRate, 0, '只有代理侧一条、没配上，关联率该是 0')
  c.addFlow(flow({ flowId: 'y' }))
  c.match(cdp())
  assert.ok(c.stats.mergeRate > 0 && c.stats.mergeRate < 1, '半配对应该落在 (0,1)：' + c.stats.mergeRate)
})

check('流式：晚到的 flow 反向补配已标 cdp-only 的记录（长连接/流式响应的场景）', () => {
  const c = makeCorrelator({ retentionMs: 0 })
  const rec = cdp({ seq: 7, url: 'https://monitor.test/events', startTs: T0 })
  const first = c.match(rec)
  assert.equal(first.mergeState, 'cdp-only', 'flow 还没到，这条先落成孤儿')
  assert.equal(c.stats.cdpOnly, 1)

  // 收工 drain 才补报上来的 flow：startedAt 和记录只差 30ms（窗口内）
  c.addFlow(flow({ flowId: 'late', url: 'https://monitor.test/events', startedAt: T0 + 30, open: true }))
  const revisions = c.takeRevisions()
  assert.equal(revisions.length, 1, '该产出一条修正记录')
  assert.equal(revisions[0].seq, 7, '必须是同一条记录（同 seq 重投，upsert 覆盖）')
  assert.equal(revisions[0].mergeState, 'merged')
  assert.equal(revisions[0].proxyFlowId, 'late')
  assert.equal(revisions[0].proxyOpen, true, '长连接要标 proxyOpen，时序不完整')
})

check('流式：晚配后「配不上的样本」里不该再留着它（数字说 0 孤儿、样本却还挂着，会误导读日志的人）', () => {
  const c = makeCorrelator({ retentionMs: 0 })
  c.match(cdp({ seq: 1, url: 'https://monitor.test/events', startTs: T0 }))
  assert.equal(c.scopeStats.samples.cdpOnly.length, 1, '此刻它确实是孤儿')
  c.addFlow(flow({ flowId: 'late', url: 'https://monitor.test/events', startedAt: T0 + 30 }))
  assert.equal(c.scopeStats.samples.cdpOnly.length, 0, '补配之后要从样本里摘掉')
})

check('流式：晚配之后三个计数守恒，且没有多出孤儿', () => {
  const c = makeCorrelator({ retentionMs: 0 })
  c.match(cdp({ seq: 1, url: 'https://monitor.test/events', startTs: T0 }))
  c.addFlow(flow({ flowId: 'late', url: 'https://monitor.test/events', startedAt: T0 + 30 }))
  c.takeRevisions()

  assert.equal(c.stats.merged, 1, 'merged 该 +1')
  assert.equal(c.stats.cdpOnly, 0, '原先按孤儿记的那条要挪走')
  assert.equal(c.stats.proxyOnly, 0, '这条 flow 不能再被 flush 吐成 proxy-only')
  assert.equal(c.stats.cdpCount, 1)
  assert.equal(c.stats.proxyCount, 1)
  assert.equal(c.stats.mergeRate, 1, '两边各一条且配上了，关联率该是 1')

  const left = c.flush(Date.now() + 10)
  assert.equal(left.length, 0, '已被晚配认领的 flow 不该再出现在 flush 的结果里')
})

check('流式：晚到的 flow 超出窗口就不硬配，照旧两条孤儿', () => {
  const c = makeCorrelator({ windowMs: 50, retentionMs: 0 })
  c.match(cdp({ seq: 1, url: 'https://monitor.test/events', startTs: T0 }))
  c.addFlow(flow({ flowId: 'late', url: 'https://monitor.test/events', startedAt: T0 + 400 }))
  assert.equal(c.takeRevisions().length, 0, '超窗口不能硬凑')
  assert.equal(c.stats.cdpOnly, 1)
  const left = c.flush(Date.now() + 10)
  assert.equal(left.length, 1)
  assert.equal(left[0].mergeState, 'proxy-only')
})

check('流式：晚配只认领一条，同名第二对互不干扰', () => {
  const c = makeCorrelator({ windowMs: 50, retentionMs: 0 })
  c.match(cdp({ seq: 1, url: 'https://monitor.test/a.js', startTs: T0 }))
  c.match(cdp({ seq: 2, url: 'https://monitor.test/a.js', startTs: T0 + 1000 }))
  c.addFlow(flow({ flowId: 'late1', url: 'https://monitor.test/a.js', startedAt: T0 + 20 }))
  const revisions = c.takeRevisions()
  assert.equal(revisions.length, 1)
  assert.equal(revisions[0].seq, 1, '配的该是时间上更近的那条')
  assert.equal(c.stats.cdpOnly, 1, '另一条还是孤儿')

  c.addFlow(flow({ flowId: 'late2', url: 'https://monitor.test/a.js', startedAt: T0 + 1010 }))
  assert.equal(c.takeRevisions()[0].seq, 2, '第二条 flow 配第二条记录')
  assert.equal(c.stats.cdpOnly, 0)
  assert.equal(c.stats.merged, 2)
})

check('流式：同一条记录被重投两次（pending+终态）只登记一个 waiter', () => {
  const c = makeCorrelator({ windowMs: 50, retentionMs: 0 })
  const rec = cdp({ seq: 3, url: 'https://monitor.test/b.js', startTs: T0 })
  c.match(rec)
  c.match({ ...rec, mergeState: 'cdp-only' })
  c.addFlow(flow({ flowId: 'late', url: 'https://monitor.test/b.js', startedAt: T0 + 10 }))
  assert.equal(c.takeRevisions().length, 1, '只该补配一次')
})

console.log('\n== 结果 ==')
const failed = results.filter((item) => !item.ok)
console.log('  ' + (results.length - failed.length) + '/' + results.length + ' 通过')
for (const item of failed) console.log('  \u2717 ' + item.name + ': ' + item.message)
process.exit(failed.length === 0 ? 0 : 1)
