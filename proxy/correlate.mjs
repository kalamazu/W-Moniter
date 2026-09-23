/**
 * 监控容器 · 三源关联（P5）
 *
 * 设计文档 §4.3：
 *   - CDP：requestId + timestamp(monotonic) + wallTime
 *   - 代理：flowId + 本地时间戳
 *   - 关联键：method + url + 时间窗口
 *   - 并发同 URL 会歧义 -> **以 CDP 为主键**，代理记录作为补充字段 merge 进去（DNS/TLS 时序）
 *   - 关联失败 -> 保留两条，标记 unmerged，**不要丢弃**
 *
 * 这里只做纯函数，不碰 IO —— 所以能直接在脚本里拿合成数据 + 真实抓包数据测。
 *
 * 时钟：CDP 侧的 startTs 取自 Network.requestWillBeSent.wallTime（epoch ms），
 * 代理侧用 Date.now()。同机同钟，所以可以直接比。
 */

/**
 * 默认关联窗口（单边，ms）。
 *
 * §4.3 原来写的是 ±50ms —— 那是个**没量过的先验值**，实测不够用，别照抄。
 * 量的口径：CDP 的 requestWillBeSent.wallTime → 代理真的读到请求行，
 * 也就是「浏览器栈里排队 + DNS + 建连」这一跳（瀑布图里那段灰的）。
 *
 *   189 并发（受控 origin 一次发 189 条）下实测：
 *     窗口 50ms  -> 关联率 21.2%   （排队 50~57ms，正好全卡在窗口外）
 *     窗口 200ms -> 关联率 100%    （但另一轮负载下排队到过 171ms，余量只剩 1.2×）
 *     窗口 1000ms-> 关联率 100%
 *
 * 这个延迟随并发量增长，不是常数，所以窗口要留出量级余量而不是贴着实测值。
 * 窗口开大的代价只是「同一 URL 在窗口内有多条候选」时多打一个 mergeAmbiguous
 * 标记（配对取最近的，且会如实标成「猜的」），不会静默配错 —— 值得换。
 */
export const DEFAULT_WINDOW_MS = 1000

const keyOf = (method, url) => method + ' ' + url

/**
 * @param {Array} cdpRecords  采集层的 RequestRecord（startTs 是 epoch ms）
 * @param {Array} proxyFlows  代理层的 flow（startedAt 是 epoch ms）
 * @param {{windowMs?: number}} [opts]
 */
export function correlate(cdpRecords, proxyFlows, opts = {}) {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
  const cdp = Array.isArray(cdpRecords) ? cdpRecords : []
  const flows = Array.isArray(proxyFlows) ? proxyFlows : []

  // 按 method+url 分桶；每条 flow 只能被认领一次，否则并发同 URL 会串台
  const bucket = new Map()
  for (const f of flows) {
    const k = keyOf(f.method, f.url)
    let list = bucket.get(k)
    if (!list) { list = []; bucket.set(k, list) }
    list.push({ flow: f, used: false })
  }

  const records = []
  const matchedFlows = new Set()
  let merged = 0
  let ambiguous = 0

  for (const rec of cdp) {
    const list = bucket.get(keyOf(rec.method, rec.url))
    let best = null
    let ties = 0
    if (list) {
      const inWindow = []
      for (const c of list) {
        if (c.used) continue
        const delta = Math.abs(c.flow.startedAt - rec.startTs)
        if (delta > windowMs) continue
        inWindow.push({ c, delta })
      }
      if (inWindow.length) {
        // 取最近的；但窗口内有多个候选就意味着「这次配对是猜的」，
        // 计数单独报出来 —— 关联率看不出的东西，这个数看得出来。
        inWindow.sort((a, b) => a.delta - b.delta)
        best = inWindow[0].c
        ties = inWindow.length
      }
    }
    if (!best) {
      records.push({ ...rec, mergeState: 'cdp-only' })
      continue
    }
    best.used = true
    matchedFlows.add(best.flow)
    merged += 1
    if (ties > 1) ambiguous += 1
    records.push(withFlow(rec, best.flow, ties))
  }

  // 代理看到、CDP 没看到的（不同 target / 采集盲区）——保留，标 proxy-only，不丢（§4.3）
  for (const list of bucket.values()) {
    for (const c of list) {
      if (c.used) continue
      records.push(toProxyOnly(c.flow))
    }
  }

  records.sort((a, b) => (a.startTs ?? a.startedAt ?? 0) - (b.startTs ?? b.startedAt ?? 0))

  const proxyOnly = records.filter((r) => r.mergeState === 'proxy-only').length
  const cdpOnly = records.filter((r) => r.mergeState === 'cdp-only').length
  const total = cdp.length + flows.length
  return {
    records,
    stats: {
      cdpCount: cdp.length,
      proxyCount: flows.length,
      merged,
      cdpOnly,
      proxyOnly,
      ambiguous,
      /**
       * 关联率 = 配对成功的「观测数」占两侧观测总数的比例。
       * 用这个定义是因为它同时惩罚「CDP 孤儿」和「代理孤儿」，
       * 而单看 merged/cdpCount 会把代理侧的盲区藏起来。
       */
      mergeRate: total === 0 ? 1 : (2 * merged) / total,
      cdpMergeRate: cdp.length === 0 ? 1 : merged / cdp.length,
      proxyMergeRate: flows.length === 0 ? 1 : merged / flows.length
    }
  }
}

function toProxyOnly(flow) {
  return {
    seq: -1,
    key: 'proxy|' + flow.flowId,
    requestId: '',
    sessionId: null,
    targetId: '',
    targetType: 'Proxy',
    frameUrl: '',
    url: flow.url,
    method: flow.method,
    resourceType: 'Proxy',
    status: flow.status,
    statusText: flow.statusText,
    mimeType: (flow.responseHeaders ?? {})['content-type'],
    startTs: flow.startedAt,
    endTs: flow.finishedAt,
    durationMs: flow.finishedAt ? flow.finishedAt - flow.startedAt : undefined,
    encodedDataLength: flow.responseBytes,
    fromCache: false,
    fromServiceWorker: false,
    proxyFlowId: flow.flowId,
    mergeState: 'proxy-only',
    ...(flow.open ? { proxyOpen: true } : {}),
    timings: flow.timings ?? {},
    upstreamIp: flow.upstreamIp,
    tlsVersion: flow.tlsVersion,
    tlsCipher: flow.tlsCipher,
    requestHeaders: flow.requestHeaders,
    responseHeaders: flow.responseHeaders
  }
}

/**
 * 把代理 flow 的信息并进 CDP 记录。批处理、流式、晚配三条路径共用一份，
 * 免得三处各写一遍、改一处漏两处。
 * 代理独有的那些字段就是 §5.1 说的「CDP 给不了」的部分：DNS / TLS / 上游 IP。
 */
function withFlow(record, flow, ties = 1) {
  return {
    ...record,
    proxyFlowId: flow.flowId,
    ...(flow.contentRef ? { proxyContentRef: flow.contentRef } : {}),
    mergeState: 'merged',
    timings: flow.timings ?? {},
    upstreamIp: flow.upstreamIp,
    tlsVersion: flow.tlsVersion,
    tlsCipher: flow.tlsCipher,
    upstreamAlpn: flow.upstreamAlpn,
    proxyDeltaMs: Math.round(flow.startedAt - record.startTs),
    ...(flow.open ? { proxyOpen: true } : {}),
    ...(ties > 1 ? { mergeAmbiguous: true } : {})
  }
}

/* ---------------------------------------------------------------- 流式关联 */

/**
 * 批处理版是「两边都收齐了再配」。主进程要的是「CDP 记录一落地就配」——
 * 所以再给一个流式版本，匹配规则与窗口和 correlate() 完全一致，只是状态留着。
 *
 * 为什么能配得上：代理是在把最后一个字节交给浏览器之前就结束这条 flow 的，
 * 而 Chrome 的 loadingFinished 更晚，所以 CDP 记录到达时代理侧记录必然已经在了。
 * 真配不上就按 §4.3 标 cdp-only，等 flush() 时把剩下的代理记录以 proxy-only 吐出来。
 */
export function makeCorrelator(opts = {}) {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
  /** 代理记录在缓冲里留多久；超过就认定 CDP 永远看不到它（采集盲区）*/
  const retentionMs = opts.retentionMs ?? 3000
  const buffer = new Map() // key -> [{ flow, used }]
  /**
   * 只统计「本次观测目标」的流量。Chrome 自己会发连通性探测、变体种子之类
   * 浏览器进程级的请求 —— 它们在 CDP 的页面/worker target 上根本看不到，
   * 会如实变成 proxy-only。把它们算进关联率，等于拿采集盲区去惩罚代理，
   * 所以 §12 的关联率按受控范围计，全量的那个数照样报出来（rawStats）。
   */
  const inScope = opts.inScope ?? (() => true)
  const scope = { cdpCount: 0, proxyCount: 0, merged: 0, cdpOnly: 0, proxyOnly: 0, ambiguous: 0 }
  /** 配不上的样本（各留几条）。关联率不达标时，光看数字看不出是 URL 不对还是时钟不对 */
  const samples = { cdpOnly: [], proxyOnly: [], deltas: [] }
  const SAMPLE_MAX = 8
  const stats = {
    cdpCount: 0, proxyCount: 0, merged: 0, cdpOnly: 0, proxyOnly: 0, ambiguous: 0,
    mergeRate: 1, cdpMergeRate: 1, proxyMergeRate: 1
  }
  let matched = 0
  /**
   * 已经按 cdp-only 吐出去的记录，按 method+url 留一份，等晚到的 flow。
   *
   * 为什么需要：关联的方向默认是「代理先、CDP 后」（代理在把 body 交给浏览器之前就结束
   * flow 了，Chrome 的 loadingFinished 更晚），所以 match() 里只认「flow 已经在了」。
   * 但长连接（SSE / 流式响应）是反过来的 —— CDP 那条早在响应头到达时就落了，
   * 代理要等收工 drain 才拿得到。只认单向的话这类请求必然是一对孤儿：
   * 既拿不到 DNS/TLS，又把关联率拉下来。
   *
   * 补配走 takeRevisions()：主进程拿合并后的记录按同一个 seq 重投一次（upsert 覆盖，
   * UI 是重查库的，不会多出一行）。这里不上时间淘汰 —— 长连接能开一整个会话，
   * 淘汰早了就白配了；靠条数上限兜底，反正会话结束整个关联器就没了。
   */
  const cdpWaiters = new Map() // key -> [{ record, startTs, claimed }]
  const waiterMax = 4000
  const revisions = []
  /** 已被晚配认领的 flowId：flush() 不能再把它们吐成 proxy-only */
  const lateClaimed = new Set()

  let scopeMatched = 0
  const rate = (m, c, p) => {
    const total = c + p
    return total === 0 ? 1 : (2 * m) / total
  }
  const refresh = () => {
    stats.mergeRate = rate(matched, stats.cdpCount, stats.proxyCount)
    stats.cdpMergeRate = stats.cdpCount === 0 ? 1 : matched / stats.cdpCount
    stats.proxyMergeRate = stats.proxyCount === 0 ? 1 : matched / stats.proxyCount
  }

  /** 这条记录后来配上了，把它从 cdp-only 样本里摘掉 */
  function forgetCdpOnlySample(record) {
    const i = samples.cdpOnly.findIndex(
      (s) => s.url === record.url && s.method === record.method && s.startTs === record.startTs
    )
    if (i >= 0) samples.cdpOnly.splice(i, 1)
  }

  /** 登记一条 cdp-only 记录。同 seq 只留一份，避免 pending/终态重复登记 */
  function rememberCdp(record) {
    const k = keyOf(record.method, record.url)
    let list = cdpWaiters.get(k)
    if (!list) { list = []; cdpWaiters.set(k, list) }
    if (list.some((w) => w.record.seq === record.seq)) return
    list.push({ record, startTs: record.startTs, claimed: false })
    if (list.length > waiterMax) list.shift()
  }

  /**
   * 晚到的 flow 反向补配。命中就把那条 cdp-only 记录改写成 merged，
   * 放进 revisions 交给主进程重投 —— 计数也要跟着挪，不然关联率是错的。
   */
  function tryLateMatch(flow) {
    const list = cdpWaiters.get(keyOf(flow.method, flow.url))
    if (!list) return
    let best = null
    let bestDelta = Infinity
    for (const w of list) {
      if (w.claimed) continue
      const delta = Math.abs(flow.startedAt - w.startTs)
      if (delta > windowMs) continue
      if (delta < bestDelta) { bestDelta = delta; best = w }
    }
    if (!best) return
    best.claimed = true
    lateClaimed.add(flow.flowId)
    const record = best.record
    const scoped = inScope(record.url)
    // 它已经不是孤儿了，别把它留在「配不上的样本」里误导人
    if (scoped) forgetCdpOnlySample(record)
    // 这两个数之前按孤儿记过，现在要挪到 merged 上（proxyOnly 还没记：flow 还没 flush）
    stats.cdpOnly -= 1
    stats.merged += 1
    matched += 1
    if (scoped) {
      scope.cdpOnly -= 1
      scope.merged += 1
      scopeMatched += 1
      if (samples.deltas.length < SAMPLE_MAX) samples.deltas.push(flow.startedAt - record.startTs)
    }
    revisions.push(withFlow(record, flow))
    refresh()
  }

  return {
    /** 晚配出来的修正记录，交给主进程按同一个 seq 重投（upsert 覆盖，不会多一行） */
    takeRevisions() {
      return revisions.splice(0, revisions.length)
    },

    addFlow(flow) {
      stats.proxyCount += 1
      const scoped = inScope(flow.url)
      if (scoped) scope.proxyCount += 1
      const k = keyOf(flow.method, flow.url)
      let list = buffer.get(k)
      if (!list) { list = []; buffer.set(k, list) }
      list.push({ flow, used: false })
      tryLateMatch(flow)
      refresh()
    },

    /** 返回合并后的记录；配不上就返回 { ...record, mergeState: 'cdp-only' } */
    match(record) {
      stats.cdpCount += 1
      const scoped = inScope(record.url)
      if (scoped) scope.cdpCount += 1
      const list = buffer.get(keyOf(record.method, record.url))
      let best = null
      let ties = 0
      if (list) {
        const inWindow = []
        for (const c of list) {
          if (c.used) continue
          const delta = Math.abs(c.flow.startedAt - record.startTs)
          if (delta > windowMs) continue
          inWindow.push({ c, delta })
        }
        if (inWindow.length) {
          inWindow.sort((a, b) => a.delta - b.delta)
          best = inWindow[0].c
          ties = inWindow.length
        }
      }
      if (!best) {
        stats.cdpOnly += 1
        if (scoped) {
          scope.cdpOnly += 1
          if (samples.cdpOnly.length < SAMPLE_MAX) {
            samples.cdpOnly.push({ url: record.url, method: record.method, startTs: record.startTs })
          }
        }
        // 长连接的 flow 会晚很多才到（收工 drain 才补报），先记着
        rememberCdp(record)
        refresh()
        return { ...record, mergeState: 'cdp-only' }
      }
      best.used = true
      matched += 1
      stats.merged += 1
      if (ties > 1) stats.ambiguous += 1
      if (scoped) {
        scopeMatched += 1
        scope.merged += 1
        if (ties > 1) scope.ambiguous += 1
        if (samples.deltas.length < SAMPLE_MAX) samples.deltas.push(best.flow.startedAt - record.startTs)
      }
      refresh()
      return withFlow(record, best.flow, ties)
    },

    /** 把已经不可能再配上 CDP 的代理记录吐出来（保留，标 proxy-only） */
    flush(now = Date.now()) {
      const out = []
      for (const [k, list] of buffer) {
        const keep = []
        for (const c of list) {
          if (c.used) continue
          // 已经被晚配认领了：它早就是某条合并记录的一部分，别再吐一条 proxy-only
          if (lateClaimed.has(c.flow.flowId)) continue
          if (now - c.flow.startedAt > retentionMs) {
            out.push(toProxyOnly(c.flow))
            stats.proxyOnly += 1
            if (inScope(c.flow.url)) {
              scope.proxyOnly += 1
              if (samples.proxyOnly.length < SAMPLE_MAX) {
                samples.proxyOnly.push({ url: c.flow.url, method: c.flow.method, startedAt: c.flow.startedAt })
              }
            }
          }
          else keep.push(c)
        }
        if (keep.length) buffer.set(k, keep)
        else buffer.delete(k)
      }
      refresh()
      return out
    },

    get stats() { return { ...stats } },

    /** 受控范围内的关联统计 —— §12 的关联率看这个；rawStats 是全量 */
    get scopeStats() {
      return {
        ...scope,
        mergeRate: rate(scopeMatched, scope.cdpCount, scope.proxyCount),
        samples: {
          cdpOnly: samples.cdpOnly.slice(),
          proxyOnly: samples.proxyOnly.slice(),
          deltas: samples.deltas.slice()
        }
      }
    }
  }
}
