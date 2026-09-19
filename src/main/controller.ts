import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { CdpClient } from './browser/cdp'
import { Collector } from './browser/collector'
import { launchBrowser } from './browser/launch'
import { locateBrowser } from './browser/locate'
import { InputAutomation } from './browser/automation'
import { DomInspector } from './browser/dom'
import { Screenshotter } from './browser/screenshot'
import { ProbeChannel, ProbeRunner, probeCapability } from './browser/probe'
import type { BodyConfig, CapturedBody } from './browser/body-capture'
import type { ScriptConfig } from './browser/script-capture'
import { RuleEngine } from './rules/engine'
import { StorageClient, type StorageConfig } from './storage/client'
import { ProxyClient } from './proxy/client'
import { toProxyRules } from './proxy/rules'
import {
  DEFAULT_WINDOW_MS,
  makeCorrelator,
  type Correlator,
  type ProxyFlow
} from '../../proxy/correlate.mjs'
import type {
  BodyPayload,
  CapabilitySet,
  ConsoleEntry,
  ControllerStatus,
  DomInspectResult,
  DomTreeRow,
  EvaluateResult,
  InstanceRow,
  InputAction,
  InputReport,
  InstanceStats,
  NetTimings,
  Page,
  Profile,
  ProbeReport,
  RequestDetail,
  RequestOrder,
  RequestQuery,
  RequestRecord,
  RuleSet,
  RuleStats,
  ScriptRecord,
  ScriptOrder,
  ScriptQuery,
  ScriptRow,
  ScriptSource,
  ScreenshotOptions,
  ScreenshotResult,
  NavigateResult,
  ScriptStats,
  SessionOverview,
  Stats,
  StorageSummary,
  StoredRequest,
  TargetInfo,
  TimelineRow
} from '../shared/types'

/** 批量推送给 UI 的间隔。逐条推送会在重页面上打死渲染进程。 */
const FLUSH_INTERVAL_MS = 150

/** 从一条合并记录里抽出「代理给的这部分」，缓存与重投都用它 */
function proxyPatchOf(record: RequestRecord): Partial<RequestRecord> {
  return {
    proxyFlowId: record.proxyFlowId,
    mergeState: record.mergeState,
    timings: record.timings,
    ...(record.upstreamIp ? { upstreamIp: record.upstreamIp } : {}),
    ...(record.tlsVersion ? { tlsVersion: record.tlsVersion } : {}),
    ...(record.tlsCipher ? { tlsCipher: record.tlsCipher } : {}),
    ...(record.upstreamAlpn ? { upstreamAlpn: record.upstreamAlpn } : {}),
    ...(record.proxyDeltaMs !== undefined ? { proxyDeltaMs: record.proxyDeltaMs } : {}),
    ...(record.mergeAmbiguous ? { mergeAmbiguous: true } : {}),
    ...(record.proxyOpen ? { proxyOpen: true } : {})
  }
}

/**
 * 关联缓存的键：会话+requestId+URL。
 * URL 必须进来 —— 重定向复用 requestId，只按 requestId 缓存会串台（见 correlate()）。
 */
function mergeCacheKey(record: RequestRecord): string {
  return record.key + '\u0000' + record.url
}

/** 导航等 load 事件的上限。等不到也返回（有些页面就是不发 load） */
const NAVIGATE_LOAD_TIMEOUT_MS = 15_000

/** 截图 inline 回来的 base64 上限：再大就走路径，别让一条 JSON-RPC 消息被一张图撑爆 */
const MAX_INLINE_BASE64 = 4 * 1024 * 1024

/**
 * 截图目录只留最近这么多张。agent 可能成环地截图（拿图 → 判断 → 再截），
 * 不设上限的话数据目录会无声地涨起来。
 */
const SCREENSHOT_KEEP = 200

/** 默认拦这些类型的响应体。图片/字体/媒体不碰 —— 量大、价值低、拖慢页面。 */
const DEFAULT_BODY_TYPES = ['Document', 'Script', 'Stylesheet', 'XHR', 'Fetch']

export interface ControllerOptions {
  userDataDir: string
  startUrl: string
  profile: Profile
  headless: boolean
  extraArgs?: string[]
  dbPath: string
  captureBodies: boolean
  bodyMaxBytes: number
  bodyStoreMaxBytes: number
  bodyStoreMaxCount: number
  bodyTypes: string[]
  bodyTimeoutMs: number
  /** 开本地代理（P5）。开了才有 DNS/TLS 时序，也才有大 body 改写 */
  proxy?: boolean
  /** 代理 CA 私钥落盘位置；不填就放在 userDataDir 下 */
  proxyKeyFile?: string
  /** 代理层改写的 body 上限，超过就退化成透传 */
  proxyRewriteMaxBytes?: number
  /** 上游 TLS 校验，默认开；本地自签 origin 的测试要关 */
  proxyUpstreamRejectUnauthorized?: boolean
  /**
   * 三源关联的时间窗口（ms，单边）。
   * §4.3 写的是 ±50ms，但那是先验数字：突发并发下 Chrome 把请求排队后才真正写到代理，
   * 实测这一跳能到 60ms 以上（见 docs §4.3 的实测记录）。默认值按实测取。
   */
  proxyMergeWindowMs?: number
  captureScripts: boolean
  scriptMaxBytes: number
  scriptMaxCount: number
  scriptTimeoutMs: number
  scriptConcurrency: number
}

export class Controller extends EventEmitter {
  private status: ControllerStatus
  private requestCount = 0
  private scriptCount = 0
  private child: ChildProcess | null = null
  private cdp: CdpClient | null = null
  private collector: Collector | null = null
  /** 干预引擎：生命周期跟着 Controller，规则可以在运行中换 */
  private readonly rules = new RuleEngine()
  /** 收工后 collector 会置空，注入统计得留一份 */
  private injectionSnapshot: ReturnType<Collector['getInjectionStats']> | null = null
  /** 探针信道：BodyCapture 在 Fetch 里认领信标，这里收报告 */
  private readonly probeChannel = new ProbeChannel()
  private probeRunner: ProbeRunner | null = null
  private input: InputAutomation | null = null
  /** 收工后 collector 会置空，控制台记录得留一份 */
  private consoleSnapshot: ConsoleEntry[] = []
  private storage: StorageClient
  /** P5：本地代理 + 三源关联。代理没开时两者都是空的 */
  private proxy: ProxyClient | null = null
  /**
   * 注意：这里只能声明、必须在构造函数体里赋值。
   * 字段初始化器先于构造函数体执行，而此时参数属性 options/scopePrefix 还没赋上，
   * 直接写成初始化器会抛 ReferenceError: options is not defined（整个应用起不来）。
   */
  /** 切 Profile 重启时会换一个新的（保留关联器的构造时机约束见上） */
  private correlator: Correlator
  /** 本次观测的 origin，用于区分「受控流量」和浏览器的后台流量 */
  private readonly scopePrefix: string
  private proxyError: string | null = null
  /** 会话级的代理快照。收工时进程已经停了，但 summary 要说明「这次会话用过代理」 */
  private proxyInfo: { host: string; port: number; spki: string } | null = null
  /**
   * 同一条请求会被采集层发两次（pending 行 + 终态行）。
   * 关联结果按 key 缓存，两次用同一份 —— 否则第二次再调 match() 时
   * 那条 flow 已经被认领走了，会白白多出一条 cdp-only（实测直接把关联率打到 23%）。
   */
  private readonly mergeCache = new Map<string, Partial<RequestRecord>>()
  // 缓存键是 mergeCacheKey()：会话+requestId+URL。URL 必须进来 —— 重定向复用 requestId，
  // 只按 requestId 缓存会串台（重定向目标会抄走上一条的关联结果，自己那条 flow 变成孤儿）
  /** 关联成功的记录里，各种时序各出现过多少次（验收脚本要它当证据） */
  private readonly timingEvidence: Record<string, number> = {
    dns: 0, connect: 0, tls: 0, ttfb: 0, download: 0
  }
  /** 第一条关联成功的记录的网络时序 —— 验收脚本拿它当「DNS/TLS 齐全」的证据 */
  private proxyTimingSample: {
    url: string
    timings: NetTimings
    upstreamIp?: string
    tlsVersion?: string
    proxyDeltaMs?: number
  } | null = null
  /** 当前 Profile。切 Profile 会改它（§7.1 #9 会话管理的「profile 切换」） */
  private profile: Profile
  /** §7.1 #3 DOM 与元素检查。跟着 cdp 一起生灭 */
  private dom: DomInspector | null = null
  /** 截图。和 dom 一样跟着 cdp 生灭 —— 它复用采集已经开过的 Page 域 */
  private shot: Screenshotter | null = null
  /** 已经记过日志的 domain —— enabledDomains 是累计值，不去重会每点一个节点刷一行 */
  private domLogged = new Set<string>()
  private queue: RequestRecord[] = []
  private flushTimer: NodeJS.Timeout | null = null

  constructor(private readonly options: ControllerOptions) {
    super()
    this.profile = options.profile

    const storageConfig: StorageConfig = {
      dbPath: options.dbPath,
      storeBodies: options.captureBodies,
      bodyMaxBytes: options.bodyMaxBytes,
      bodyStoreMaxBytes: options.bodyStoreMaxBytes,
      bodyStoreMaxCount: options.bodyStoreMaxCount
    }
    this.storage = new StorageClient(storageConfig)
    this.storage.on('health', (health) => this.patchStatus({ storage: health }))
    this.storage.on('log', (line: string) => this.emit('log', `[storage] ${line}`))
    this.probeChannel.on('log', (line: string) => this.emit('log', `[probe] ${line}`))

    this.status = {
      state: 'idle',
      profile: this.profile,
      browserPath: null,
      browserVersion: null,
      browserArgs: [],
      userDataDir: null,
      targets: [],
      requestCount: 0,
      inst: 0,
      storage: this.storage.getHealth(),
      body: {
        paused: 0,
        captured: 0,
        capturedBytes: 0,
        tooLarge: 0,
        streaming: 0,
        empty: 0,
        unmatched: 0,
        timeouts: 0,
        errors: 0,
        inFlight: 0,
        continueMethod: 'Fetch.continueResponse'
      },
      bodyMode: options.captureBodies ? `Fetch 拦截 (${options.bodyTypes.join('/')})` : '关闭',
      scriptCount: 0,
      proxy: { running: false, host: null, port: null, spki: null, flows: 0, merge: null }
    }

    try {
      this.scopePrefix = new URL(options.startUrl).origin
    } catch {
      this.scopePrefix = options.startUrl
    }

    this.correlator = makeCorrelator({
      windowMs: options.proxyMergeWindowMs ?? DEFAULT_WINDOW_MS,
      // 受控范围 = 本次观测的站点。Chrome 自己发的连通性探测/变体种子在浏览器进程里，
      // CDP 的页面 target 看不到，会如实变成 proxy-only —— 拿它们稀释关联率没有意义。
      inScope: (url: string) => url.startsWith(this.scopePrefix)
    })
  }

  getStatus(): ControllerStatus {
    return this.status
  }

  /* -------------------------------------------------------------- 干预规则 */

  getRuleSet(): RuleSet {
    return this.rules.ruleSet
  }

  getRuleStats(): RuleStats {
    return this.rules.stats()
  }

  /** 换规则集：引擎立刻重编，注入脚本同步给采集侧 */
  setRuleSet(set: RuleSet): RuleStats {
    this.rules.setRules(set)
    this.collector?.setRuleSet(this.rules.ruleSet)
    // 代理那条路也得跟着换，否则规则改了、大 body 还在按旧规则改
    this.syncProxyRules()
    const stats = this.rules.stats()
    this.emit(
      'log',
      `[rules] 生效 ${stats.total} 条，丢弃 ${stats.invalid.length} 条，注入 ${stats.injections} 段`
    )
    return stats
  }

  clear(): void {
    this.queue = []
    this.requestCount = 0
    this.scriptCount = 0
    // 计数归零了就必须推一次状态：flush() 在队列为空时会提前返回，
    // 只靠它同步的话，清空之后 agent 查 /status 还会读到清空前的旧计数
    this.patchStatus({ requestCount: 0, scriptCount: 0 })
  }

  /* ---------------------------------------------------------------- 启动 */

  /**
   * 把规则集里「代理能等价执行」的那部分下发下去（§6.3 第 2 条）。
   * 代理没起来就什么都不做 —— 大 body 改写在代理缺席时本来就没有执行方，
   * 这里不能假装成功，也不该让主进程的规则因此少一条。
   */
  private syncProxyRules(): void {
    if (!this.proxy) return
    const { rules, skipped } = toProxyRules(this.rules.ruleSet)
    this.proxy.setRules(rules).catch((err: unknown) => {
      this.emit('log', `代理规则下发失败: ${err instanceof Error ? err.message : String(err)}`)
    })
    if (skipped.length > 0) {
      this.emit(
        'log',
        `[rules] 代理层跳过 ${skipped.length} 条 body 规则（代理拿不到这些匹配信号）：` +
          skipped.map((s) => s.ruleName + ' - ' + s.message).join('；')
      )
    }
  }

  /**
   * 拉本地代理并返回要追加给 Chromium 的开关。
   * 失败不致命：代理是「补 DNS/TLS + 大 body 改写」的增量能力，
   * 起不来就退回纯 CDP 采集，但要让 UI 看见失败原因。
   */
  private async startProxy(): Promise<string[]> {
    if (!this.options.proxy) return []
    const keyFile = this.options.proxyKeyFile ?? join(this.options.userDataDir, 'proxy-ca.key')
    const client = new ProxyClient({
      keyFile,
      // 代理侧 body 采样上限和 CDP 那条路保持同一个数
      bodyMaxBytes: this.options.bodyMaxBytes,
      /**
       * §6.3 第 2 条的分界：声明长度 > bodyMaxBytes 的响应才在代理层改 body。
       * 必须和 CDP 那条路（body-capture.ts 的 tooLarge 判据）用同一个阈值 ——
       * 两边重叠会把同一条 body 改两遍，比漏改严重得多。
       */
      sinkAboveBytes: this.options.bodyMaxBytes,
      ...(this.options.proxyRewriteMaxBytes !== undefined
        ? { rewriteMaxBytes: this.options.proxyRewriteMaxBytes }
        : {}),
      ...(this.options.proxyUpstreamRejectUnauthorized !== undefined
        ? { upstreamRejectUnauthorized: this.options.proxyUpstreamRejectUnauthorized }
        : {})
    })
    client.on('flow', (flow: ProxyFlow) => {
      this.correlator.addFlow(flow)
      // UI 侧只需要节流后的计数，flow 本体在记录关联时随记录一起走
      this.patchStatus({
        proxy: {
          running: true,
          host: this.proxy?.startInfo?.host ?? null,
          port: this.proxy?.startInfo?.port ?? null,
          spki: this.proxy?.startInfo?.spki ?? null,
          flows: client.flowsSeen,
          merge: this.correlator.scopeStats
        }
      })
    })
    client.on('log', (line: string) => this.emit('log', `[proxy] ${line}`))
    try {
      const info = await client.start()
      this.proxy = client
      this.proxyInfo = info
      this.proxyError = null
      // 规则可能已经先到了（setRuleSet 在 start 之前）：起完代理立刻补下发一次，
      // 保证浏览器发出的第一条请求就已经受规则约束
      this.syncProxyRules()
      this.emit('log', `代理: 127.0.0.1:${info.port} SPKI=${info.spki}`)
      this.patchStatus({
        proxy: { running: true, host: info.host, port: info.port, spki: info.spki, flows: 0, merge: null }
      })
      return client.browserArgs()
    } catch (err) {
      this.proxyError = err instanceof Error ? err.message : String(err)
      this.emit('log', `代理启动失败: ${this.proxyError}`)
      this.patchStatus({
        proxy: { running: false, host: null, port: null, spki: null, flows: 0, merge: null, error: this.proxyError }
      })
      return []
    }
  }

  async start(): Promise<void> {
    this.patchStatus({ state: 'launching' })

    const executablePath = locateBrowser()
    if (!executablePath) {
      this.patchStatus({
        state: 'error',
        error: '没有找到 Chromium 内核。设置 CHROME_PATH 环境变量，或安装 Chrome/Edge。'
      })
      return
    }

    try {
      // 代理必须在浏览器之前起来：--proxy-server 里的端口要等代理 listen 完才知道
      const proxyArgs = await this.startProxy()
      const extraArgs = [...(this.options.extraArgs ?? []), ...proxyArgs]

      const launched = launchBrowser({
        executablePath,
        userDataDir: this.options.userDataDir,
        // 先用 about:blank 起，等接管完成再导航 —— 否则页面首屏请求
        // 会在 attach 之前就发完，一条都抓不到
        url: 'about:blank',
        headless: this.options.headless,
        ...(extraArgs.length ? { extraArgs } : {})
      })

      const child = launched.child
      const cdp = new CdpClient(launched.transport)
      this.child = child
      this.cdp = cdp
      this.probeRunner = new ProbeRunner(
        cdp,
        this.probeChannel,
        this.profile,
        // Profile H 下 Runtime 是红线（§3.4），探针只能走注入 + 信标回传
        this.profile === 'L'
      )
      this.input = new InputAutomation(cdp)
      // DOM 检查器也在这时候建：它的 domain 全是「第一次用才 enable」，起点零开销
      this.dom = new DomInspector(cdp)
      this.shot = new Screenshotter(cdp)

      this.patchStatus({
        state: 'connecting',
        browserPath: executablePath,
        browserArgs: launched.args,
        userDataDir: this.options.userDataDir
      })

      // 收工重启时旧进程的 exit 会晚一步到（kill 之后才真退出）。不加这道闸，
      // 它会顺手把刚起来的新会话也 stop 掉 —— switchProfile 就死在这里。
      child.on('exit', (code, signal) => {
        if (this.child !== child) return
        this.stop()
        this.patchStatus({
          state: 'error',
          error: `浏览器已退出 (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
        })
      })

      cdp.on('error', (err: Error) => {
        // 同上：旧连接的错误不该改新会话的状态
        if (this.cdp !== cdp) return
        this.patchStatus({ state: 'error', error: err.message })
      })

      // 用一次 Browser.getVersion 确认 pipe 真的通了
      const version = (await this.cdp.send('Browser.getVersion')) as unknown as {
        product: string
        jsVersion: string
        userAgent: string
      }

      // 存储要在采集之前起来，否则前面的请求会进不了库
      const health = await this.storage.start({
        url: this.options.startUrl,
        profile: this.profile,
        kernel: executablePath,
        kernelVersion: version.product,
        userAgent: version.userAgent,
        args: launched.args
      })
      this.emit('log', `存储: ${health.enabled ? `已启用 (node ${health.nodeVersion})` : `未启用 - ${health.error}`}`)

      const bodyConfig: BodyConfig = {
        enabled: this.options.captureBodies,
        resourceTypes: new Set(this.options.bodyTypes.length ? this.options.bodyTypes : DEFAULT_BODY_TYPES),
        maxBytes: this.options.bodyMaxBytes,
        timeoutMs: this.options.bodyTimeoutMs
      }

      const scriptConfig: ScriptConfig = {
        enabled: this.options.captureScripts && this.profile === 'L',
        maxSourceBytes: this.options.scriptMaxBytes,
        maxScripts: this.options.scriptMaxCount,
        concurrency: this.options.scriptConcurrency,
        timeoutMs: this.options.scriptTimeoutMs
      }

      this.collector = new Collector(
        this.cdp,
        this.profile,
        bodyConfig,
        scriptConfig,
        this.rules,
        this.probeChannel
      )
      // 启动前就设好的注入脚本要在会话建立时生效
      this.collector.setRuleSet(this.rules.ruleSet)
      this.collector.on('record', (record: RequestRecord, first: boolean) => {
        // 以 CDP 为主键，代理记录只作补充字段 merge 进来（§4.3）。
        // 配不上就标 cdp-only 照常入库 —— 关联失败绝不等于丢数据。
        const merged = this.options.proxy ? this.correlate(record, first) : record
        this.enqueue(merged, first)
      })
      this.collector.on('body', (body: CapturedBody) => this.onBody(body))
      this.collector.on('script', (record: ScriptRecord) => this.onScript(record))
      this.collector.on('targets', (targets: TargetInfo[]) => {
        this.patchStatus({ targets })
      })
      this.collector.on('log', (line: string) => this.emit('log', line))
      // 页面换文档后节点编号作废：清掉 DOM 面板缓存的根，下次调用重新取
      this.collector.on('navigated', () => this.dom?.forgetNodes())
      this.collector.on('console', (entry: ConsoleEntry) => this.emit('console', entry))
      this.collector.on(
        'target-attached',
        (info: { type: string; url: string; monitored: boolean }) => {
          this.emit('log', `[target] ${info.monitored ? '采集' : '忽略'} ${info.type} ${info.url.slice(0, 90)}`)
        }
      )

      await this.collector.start()

      // 关键顺序：先接管，再放行
      await this.navigateStartUrl()

      // 窗口状态直接决定 outerWidth/Height 与 visibilityState，也就决定页面像不像真人在看
      await this.normalizeWindow()

      this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS)

      const fetchError = this.collector.getFetchError()
      this.patchStatus({
        state: 'connected',
        browserVersion: version.product,
        targets: this.collector.getTargets(),
        inst: this.storage.getInstId(),
        error: fetchError ? `Fetch 域启用失败：${fetchError}` : undefined
      })
    } catch (err) {
      this.patchStatus({
        state: 'error',
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  /** 收工。可以 await —— 验收脚本要求体面退出时用这个，别用 stop()。 */
  async shutdown(): Promise<void> {
    // 顺序不能换：先让代理把还开着的长连接（SSE/流式响应）补报出来，
    // 再走 stop() 里的关联器 flush() —— 反了的话这些 flow 会晚一步到，全成孤儿。
    await this.proxy?.drain()
    this.stop()
    await this.proxy?.stop()
    await this.storage.shutdown()
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer)
    this.flushTimer = null

    // summary() 在收工之后才打，这里先把注入统计留下来（collector 随后就置空了）
    this.injectionSnapshot = this.collector?.getInjectionStats() ?? null
    this.consoleSnapshot = this.collector?.getConsole() ?? []

    // 先把还在飞的请求补成记录，再统一入队，否则它们会整条丢掉
    this.collector?.flushInflight()
    // 代理看到、CDP 没看到的那些（采集盲区）在这里补成 proxy-only 记录 —— 保留，不丢（§4.3）
    if (this.proxy) {
      for (const orphan of this.correlator.flush()) this.enqueue(orphan, true)
    }
    this.flush()

    // 存储进程要在浏览器之前收 —— 队列里还有没落盘的东西
    void this.storage.shutdown()

    if (this.child && !this.child.killed) {
      this.child.kill()
    }
    this.child = null
    this.cdp = null
    this.collector = null
    this.probeRunner = null
    this.input = null
    this.dom = null
    this.shot = null
    this.domLogged.clear()
  }

  /** 自动收工路径要一行可读的汇总，不然验收只能靠猜 */
  summary(): Record<string, unknown> {
    const targetTypes: Record<string, number> = {}
    for (const target of this.status.targets) {
      targetTypes[target.type] = (targetTypes[target.type] ?? 0) + 1
    }
    return {
      state: this.status.state,
      inst: this.storage.getInstId(),
      requestCount: this.requestCount,
      storage: this.storage.getHealth(),
      body: this.status.body,
      rules: this.rules.stats(),
      injections: this.collector?.getInjectionStats() ?? this.injectionSnapshot,
      probe: this.probeChannel.getStats(),
      consoleLines: (this.collector?.getConsole() ?? this.consoleSnapshot).length,
      // P5：代理有没有起来、以及三源关联率（§12 的 ≥95% 就是这个数）
      proxy: {
        // running 是「此刻还在跑吗」，started 是「这次会话起过吗」——
        // summary 是在收工之后打的，只看 running 会误报成没起过
        running: this.proxy?.running ?? false,
        started: this.proxyInfo !== null,
        host: this.proxyInfo?.host ?? null,
        port: this.proxyInfo?.port ?? null,
        spki: this.proxyInfo?.spki ?? null,
        flows: this.proxy?.flowsSeen ?? 0,
        // 受控范围的关联率（§12）；rawMerge 是全量，含 Chrome 的后台请求
        merge: this.correlator.scopeStats,
        rawMerge: this.correlator.stats,
        scope: this.scopePrefix,
        timingSample: this.proxyTimingSample,
        timingEvidence: { ...this.timingEvidence },
        error: this.proxyError
      },
      targets: this.status.targets.length,
      targetTypes,
      error: this.status.error ?? null
    }
  }

  /* ------------------------------------------------------- 探针与控制台（P6） */

  /** §3.2 的能力矩阵落到运行时。UI 拿它禁用按钮，而不是让用户点了才报错 */
  getCapabilities(): CapabilitySet {
    const profile = this.profile
    const runtime = profile === 'L'
    return {
      profile,
      runtime,
      debugger: runtime,
      emulation: runtime,
      probe: probeCapability(profile, runtime),
      probeVia: runtime ? 'evaluate' : 'inject',
      input: this.cdp !== null,
      captureScripts: runtime && this.options.captureScripts,
      dom: runtime ? 'full' : 'ondemand',
      // 截图走 Page domain（采集本来就开了），两个 Profile 都能用
      screenshot: true
    }
  }

  /**
   * 等一个 page 会话。启动头几秒 target 是陆续 attach 的，这时候用户（或验收脚本）
   * 点「运行探针」、在控制台求值、跑拟人化输入，都不该被一句「还没有 page 会话」打发掉。
   */
  private async waitPageSession(timeoutMs = 15000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const sessionId = this.collector?.findSessionByTargetType('page')
      if (sessionId) return sessionId
      if (Date.now() >= deadline) return null
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  async runProbe(
    options: { viaInject?: boolean; timeoutMs?: number } = {}
  ): Promise<{ ok: boolean; report?: ProbeReport; error?: string; via: string }> {
    const via = options.viaInject || this.profile !== 'L' ? 'inject' : 'evaluate'
    if (!this.probeRunner) return { ok: false, error: '浏览器还没起来', via }
    const sessionId = await this.waitPageSession()
    if (!sessionId) return { ok: false, error: '还没有 page 会话，探针没有落点', via }

    try {
      const report = await this.probeRunner.run(sessionId, options)
      this.emit(
        'log',
        `[probe] ${report.url.slice(0, 80)} → 建议 Profile ${report.recommend}` +
          `（pass ${report.summary.pass} / warn ${report.summary.warn} / fail ${report.summary.fail}）`
      )
      return { ok: true, report, via }
    } catch (error) {
      return { ok: false, error: (error as Error).message, via }
    }
  }

  /**
   * 控制台求值（§7.1 #7）。Profile H 下 Runtime 域是红线，这里直接拒绝 ——
   * 让 UI 提前禁用比运行时报错诚实。
   */
  async evaluate(expression: string): Promise<EvaluateResult> {
    const started = Date.now()
    if (this.profile !== 'L') {
      return {
        ok: false,
        error: 'Profile H 未启用 Runtime 域（§3.4 红线），控制台不可用；用注入脚本 + 规则引擎替代',
        durationMs: 0
      }
    }
    if (!this.cdp || !this.collector) return { ok: false, error: '浏览器还没起来', durationMs: 0 }
    const sessionId = await this.waitPageSession()
    if (!sessionId) return { ok: false, error: '还没有 page 会话', durationMs: 0 }

    // 多行输入按 DevTools 的规矩包一层 async IIFE，这样 return / await 都能用
    const source = expression.includes('\n') ? `(async () => {${expression}\n})()` : expression

    try {
      const result = (await this.cdp.send(
        'Runtime.evaluate',
        {
          expression: source,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
          allowUnsafeEvalBlockedByCSP: false
        },
        sessionId
      )) as {
        result?: { type?: string; value?: unknown; description?: string }
        exceptionDetails?: { text?: string; exception?: { description?: string } }
      }

      if (result.exceptionDetails) {
        return {
          ok: false,
          error:
            result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text ??
            '执行异常',
          durationMs: Date.now() - started
        }
      }
      const remote = result.result ?? {}
      return {
        ok: true,
        type: remote.type,
        value: remote.value,
        description: remote.description,
        durationMs: Date.now() - started
      }
    } catch (error) {
      return {
        ok: false,
        error: (error as Error).message,
        durationMs: Date.now() - started
      }
    }
  }

  getConsole(): ConsoleEntry[] {
    return this.collector?.getConsole() ?? this.consoleSnapshot
  }

  clearConsole(): void {
    this.collector?.clearConsole()
    this.consoleSnapshot = []
  }

  /* ------------------------------------------------------------ 拟人化输入 */

  async runInput(action: InputAction): Promise<InputReport> {
    const failed = (message: string): InputReport => ({
      kind: action.kind,
      ok: false,
      points: 0,
      durationMs: 0,
      straight: 0,
      pathLength: 0,
      maxStep: 0,
      minStep: 0,
      maxStepMs: 0,
      minStepMs: 0,
      pauses: 0,
      error: message
    })
    if (!this.input) return failed('浏览器还没起来')
    const sessionId = await this.waitPageSession()
    if (!sessionId) return failed('还没有 page 会话')

    let target = action
    try {
      target = await this.resolveInputTarget(sessionId, action)
      // 用选择器定位的 type：先点一下把它聚焦。不聚焦的话按键事件落不到这个输入框上，
      // 页面看着「什么都没发生」，而报告里还是一次成功的 type —— 假成功比报错更坏
      if (action.kind === 'type' && action.selector) {
        const focus = await this.input.run(sessionId, {
          kind: 'click',
          x: target.x,
          y: target.y,
          seed: action.seed,
          speed: action.speed
        })
        if (!focus.ok) return focus
      }
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error))
    }

    const report = await this.input.run(sessionId, target)
    await this.settleInput(sessionId)
    this.emit(
      'log',
      report.ok
        ? `[input] ${action.kind} → ${report.points} 点 / ${report.durationMs}ms / 路程 ${report.pathLength}px`
        : `[input] ${action.kind} 失败: ${report.error ?? '未知'}`
    )
    return report
  }

  /**
   * 输入收尾：等页面把输入事件真的吃进去。
   *
   * `Input.dispatchMouseEvent` 的回执只说明**浏览器**收下了 —— 事件还要走渲染进程的输入
   * 队列，和随后的 DevTools 消息不是一条通道。不等这一下会出现两种假象：agent 点完立刻
   * 读页面，读到的还是旧状态；下一次动作的事件和上一次的尾巴交错，录出来的轨迹凭空多个
   * 484px 的跳步。让页面自己让两帧就够（输入任务在同一帧里排在前面）。
   * Profile H 不问页面（§3.4 红线），跳过。
   */
  private async settleInput(sessionId: string | null | undefined): Promise<void> {
    if (this.profile !== 'L' || !this.cdp || !sessionId) return
    try {
      await Promise.race([
        this.cdp.send(
          'Runtime.evaluate',
          {
            expression:
              'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(1))))',
            awaitPromise: true,
            returnByValue: true
          },
          sessionId
        ),
        // 页面卡住时不能把「已经落地的输入」拖成失败：收尾是尽力而为
        new Promise((resolve) => setTimeout(resolve, 500))
      ])
    } catch {
      /* 正导航/正忙：收尾失败不影响动作本身的结论 */
    }
  }

  /** 选择器 → 坐标。只在给了 selector 时生效；解不出来就抛，由调用方报失败 */
  private async resolveInputTarget(
    sessionId: string,
    action: InputAction
  ): Promise<InputAction> {
    if (!action.selector || action.kind === 'scroll') return action
    if (!this.dom) throw new Error('DOM 检查器不可用')
    const spot = await this.dom.box(sessionId, action.selector)
    if (!spot) throw new Error(`选择器没找到可见元素：${action.selector}`)
    return { ...action, x: spot.x, y: spot.y }
  }

  /* ---------------------------------------------------------------- 采集 */

  /**
   * 把被监控窗口真正摆到屏幕上。窗口的显示状态直接决定页面读到的
   * outerWidth/Height 与 visibilityState —— 探针的「自动化标记」分组就靠它。
   */
  private async normalizeWindow(): Promise<void> {
    if (!this.cdp) return
    const target = this.status.targets.find((item) => item.type === 'page')
    if (!target) return

    try {
      const { windowId, bounds } = (await this.cdp.send('Browser.getWindowForTarget', {
        targetId: target.targetId
      })) as { windowId: number; bounds?: { windowState?: string } }
      this.emit('log', `[window] 起始状态 ${bounds?.windowState ?? 'unknown'}`)

      const sessionId = this.collector?.findSessionByTargetType('page')
      const wanted = { windowState: 'normal', left: 60, top: 40, width: 1280, height: 900 }

      // 光设 normal 没用：窗口记录是 normal，但它从未被真正显示过，
      // 页面侧读到的 outerWidth/Height 仍然是 0。minimized → normal 这一趟
      // 会强制走一次真实的 ShowWindow，窗口才真的出现。
      //
      // 机器一忙这一趟会翻车：minimize 是异步落到窗口管理器上的，晚发的 normal
      // 可能被它盖回去，窗口就停在最小化（探针实测读到 outerWidth=0x0）。
      // 所以摆完要回读状态，不对就重来；Profile L 还能直接问页面一句。
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await this.cdp.send('Browser.setWindowBounds', {
          windowId,
          bounds: { windowState: 'minimized' }
        })
        await new Promise((resolve) => setTimeout(resolve, 150 + attempt * 150))
        await this.cdp.send('Browser.setWindowBounds', { windowId, bounds: wanted })
        if (sessionId) {
          await this.cdp.send('Page.bringToFront', {}, sessionId).catch(() => undefined)
        }
        await new Promise((resolve) => setTimeout(resolve, 80))

        const after = (await this.cdp.send('Browser.getWindowBounds', { windowId })) as {
          bounds?: { windowState?: string; width?: number; height?: number }
        }
        const placed =
          after.bounds?.windowState === 'normal' &&
          (after.bounds?.width ?? 0) > 0 &&
          (after.bounds?.height ?? 0) > 0
        this.emit(
          'log',
          `[window] 第 ${attempt} 次摆正后 ${after.bounds?.windowState ?? '?'} ` +
            `${after.bounds?.width ?? 0}x${after.bounds?.height ?? 0}`
        )
        if (placed && (await this.pageIsVisible(sessionId))) {
          this.emit('log', `[window] 已摆正 windowId=${windowId}`)
          return
        }
      }
      this.emit('log', '[window] 三次都没摆正，页面侧可能仍读到 outerWidth=0')
    } catch (error) {
      this.emit('log', `[window] 摆正失败: ${(error as Error).message}`)
    }
  }

  /**
   * 页面侧「真的在显示」判据。只有 Profile L 问得了 —— H 不开 Runtime（§3.4 红线），
   * 那边只能靠 Browser.getWindowBounds 的状态兜底。拿不到答案就当没问题，不阻断启动。
   */
  private async pageIsVisible(sessionId: string | null | undefined): Promise<boolean> {
    if (this.profile !== 'L' || !this.cdp || !sessionId) return true
    try {
      // 回读实值而不是只回一个 true/false：竞态只在忙的时候出现，日志里得看得见当时读到什么
      const result = (await this.cdp.send(
        'Runtime.evaluate',
        {
          expression:
            'JSON.stringify([window.outerWidth, window.outerHeight, document.visibilityState])',
          returnByValue: true
        },
        sessionId
      )) as { result?: { value?: unknown } }
      const [width, height, visibility] = JSON.parse(String(result?.result?.value ?? '')) as [
        number,
        number,
        string
      ]
      this.emit('log', `[window] 页面侧 ${width}x${height} ${visibility}`)
      return width > 0 && height > 0 && visibility !== 'hidden'
    } catch {
      return true
    }
  }

  /**
   * 导航到目标 URL。session 可能还没就绪（target 刚建），做一个短重试。
   */
  private async navigateStartUrl(): Promise<void> {
    if (!this.cdp || !this.collector) return
    if (this.options.startUrl === 'about:blank') return

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const sessionId = this.collector.findSessionByTargetType('page')
      if (sessionId) {
        await this.cdp
          .send('Page.navigate', { url: this.options.startUrl }, sessionId)
          .catch((err: Error) => {
            this.patchStatus({ error: `导航失败: ${err.message}` })
          })
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }

    // 静默失败最要命：一个请求都没有，看起来却像「页面很干净」
    this.patchStatus({
      error: '3 秒内没拿到 page session，导航没有下发 —— 采集会是空的'
    })
  }

  /**
   * 三源关联。同一条请求的第二次上报（终态行）复用第一次的结果 ——
   * 每条代理 flow 只能被认领一次，重复调 match() 会凭空造出 cdp-only。
   */
  private correlate(record: RequestRecord, first: boolean): RequestRecord {
    const cacheKey = mergeCacheKey(record)
    const cached = this.mergeCache.get(cacheKey)
    if (cached) return { ...record, ...cached }

    // 终态行本身可能后到；pending 行先到时算出来的结果就缓存在这里
    void first
    const merged = this.correlator.match(record)
    if (merged.mergeState === 'merged') {
      const keep = proxyPatchOf(merged)
      this.mergeCache.set(cacheKey, keep)
      this.countTimings(merged)
      return { ...record, ...keep }
    }
    // 配不上也别丢：标 cdp-only 照常入库（§4.3）
    this.mergeCache.set(cacheKey, { mergeState: merged.mergeState })
    return { ...record, mergeState: merged.mergeState }
  }

  /** 时序证据与样本只在这里累加，别的路径不许自己数（否则同一份证据会重复计） */
  private countTimings(merged: RequestRecord): void {
    for (const key of Object.keys(this.timingEvidence)) {
      if (typeof merged.timings?.[key as keyof typeof merged.timings] === 'number') {
        this.timingEvidence[key] += 1
      }
    }
    if (!this.proxyTimingSample) {
      this.proxyTimingSample = {
        url: merged.url,
        timings: merged.timings ?? {},
        ...(merged.upstreamIp ? { upstreamIp: merged.upstreamIp } : {}),
        ...(merged.tlsVersion ? { tlsVersion: merged.tlsVersion } : {}),
        ...(merged.proxyDeltaMs !== undefined ? { proxyDeltaMs: merged.proxyDeltaMs } : {})
      }
    }
  }

  /**
   * 把关联器的「晚配修正」重投一遍。
   *
   * 长连接（SSE / 流式响应）的 flow 要等收工 drain 才拿得到，那时它的 CDP 记录早就
   * 以 cdp-only 落库了。改了就得让库里那条路知道：同 seq 再入一次队，
   * 存储 upsert 覆盖同一行、UI 是重查库的，所以不会多出一条。
   */
  private applyRevisions(): void {
    for (const revision of this.correlator.takeRevisions()) {
      const patch = proxyPatchOf(revision)
      this.mergeCache.set(mergeCacheKey(revision), patch)
      this.countTimings(revision)
      // first=false：这条请求早就计过数了，重投只是把代理字段补上
      this.enqueue({ ...revision, ...patch }, false)
    }
  }

  private enqueue(record: RequestRecord, first = true): void {
    // 同一条请求会来两次（pending 行 + 终态行），只数第一次 ——
    // 这样「本次采集」和「已落库」是一致的一对数
    if (first) this.requestCount += 1
    this.queue.push(record)

    // 落盘队列是无阻塞的，这里只管 UI
    this.storage.append(record)

    // 背压：UI 消费不过来时丢最旧的，元数据优先于完整性
    if (this.queue.length > 20_000) {
      this.queue.splice(0, this.queue.length - 20_000)
    }
  }

  private onBody(body: CapturedBody): void {
    if (body.bytes && body.bytes.byteLength > 0) {
      this.storage.appendBody(body.seq, body.bytes, false)
      return
    }
    // 拿不到 body 的情况也必须留痕，否则「没有 body」和「没采到」分不清
    this.storage.markBody(body.seq, body.state, body.declaredSize ?? body.size ?? 0)
  }

  /**
   * 脚本和请求不同：它没有「终态」这一说，一条就是一条。
   * 所以这里只计数 + 入存储队列，不往 UI 推（脚本列表是按需查询的）。
   */
  private onScript(record: ScriptRecord): void {
    this.scriptCount += 1
    this.storage.appendScript(record)
  }

  private flush(): void {
    if (this.collector) this.patchStatus({ body: this.collector.getBodyStats() })
    // 必须在「队列为空就返回」之前：修正记录本身就是要入队的东西
    if (this.proxy) this.applyRevisions()
    if (this.queue.length === 0) return
    const batch = this.queue
    this.queue = []
    this.emit('records', batch)
    this.patchStatus({ requestCount: this.requestCount, inst: this.storage.getInstId() })
  }

  /* ---------------------------------------------------------------- 查询 */

  async queryRequests(
    query: RequestQuery,
    limit: number,
    offset: number,
    order: RequestOrder
  ): Promise<Page<StoredRequest> | null> {
    if (!this.storage.isEnabled()) return null
    try {
      return (await this.storage.call('queryRequests', {
        filter: { ...query, inst: this.storage.getInstId() },
        limit,
        offset,
        order
      })) as Page<StoredRequest>
    } catch {
      return null
    }
  }

  async getDetail(seq: number): Promise<RequestDetail | null> {
    if (!this.storage.isEnabled()) return null
    try {
      return (await this.storage.call('queryDetail', {
        inst: this.storage.getInstId(),
        seq
      })) as RequestDetail | null
    } catch (error) {
      this.emit('log', `[storage] 取详情失败 seq=${seq}: ${(error as Error).message}`)
      return null
    }
  }

  async getBody(hash: string, withData: boolean): Promise<BodyPayload | null> {
    if (!this.storage.isEnabled()) return null
    try {
      return (await this.storage.call('getBody', { hash, withData })) as BodyPayload | null
    } catch {
      return null
    }
  }

  async getStats(): Promise<Stats | null> {
    if (!this.storage.isEnabled()) return null
    try {
      return (await this.storage.call('stats', { inst: this.storage.getInstId() })) as Stats
    } catch {
      return null
    }
  }

  /* -------------------------------------------------------------- 脚本 */

  async queryScripts(
    query: ScriptQuery,
    limit: number,
    offset: number,
    order: ScriptOrder
  ): Promise<Page<ScriptRow> | null> {
    if (!this.storage.isEnabled()) return null
    try {
      return (await this.storage.call('queryScripts', {
        inst: this.storage.getInstId(),
        filter: query,
        limit,
        offset,
        order
      })) as Page<ScriptRow>
    } catch {
      return null
    }
  }

  /** 源码单独取：列表查询刻意不带 source，一页脚本能有几十 MB */
  async getScriptSource(hash: string): Promise<ScriptSource | null> {
    if (!this.storage.isEnabled()) return null
    try {
      return (await this.storage.call('getScriptSource', { hash })) as ScriptSource | null
    } catch {
      return null
    }
  }

  async getScriptStats(): Promise<ScriptStats | null> {
    if (!this.storage.isEnabled()) return null
    try {
      return (await this.storage.call('scriptStats', {
        inst: this.storage.getInstId()
      })) as ScriptStats
    } catch {
      return null
    }
  }

  async getTimeline(query: RequestQuery, limit: number): Promise<TimelineRow[]> {
    if (!this.storage.isEnabled()) return []
    try {
      const result = (await this.storage.call('timeline', {
        inst: this.storage.getInstId(),
        filter: query,
        limit
      })) as { rows: TimelineRow[] }
      return result.rows
    } catch {
      return []
    }
  }

  async listInstances(): Promise<InstanceRow[]> {
    if (!this.storage.isEnabled()) return []
    try {
      const result = (await this.storage.call('listInstances')) as { rows: InstanceRow[] }
      return result.rows
    } catch {
      return []
    }
  }

  /**
   * 现捞：Fetch 没拦到的（比如图片），只要资源还在浏览器 buffer 里就能补一刀。
   * 驱逐之后就真没了 —— 这也是为什么默认要拦主要类型而不是全靠现捞。
   */
  async fetchBodyNow(seq: number): Promise<{ ok: boolean; state: string }> {
    if (!this.storage.isEnabled() || !this.collector || !this.cdp) {
      return { ok: false, state: 'storage_off' }
    }
    const ref = this.collector.findRequestRef(seq)
    if (!ref) return { ok: false, state: 'no_ref' }

    try {
      const result = (await this.cdp.send(
        'Network.getResponseBody',
        { requestId: ref.requestId },
        ref.sessionId ?? undefined
      )) as { body: string; base64Encoded: boolean }

      const bytes = result.base64Encoded
        ? new Uint8Array(Buffer.from(result.body, 'base64'))
        : new Uint8Array(Buffer.from(result.body, 'utf8'))

      this.storage.appendBody(seq, bytes, false)
      await this.storage.flushNow()
      return { ok: true, state: 'stored' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const state = /No resource with given identifier/i.test(message) ? 'evicted' : 'failed'
      this.storage.markBody(seq, state === 'evicted' ? 'evicted' : 'error', 0)
      return { ok: false, state }
    }
  }

  /* ------------------------------------------- §7.1 #3 DOM 与元素检查 */

  /**
   * DOM 树。不给 nodeId 取文档根，给了就取那棵子树 —— 懒展开，页面上万节点也只取要看的那些。
   * DOM 域在这一刻才 enable（§3.4 在 H 下标的是「⚠️ 按需」）。
   */
  async domGetTree(
    nodeId?: number,
    depth = 2
  ): Promise<{ ok: boolean; error?: string; rows: DomTreeRow[]; enabledDomains: string[] }> {
    if (!this.cdp || !this.dom) {
      return { ok: false, error: '浏览器还没起来', rows: [], enabledDomains: [] }
    }
    const sessionId = await this.waitPageSession()
    if (!sessionId) return { ok: false, error: '还没有 page 会话', rows: [], enabledDomains: [] }
    try {
      const { rows } = await this.dom.tree(sessionId, nodeId, depth)
      this.logDomains(sessionId, this.dom.enabledDomains(sessionId))
      return { ok: true, rows, enabledDomains: this.dom.enabledDomains(sessionId) }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        rows: [],
        enabledDomains: this.dom.enabledDomains(sessionId)
      }
    }
  }

  /** 元素详情：outerHTML / 盒模型 / 命中样式 / 计算样式 / 事件监听器 */
  async domInspect(target: { selector?: string; nodeId?: number }): Promise<DomInspectResult> {
    if (!this.cdp || !this.dom) {
      return { ok: false, error: '浏览器还没起来', enabledDomains: [], durationMs: 0 }
    }
    const sessionId = await this.waitPageSession()
    if (!sessionId) {
      return { ok: false, error: '还没有 page 会话', enabledDomains: [], durationMs: 0 }
    }
    const result = await this.dom.inspect(sessionId, target)
    this.logDomains(sessionId, result.enabledDomains)
    return result
  }

  /** 页面里高亮一个节点（Overlay），同样按需启用 */
  async domHighlight(
    nodeId: number,
    on: boolean
  ): Promise<{ ok: boolean; error?: string; enabledDomains: string[] }> {
    if (!this.cdp || !this.dom) return { ok: false, error: '浏览器还没起来', enabledDomains: [] }
    const sessionId = await this.waitPageSession()
    if (!sessionId) return { ok: false, error: '还没有 page 会话', enabledDomains: [] }
    try {
      await this.dom.highlight(sessionId, nodeId, on)
      this.logDomains(sessionId, this.dom.enabledDomains(sessionId))
      return { ok: true, enabledDomains: this.dom.enabledDomains(sessionId) }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        enabledDomains: this.dom.enabledDomains(sessionId)
      }
    }
  }

  /**
   * 按需启用的 domain 要留痕：§3.4 把它当「H 下只开白名单 + 必要项」的证据。
   * 传进来的是累计集合，这里只记「这次真正新开的」—— 否则每点一个节点就刷一行日志。
   */
  private logDomains(sessionId: string, domains: string[]): void {
    const fresh = domains.filter((domain) => !this.domLogged.has(domain))
    if (!fresh.length) return
    for (const domain of fresh) this.domLogged.add(domain)
    this.emit('log', `[dom] 按需启用（会话 ${sessionId}）${fresh.join(' / ')}`)
  }

  /* ------------------------------------------------------------- 导航 */

  /**
   * 让被监控页面跳到一个 URL（agent 的「翻页」动作）。
   *
   * 只放 http/https：file:// 和 javascript: 不是「看一个页面」，是别的意图，
   * 而这两个协议的面一旦开了就收不回来。导航完等 load 事件（最多 15s），
   * 再从导航历史里读回真实 URL 与标题 —— 重定向之后请求的和落地的往往不是同一个。
   */
  async navigate(url: string): Promise<NavigateResult> {
    const started = Date.now()
    const cdp = this.cdp
    if (!cdp || !this.collector) return { ok: false, error: '浏览器还没起来', durationMs: 0 }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { ok: false, error: `URL 解析失败：${url}`, durationMs: 0 }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        ok: false,
        error: `只允许 http/https（收到 ${parsed.protocol}）`,
        requestedUrl: url,
        durationMs: 0
      }
    }
    const sessionId = await this.waitPageSession()
    if (!sessionId) return { ok: false, error: '还没有 page 会话', requestedUrl: url, durationMs: 0 }

    let settle: () => void = () => {}
    const loaded = new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        cdp.off('event', onEvent)
        resolve()
      }
      const timer = setTimeout(done, NAVIGATE_LOAD_TIMEOUT_MS)
      const onEvent = (event: { method: string; sessionId?: string }): void => {
        if (event.method === 'Page.loadEventFired' && event.sessionId === sessionId) done()
      }
      settle = done
      cdp.on('event', onEvent)
    })

    try {
      const result = (await cdp.send('Page.navigate', { url }, sessionId)) as { errorText?: string }
      if (result?.errorText) {
        settle()
        return { ok: false, error: result.errorText, requestedUrl: url, durationMs: Date.now() - started }
      }
      await loaded
      const history = (await cdp.send('Page.getNavigationHistory', {}, sessionId)) as {
        currentIndex?: number
        entries?: Array<{ url?: string; title?: string }>
      }
      const entry = history?.entries?.[history.currentIndex ?? -1]
      return {
        ok: true,
        requestedUrl: url,
        url: entry?.url ?? url,
        title: entry?.title ?? '',
        durationMs: Date.now() - started
      }
    } catch (error) {
      settle()
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        requestedUrl: url,
        durationMs: Date.now() - started
      }
    }
  }

  /* ------------------------------------------------------------- 截图 */

  /** 只留最近 SCREENSHOT_KEEP 张，更早的删掉。删不掉就跳过（可能正被别人打开）。 */
  private pruneScreenshots(dir: string): void {
    try {
      const files = readdirSync(dir)
        .filter((name) => name.endsWith('.png') || name.endsWith('.jpg'))
        .map((name) => {
          const full = join(dir, name)
          return { full, at: statSync(full).mtimeMs }
        })
        .sort((a, b) => b.at - a.at)
      for (const item of files.slice(SCREENSHOT_KEEP)) {
        try {
          unlinkSync(item.full)
        } catch {
          /* 删不掉就算了 */
        }
      }
    } catch {
      /* 目录读不到不影响这次截图 */
    }
  }

  /**
   * 截图：视口 / 整页 / 某个元素，PNG 或 JPEG。只读，不改页面状态。
   *
   * 落盘到 <userDataDir>/screenshots/，结果里给绝对路径 —— agent 拿到路径直接读文件，
   * 不必让几 MB 的 base64 从 JSON 里过一遍。要 inline 的（MCP 回 image 块）再加 dataBase64。
   */
  async screenshot(options: ScreenshotOptions = {}): Promise<ScreenshotResult> {
    const started = Date.now()
    if (!this.cdp || !this.shot) return { ok: false, error: '浏览器还没起来', durationMs: 0 }
    const sessionId = await this.waitPageSession()
    if (!sessionId) return { ok: false, error: '还没有 page 会话', durationMs: 0 }
    try {
      const image = await this.shot.capture(sessionId, options)
      const buffer = Buffer.from(image.data, 'base64')
      const dir = join(this.options.userDataDir, 'screenshots')
      mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const suffix = image.format === 'jpeg' ? 'jpg' : 'png'
      const file = join(dir, `${stamp}-${randomUUID().slice(0, 8)}.${suffix}`)
      writeFileSync(file, buffer)
      this.pruneScreenshots(dir)
      const inline = options.inline === true && image.data.length <= MAX_INLINE_BASE64
      this.emit('log', `[shot] ${image.format} ${image.width}×${image.height} ${buffer.length}B → ${file}`)
      return {
        ok: true,
        path: file,
        format: image.format,
        mimeType: image.format === 'jpeg' ? 'image/jpeg' : 'image/png',
        bytes: buffer.length,
        width: image.width,
        height: image.height,
        fullPage: options.fullPage === true && options.nodeId === undefined,
        ...(options.nodeId !== undefined ? { nodeId: options.nodeId } : {}),
        ...(image.clamped ? { clamped: true } : {}),
        ...(inline ? { dataBase64: image.data } : {}),
        ...(options.inline === true && !inline
          ? { inlineSkipped: `图片 ${buffer.length}B 超过 inline 上限，只给了路径` }
          : {}),
        durationMs: Date.now() - started
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started
      }
    }
  }
  /* ------------------------------------------------ §7.1 #9 会话管理 */

  /** 实例列表 + 每实例计数 + 存储分区 + 当前 target */
  async getSessions(): Promise<SessionOverview> {
    const instances = await this.listInstances()
    let stats = new Map<number, InstanceStats>()
    let storage: StorageSummary | null = null
    if (this.storage.isEnabled()) {
      try {
        const rows = (await this.storage.call('instanceStats')) as { rows: InstanceStats[] }
        stats = new Map(rows.rows.map((row) => [row.inst, row]))
      } catch {
        /* 面板不该因为统计取不到就整个空掉 */
      }
      try {
        storage = (await this.storage.call('storageSummary')) as StorageSummary
      } catch {
        storage = null
      }
    }
    return {
      current: this.status.inst,
      instances: instances.map((row) => ({
        ...row,
        stats: stats.get(row.id) ?? null,
        live: row.id === this.status.inst && this.status.state !== 'idle'
      })),
      storage,
      targets: this.status.targets
    }
  }

  /**
   * 切 Profile 重启（§7.1 #9）。
   *
   * 为什么是重启而不是热切：Profile 决定的是启动参数、开哪些 CDP domain、采集侧建不建
   * Debugger 通道 —— 这三样都钉死在浏览器生命周期里。热切只能骗 UI，那是假功能。
   * 这里老老实实收工 → 换 Profile → 重起，库里因此多一条实例记录，会话管理面板正好看得见。
   */
  async switchProfile(
    profile: Profile
  ): Promise<{ ok: boolean; error?: string; profile: Profile }> {
    if (profile === this.profile) return { ok: true, profile }
    if (this.status.state === 'idle') {
      // 还没起来：只改配置，下一次 start() 用它
      this.profile = profile
      this.patchStatus({ profile })
      return { ok: true, profile }
    }

    this.emit('log', `切换 Profile ${this.profile} → ${profile}：收工后重启`)
    try {
      await this.shutdown()
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        profile: this.profile
      }
    }
    this.resetSessionState()
    this.profile = profile
    this.patchStatus({ profile })
    await this.start()
    if (this.status.state === 'error') {
      return { ok: false, error: this.status.error ?? '重启失败', profile }
    }
    return { ok: true, profile }
  }

  /** 重启前把「本次会话」的状态清干净，别让新会话带着上一次的计数、关联缓存与代理快照 */
  private resetSessionState(): void {
    this.correlator = makeCorrelator({
      windowMs: this.options.proxyMergeWindowMs ?? DEFAULT_WINDOW_MS,
      inScope: (url: string) => url.startsWith(this.scopePrefix)
    })
    this.proxy = null
    this.proxyError = null
    this.proxyInfo = null
    this.proxyTimingSample = null
    this.mergeCache.clear()
    for (const key of Object.keys(this.timingEvidence)) this.timingEvidence[key] = 0
    this.injectionSnapshot = null
    this.consoleSnapshot = []
    this.queue = []
    this.requestCount = 0
    this.scriptCount = 0
    this.domLogged.clear()
    if (this.flushTimer) clearInterval(this.flushTimer)
    this.flushTimer = null
    this.patchStatus({ inst: 0, requestCount: 0, scriptCount: 0, targets: [], error: undefined })
  }
  private patchStatus(patch: Partial<ControllerStatus>): void {
    this.status = { ...this.status, ...patch }
    this.emit('status', this.status)
  }
}
