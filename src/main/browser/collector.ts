import { EventEmitter } from 'node:events'
import type { CdpClient, CdpEvent } from './cdp'
import { BodyCapture, type BodyConfig, type BodyCaptureStats, type CapturedBody } from './body-capture'
import { ScriptCapture, type ScriptConfig, type ScriptCaptureStats } from './script-capture'
import type { RuleEngine } from '../rules/engine'
import { stripDots } from './site-data'
import { InjectionRunner } from './injection'
import type { ProbeChannel } from './probe'
import type {
  ConsoleEntry,
  HeaderMap,
  InitiatorFrame,
  InitiatorInfo,
  MonitoredEvent,
  Profile,
  RequestRecord,
  TargetInfo,
  WsFrameRecord
} from '../../shared/types'
import type { RuleSet } from '../../shared/types'

/** 这些 target 类型里的流量都要采，服务端 Worker 同样不能漏 */
const MONITORED_TARGET_TYPES = new Set([
  'page',
  'iframe',
  'worker',
  'shared_worker',
  'service_worker'
])

/**
 * 响应体缓冲。CDP 默认值很小，不改的话大站点会疯狂驱逐，
 * 表现为「偶尔拿不到 body」—— 这不是 bug，是默认值问题。
 */
const NETWORK_BUFFER = {
  maxTotalBufferSize: 100 * 1024 * 1024,
  maxResourceBufferSize: 10 * 1024 * 1024,
  maxPostDataSize: 2 * 1024 * 1024
}

/**
 * seq 反查表的容量。Fetch 域给的是 networkId，要换回我们自己发的 seq，
 * 这张表就是桥。请求量很大，必须有上限，删最老的即可 ——
 * 被删掉的请求 body 会落到 unmatched 分支（只放行不记录），不会出错。
 */
const SEQ_INDEX_LIMIT = 50_000

/**
 * 一条请求挂了多久还没等到终态事件，就先落一次库。见 sweepPending。
 * 取 500ms：正常请求（本地/局域网）基本都能在这之内跑完，不会被多写一次。
 */
const PENDING_VISIBLE_MS = 500
const PENDING_SWEEP_MS = 1000

/** session → 当前文档 URL 的缓存。规则的 frameUrl 过滤要用，别让它无界增长 */
const FRAME_URL_CACHE = 2000

/** 控制台面板只留最近这么多条：它是给人看的，不是审计日志 */
const CONSOLE_RING = 500

/**
 * 事件流里高噪音事件（console / exception）的单实例上限。
 * 事件流的价值在于「稀疏事件一条不丢」，而不是存下每一次 log —— 那个控制台面板已经做了。
 */
const EVENT_NOISY_LIMIT = 20000
/** 单实例最多记多少帧 WebSocket 数据。帧的数量完全由页面决定，必须封顶 */
const WS_FRAME_LIMIT = 20000
/** 单帧 payload 的落库上限。超了截断并标记，别让一条大帧把库撑爆 */
/** WS 连接 → URL 缓存的容量 */
const WS_URL_CACHE = 512


/**
 * 站点资源相关的钩子。
 *
 * 采集器只管「路过的信号」，罐怎么对账、存储怎么扫是 Controller 那边的事 ——
 * 这里只把「刚刚有人种 cookie」「这次请求带上了哪些 cookie」递出去。
 */
export interface SiteHooks {
  /** 响应里带了 Set-Cookie：把「哪个 URL 想种哪些名字」递上去 */
  onSetCookie?: (url: string, names: string[]) => void
  /** 这次请求带上了这些 cookie 的罐内主键：用来记「它被发到过哪些站点」 */
  onCookieSent?: (host: string, keys: string[]) => void
  /** 被第三方 cookie 策略挡下来的那些。研究「谁在被拦」比「谁被种上」更有意思 */
  onCookieBlocked?: (url: string, names: string[]) => void
}

/**
 * 从响应头里挑出 Set-Cookie 的名字。
 *
 * 优先用 headersText 原文：headers 对象把多条 Set-Cookie 折成一条，
 * 而 Expires 里就带逗号，靠逗号拆必然拆错。这里只要名字，所以也不怕
 * 值里有什么怪字符 —— 用户问的是「谁想种什么」，值以浏览器罐里的为准。
 */
function setCookieNames(headersText: string | undefined, headers: Record<string, string> | undefined): string[] {
  const raw: string[] = []
  if (headersText) {
    for (const line of headersText.split(String.fromCharCode(10))) {
      const trimmed = line.trim()
      if (trimmed.length > 11 && trimmed.slice(0, 11).toLowerCase() === 'set-cookie:') raw.push(trimmed.slice(11))
    }
  }
  if (raw.length === 0 && headers) {
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() !== 'set-cookie') continue
      raw.push(...value.split(String.fromCharCode(10)))
    }
  }
  const out: string[] = []
  for (const item of raw) {
    const eq = item.indexOf('=')
    if (eq <= 0) continue
    const name = item.slice(0, eq).trim()
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

/** cookie 罐里的主键，和 storage 侧 cookieKeyOf 必须完全一致 */
function cookieKey(name: string, domain: string, path: string, partitionKey?: string): string {
  return stripDots(String(domain ?? '')).toLowerCase() + '|' + (path || '/') + '|' + name + '|' + String(partitionKey ?? '')
}

function hostOfUrl(url: string | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

interface ConsoleArg {
  type?: string
  subtype?: string
  value?: unknown
  description?: string
  className?: string
  unserializableValue?: string
  preview?: {
    subtype?: string
    properties?: Array<{ name: string; type?: string; value?: string }>
  }
}

/** RemoteObject → 一行可读文本。拿不到值的（被 getter 挡、跨域对象）退回 description */
function describeArg(arg: ConsoleArg | undefined): string {
  if (!arg) return 'undefined'
  if (arg.unserializableValue !== undefined) return arg.unserializableValue
  if (arg.type === 'string') return typeof arg.value === 'string' ? arg.value : String(arg.value)
  if (arg.type === 'undefined') return 'undefined'
  if (arg.subtype === 'null') return 'null'
  if (arg.value !== undefined) {
    return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value)
  }
  const preview = arg.preview
  if (preview?.properties?.length) {
    const body = preview.properties
      .map((property) => (preview.subtype === 'array' ? property.value : property.name + ': ' + property.value))
      .join(', ')
    if (preview.subtype === 'array') return '[' + body + ']'
    return (arg.className ?? 'Object') + ' {' + body + '}'
  }
  return arg.description ?? arg.className ?? arg.type ?? 'unknown'
}

/** CDP 的时间戳有的走秒（Network/Console），有的走毫秒，归一化 */
function toMs(value: number | undefined): number {
  if (!value) return Date.now()
  return value > 1e12 ? value : Math.round(value * 1000)
}

interface RequestRef {
  seq: number
  sessionId: string | null
  requestId: string
}

interface SessionState {
  sessionId: string
  targetId: string
  targetType: string
}

interface InflightRequest {
  record: RequestRecord
  monoStart: number
  /** 我们这边的墙钟。record.startTs 来自 wallTime，可能和本机有偏差 */
  since: number
  /** 已经先落过一次库（还没等到终态事件），见 sweepPending */
  pendingEmitted?: boolean
  /**
   * 这一跳已经认领过的 extraInfo。重定向复用同一个 requestId，而 extraInfo
   * 事件可能**早于**下一跳的 requestWillBeSent 到达 —— 没有这两个标记，
   * 下一跳的请求头就会写到上一跳的记录上。
   */
  claimedReq?: boolean
  claimedResp?: boolean
}

/** 调用栈只留前几帧：parser 型的栈能到几百帧，存下来全是噪音 */
const MAX_INITIATOR_FRAMES = 16
/** 单条 URL 的上限。调用栈里的 URL 常带长 query，几百字就该剪 */
const MAX_INITIATOR_URL = 300

function clipInitiatorUrl(url: string): string {
  return url.length <= MAX_INITIATOR_URL ? url : url.slice(0, MAX_INITIATOR_URL) + '…'
}

/** extraInfo 旁路缓冲的上限：它只是「先到先存」，不能涨成内存泄漏 */
const MAX_EXTRA_INFO = 1024

/** 请求体保留上限。比响应体的 256KB 小：请求体常在内存里跟着 record 走 */
const REQ_BODY_MAX = 64 * 1024

/**
 * CDP 的头是 `{ name: value }`，重名字段用一个 \n 拼成单个值。
 * 拆成数组交下去，面板按数组渲染；`:method` 这类伪头没有展示价值，丢掉。
 */
function toHeaderMap(raw: Record<string, string> | undefined): HeaderMap | undefined {
  if (!raw) return undefined
  const out: HeaderMap = {}
  for (const [name, value] of Object.entries(raw)) {
    if (name.startsWith(':')) continue
    out[name] = value.includes('\n') ? value.split('\n') : value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** CDP 的 initiator → 我们自己的结构。栈截断要如实标出来，别让上层以为看到了全部 */
function toInitiator(raw: NetworkInitiator): InitiatorInfo {
  const all = raw.stack?.callFrames ?? []
  const frames: InitiatorFrame[] = all.slice(0, MAX_INITIATOR_FRAMES).map((frame) => ({
    functionName: frame.functionName || '(anonymous)',
    ...(frame.scriptId ? { scriptId: frame.scriptId } : {}),
    url: clipInitiatorUrl(frame.url ?? ''),
    lineNumber: frame.lineNumber ?? 0,
    columnNumber: frame.columnNumber ?? 0
  }))
  return {
    type: raw.type ?? 'other',
    ...(raw.url ? { url: clipInitiatorUrl(raw.url) } : {}),
    ...(raw.lineNumber !== undefined ? { lineNumber: raw.lineNumber } : {}),
    ...(raw.columnNumber !== undefined ? { columnNumber: raw.columnNumber } : {}),
    frames,
    ...(all.length > frames.length ? { truncated: true } : {})
  }
}

interface NetworkRequestWillBeSent {
  requestId: string
  documentURL?: string
  timestamp: number
  wallTime?: number
  type?: string
  request: {
    url: string
    method: string
    /** 请求体原文。CDP 只在 requestWillBeSent 这一处给（见 reqBody） */
    postData?: string
    hasPostData?: boolean
  }
  redirectResponse?: {
    status: number
    statusText: string
    mimeType: string
  }
  /** 谁发起的这个请求。§7.1 #2 的「initiator 调用栈」就是它 */
  initiator?: NetworkInitiator
}

interface NetworkInitiator {
  type?: string
  url?: string
  lineNumber?: number
  columnNumber?: number
  stack?: {
    callFrames?: Array<{
      functionName?: string
      url?: string
      scriptId?: string
      lineNumber?: number
      columnNumber?: number
    }>
  }
}

interface NetworkResponseReceived {
  requestId: string
  timestamp: number
  type?: string
  response: {
    status: number
    statusText: string
    mimeType: string
    fromDiskCache?: boolean
    fromServiceWorker?: boolean
    encodedDataLength?: number
  }
}

interface NetworkLoadingFinished {
  requestId: string
  timestamp: number
  encodedDataLength: number
}

interface NetworkLoadingFailed {
  requestId: string
  timestamp: number
  errorText: string
}

/** Network.requestWillBeSentExtraInfo：请求头只有这条路能拿到 */
interface AssociatedCookie {
  cookie?: { name: string; domain: string; path: string; partitionKey?: string }
  blockedReasons?: string[]
}

interface NetworkRequestExtraInfo {
  requestId: string
  headers?: Record<string, string>
  associatedCookies?: AssociatedCookie[]
}

/** Network.responseReceivedExtraInfo：响应头（含 Set-Cookie 原文）走这条 */
interface NetworkResponseExtraInfo {
  requestId: string
  headers?: Record<string, string>
  headersText?: string
  statusCode?: number
  blockedCookies?: AssociatedCookie[]
}

interface AttachedToTarget {
  sessionId: string
  targetInfo: { targetId: string; type: string; url: string }
  waitingForDebugger?: boolean
}

function params<T>(event: CdpEvent): T {
  return event.params as unknown as T
}

/**
 * 采集器：把 CDP 的 Network 域事件归一化成 RequestRecord。
 *
 * 关键点是**多 target 覆盖** —— 只 attach 主 frame 会漏掉 OOPIF、
 * Web Worker 和 Service Worker 里的全部流量，现代站点一半请求在 SW 里。
 */
export class Collector extends EventEmitter {
  private readonly sessions = new Map<string, SessionState>()
  /**
   * targetId → 已经开着域的那个 session。
   *
   * 同一个 target 可能被两个父会话各 attach 一次 —— 实测 Service Worker
   * 会被 root 会话和 page 会话各报一次，两个 sessionId 都带
   * waitingForDebugger。两条 session 都开 Network 的话，同一个请求会被
   * 上报两遍，库里就多出一倍的重复行。只留一个。
   */
  private readonly primarySession = new Map<string, string>()
  private readonly targets = new Map<string, TargetInfo>()
  private readonly inflight = new Map<string, InflightRequest>()
  private sweepTimer: NodeJS.Timeout | null = null

  /** seq 单调递增，作为这条请求在存储层的唯一身份 */
  private nextSeq = 1
  /** `sessionId|requestId` → seq */
  private readonly seqByKey = new Map<string, number>()
  /**
   * 站点存储（DOMStorage / IndexedDB / CacheStorage / ServiceWorker）的 session 挂载。
   * 这几个域的 enable 是按 session 生效、事件也只投给开了的那个 session，
   * 所以得跟着会话生命周期走。实现由 Controller 注入 —— 采集器不持有 SiteData。
   */
  siteAttach: ((sessionId: string, targetType: string) => Promise<void>) | null = null

  /** seq → (sessionId, requestId)，供「现捞 body」反查 */
  private readonly refBySeq = new Map<number, RequestRef>()
  private readonly bodyCapture: BodyCapture
  private readonly scriptCapture: ScriptCapture
  private readonly injection: InjectionRunner
  /** sessionId → 该 session 最近一次请求的 documentURL（≈ 当前文档） */
  private readonly frameUrls = new Map<string, string>()
  private fetchEnableError: string | null = null
  /** MONITOR_TRACE 命中的 URL 会把生命周期事件打出来，排查漏抓用 */
  private readonly traceFilter: string | null = process.env['MONITOR_TRACE'] ?? null

  /**
   * ExtraInfo 旁路缓冲，按 `sessionId|requestId` 暂存。
   *
   * CDP 明确说了不保证 requestWillBeSentExtraInfo 与 requestWillBeSent 谁先到，
   * 所以先到的先存着，等记录建好再认领（见 claimExtraInfo）。不这么兜一手，
   * 表现就是「头时有时无」。
   */
  private readonly extraInfo = new Map<string, { req?: HeaderMap; resp?: HeaderMap }>()

  /** 控制台环形缓冲（§7.1 #7）。只给面板看，不落库 */
  private readonly consoleRing: ConsoleEntry[] = []
  private nextConsoleId = 1

  constructor(
    private readonly cdp: CdpClient,
    private readonly profile: Profile,
    bodyConfig: BodyConfig,
    scriptConfig: ScriptConfig,
    rules: RuleEngine | null = null,
    /** 探针信道：信标请求要在这里被认出来，别当成页面流量 */
    private readonly probe: ProbeChannel | null = null,
    /** 下载落盘目录。自动化跑一遍不该往用户的 Downloads 里丢东西 */
    private readonly downloadDir: string | null = null,
    /** 站点资源的钩子（Set-Cookie / associatedCookies）。不传就是纯流量采集 */
    private readonly siteHooks: SiteHooks | null = null
  ) {
    super()
    this.bodyCapture = new BodyCapture(
      cdp,
      bodyConfig,
      (sessionId, networkId) => this.resolveSeq(sessionId, networkId),
      (sessionId) => this.sessionMeta(sessionId),
      (body: CapturedBody) => this.emit('body', body),
      rules,
      probe
    )
    this.scriptCapture = new ScriptCapture(cdp, scriptConfig, (record) =>
      this.emit('script', record)
    )
    this.injection = new InjectionRunner(cdp, profile === 'L')
    this.cdp.on('event', (event: CdpEvent) => {
      void this.onEvent(event)
    })
  }

  async start(): Promise<void> {
    await this.cdp.send('Target.setDiscoverTargets', { discover: true })

    // 下载落到本次会话的数据目录里。两个理由：自动化不该用用户的下载夹；
    // 「文件真的落了盘」是验收与事后取证都要的外部证据。
    // eventsEnabled 让 Browser.downloadWillBegin/Progress 也上来（Page 域那份照旧，去重在 claimDownload）
    if (this.downloadDir) {
      await this.cdp
        .send('Browser.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: this.downloadDir,
          eventsEnabled: true
        })
        .catch(() => undefined)
    }

    // flatten 让所有子 target 复用同一条 pipe，不需要额外连接
    await this.cdp.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true
    })

    const { targetInfos } = (await this.cdp.send('Target.getTargets')) as unknown as {
      targetInfos: Array<{ targetId: string; type: string; url: string; attached: boolean }>
    }

    for (const info of targetInfos) {
      // 注意：setAutoAttach 的 attachedToTarget 事件是异步到的，
      // 可能已经写进 targets 了。这里直接 set 会把它的 sessionId 抹掉，
      // 结果 findSessionByTargetType 永远返回 null、导航静默失败。
      const existing = this.targets.get(info.targetId)
      if (existing) {
        existing.type = info.type
        existing.url = info.url
      } else {
        this.targets.set(info.targetId, {
          targetId: info.targetId,
          type: info.type,
          url: info.url,
          attached: info.attached,
          sessionId: null
        })
      }

      if (!MONITORED_TARGET_TYPES.has(info.type)) continue
      // 没有 sessionId 就去 attach —— 已 attach 的会返回同一个 sessionId，
      // 而且 enableSession 幂等，重复调用无害。这里不能因为 info.attached
      // 就跳过，auto-attach 抢先时 sessionId 还没落到我们手上。
      if (!this.targets.get(info.targetId)?.sessionId) {
        await this.attach(info.targetId)
      }
    }

    this.emitStatus()

    // 卡住的请求也要能被看见，见 sweepPending
    this.sweepTimer = setInterval(() => this.sweepPending(), PENDING_SWEEP_MS)
    this.sweepTimer.unref()
  }

  getTargets(): TargetInfo[] {
    return [...this.targets.values()]
  }

  getBodyStats(): BodyCaptureStats {
    return this.bodyCapture.getStats()
  }

  /**
   * 规则集变更：注入脚本立刻换掉；规则本身由 Controller 装进引擎。
   *
   * 还必须让 BodyCapture 把 Fetch 的拦截范围重算一遍 —— patterns 是 enable 时
   * 算死的，而 CDP 的 session 跨导航存活，不重发的话「运行中新增的规则」
   * 永远等不到 requestPaused（实测：规则写进去了、页面也重载了，blocked 恒为 0）。
   */
  setRuleSet(set: RuleSet): void {
    this.injection.setInjections(set.injections)
    this.bodyCapture.refreshAll()
  }

  getInjectionStats(): ReturnType<InjectionRunner['getStats']> {
    return this.injection.getStats()
  }

  /** 规则的 frameUrl / targetType 过滤条件来源 */
  private sessionMeta(sessionId: string | undefined): { targetType?: string; frameUrl?: string } {
    if (!sessionId) return {}
    return {
      targetType: this.sessions.get(sessionId)?.targetType,
      frameUrl: this.frameUrls.get(sessionId)
    }
  }

  private rememberFrameUrl(sessionId: string | undefined, url: string): void {
    if (!sessionId || !url) return
    this.frameUrls.set(sessionId, url)
    if (this.frameUrls.size > FRAME_URL_CACHE) {
      const oldest = this.frameUrls.keys().next().value
      if (oldest !== undefined) this.frameUrls.delete(oldest)
    }
  }

  getScriptStats(): ScriptCaptureStats {
    return this.scriptCapture.getStats()
  }

  getConsole(): ConsoleEntry[] {
    return this.consoleRing.slice()
  }

  clearConsole(): void {
    this.consoleRing.length = 0
  }

  private pushConsole(entry: Omit<ConsoleEntry, 'id'>): void {
    const item: ConsoleEntry = { ...entry, id: this.nextConsoleId++ }
    this.consoleRing.push(item)
    if (this.consoleRing.length > CONSOLE_RING) this.consoleRing.shift()
    this.emit('console', item)
  }

  private onConsole(event: CdpEvent): void {
    const p = event.params as unknown as {
      type?: string
      args?: ConsoleArg[]
      timestamp?: number
      stackTrace?: { callFrames?: Array<{ url?: string; lineNumber?: number }> }
    }
    const frame = p.stackTrace?.callFrames?.[0]
    const level = p.type ?? 'log'
    const text = (p.args ?? []).map(describeArg).join(' ')
    this.pushConsole({
      ts: toMs(p.timestamp),
      level,
      text,
      url: frame?.url,
      line: frame?.lineNumber === undefined ? undefined : frame.lineNumber + 1,
      targetType: event.sessionId ? this.sessions.get(event.sessionId)?.targetType : undefined
    })
    // 只有 error / warning / assert 进事件流：log 类留在控制台环形缓冲里。
    // 事件流是要「回看」的时间线，不能被页面的 log 冲垮（上限见 emitEvent）
    if (level === 'error' || level === 'warning' || level === 'assert') {
      this.emitEvent({
        ts: toMs(p.timestamp),
        kind: 'console',
        level: level === 'warning' ? 'warn' : 'error',
        url: frame?.url,
        targetType: this.targetTypeOf(event),
        detail: {
          text,
          consoleType: level,
          line: frame?.lineNumber === undefined ? undefined : frame.lineNumber + 1
        }
      })
    }
  }

  private onException(event: CdpEvent): void {
    const p = event.params as unknown as {
      timestamp?: number
      exceptionDetails?: {
        text?: string
        url?: string
        lineNumber?: number
        exception?: { description?: string }
      }
    }
    const details = p.exceptionDetails
    const text = details?.exception?.description ?? details?.text ?? '未知异常'
    this.pushConsole({
      ts: toMs(p.timestamp),
      level: 'error',
      text,
      url: details?.url,
      line: details?.lineNumber === undefined ? undefined : details.lineNumber + 1,
      targetType: event.sessionId ? this.sessions.get(event.sessionId)?.targetType : undefined
    })
    this.emitEvent({
      ts: toMs(p.timestamp),
      kind: 'exception',
      level: 'error',
      url: details?.url,
      targetType: this.targetTypeOf(event),
      detail: { text, line: details?.lineNumber === undefined ? undefined : details.lineNumber + 1 }
    })
  }

  stopScriptCapture(): void {
    this.scriptCapture.stop()
  }

  getFetchError(): string | null {
    return this.fetchEnableError
  }

  /**
   * Fetch 域报的 networkId 就是 Network 域的 requestId，两者同一个值。
   * 重定向复用 requestId，映射会指向最新一跳 —— 重定向本身没有 body，不会串台。
   */
  resolveSeq(sessionId: string | undefined, networkId: string): number | undefined {
    return this.seqByKey.get(`${sessionId ?? 'root'}|${networkId}`)
  }

  /** 内存里还有这条请求的引用时，可以直接去浏览器 buffer 现捞 body */
  findRequestRef(seq: number): { sessionId: string | null; requestId: string } | null {
    const ref = this.refBySeq.get(seq)
    return ref ? { sessionId: ref.sessionId, requestId: ref.requestId } : null
  }

  private indexSeq(seq: number, key: string, sessionId: string | null, requestId: string): void {
    this.seqByKey.set(key, seq)
    this.refBySeq.set(seq, { seq, sessionId, requestId })
    if (this.seqByKey.size > SEQ_INDEX_LIMIT) {
      let toDrop = this.seqByKey.size - SEQ_INDEX_LIMIT
      for (const oldKey of this.seqByKey.keys()) {
        if (toDrop <= 0) break
        this.seqByKey.delete(oldKey)
        toDrop -= 1
      }
    }
    if (this.refBySeq.size > SEQ_INDEX_LIMIT) {
      let toDrop = this.refBySeq.size - SEQ_INDEX_LIMIT
      for (const oldSeq of this.refBySeq.keys()) {
        if (toDrop <= 0) break
        this.refBySeq.delete(oldSeq)
        toDrop -= 1
      }
    }
  }

  /** 按 target 类型找已 attach 的 session，用于主动下发导航 */
  findSessionByTargetType(targetType: string): string | null {
    for (const info of this.targets.values()) {
      if (info.type === targetType && info.sessionId) return info.sessionId
    }
    return null
  }

  findSessionByTargetId(targetId: string): string | null {
    return this.targets.get(targetId)?.sessionId ?? null
  }

  targetIdForSession(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.targetId ?? null
  }

  private async attach(targetId: string): Promise<void> {
    try {
      const { sessionId } = (await this.cdp.send('Target.attachToTarget', {
        targetId,
        flatten: true
      })) as unknown as { sessionId: string }

      const info = this.targets.get(targetId)
      if (info) {
        info.attached = true
        info.sessionId = sessionId
      }
      await this.enableSession(sessionId, targetId, info?.type ?? 'unknown')
    } catch {
      // 目标可能在 attach 前就销毁了，忽略
    }
  }

  /** 幂等：自 attach 和 auto-attach 可能对同一 session 各触发一次 */
  private async enableSession(
    sessionId: string,
    targetId: string,
    targetType: string
  ): Promise<void> {
    if (this.sessions.has(sessionId)) return
    this.sessions.set(sessionId, { sessionId, targetId, targetType })

    const tasks: Array<Promise<unknown>> = [
      this.cdp.send('Network.enable', NETWORK_BUFFER, sessionId),
      this.cdp.send('Page.enable', {}, sessionId).catch(() => undefined)
    ]

    // 每个 session 都要单独开一次 autoAttach。
    // 只在 root session 上开是不够的：页面里创建的 Dedicated Worker / OOPIF
    // 是相对于页面 target 的子 target，root 那次不会把它们带出来 ——
    // 实测就是 Worker 里的请求一条都看不到（验收时漏了 /worker-data.json）。
    tasks.push(
      this.cdp
        .send(
          'Target.setAutoAttach',
          { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
          sessionId
        )
        .catch(() => undefined)
    )

    // 每个 session 单独开 Fetch，否则那个 target 的 body 全是空的。
    // 失败不能让整个 enable 挂掉 —— 页面能跑比拿到 body 重要。
    if (this.bodyCapture.isEnabled()) {
      tasks.push(
        this.bodyCapture.enable(sessionId).catch((error: Error) => {
          // 有些 target 天生没有 Fetch 域（browser / other 之流），开不上不算故障。
          // 早先不分目标一律记进 fetchEnableError，结果状态栏被这类目标污染成
          // 「Fetch 域启用失败」，探针面板跟着整块不出报告 —— 只有页面和 iframe
          // 上失败才说明真的坏了。
          this.emit('log', `[fetch] ${targetType} 开 Fetch 失败: ${error.message}`)
          if (targetType === 'page' || targetType === 'iframe') {
            this.fetchEnableError = error.message
          }
        })
      )
    }

    // Profile L 才开 Runtime。Profile H 下 Runtime.enable 是红线：
    // 它会改变 V8 里 console 的代码路径，页面测一下耗时就知道有调试器连着。
    if (this.profile === 'L') {
      tasks.push(this.cdp.send('Runtime.enable', {}, sessionId).catch(() => undefined))
    }

    // 脚本采集同理：Debugger 也是高风险 domain（§3.4），只在 Profile L 开。
    // 它排在 tasks 里和别的 enable 并发，注意此时 SW 的 resume 已经发出去了，
    // 否则这里会和 Network.enable 一样永远等不到回包。
    if (this.profile === 'L' && this.scriptCapture.isEnabled()) {
      tasks.push(this.scriptCapture.enable(sessionId).catch(() => undefined))
    }

    await Promise.all(tasks).catch(() => undefined)

    // 站点存储域：DOMStorage / IndexedDB / ServiceWorker 的 enable 是按 session 的，
    // 只在主 frame 上开就会漏掉 OOPIF 里的 localStorage 变化
    tasks.push(this.attachSiteSession(sessionId, targetType).catch(() => undefined))

    // 注入脚本挂在 session 上：挂一次之后该 target 的每个新文档都会执行
    void this.injection.apply(sessionId)
  }

  /**
   * 放行被 waitForDebuggerOnStart 挂住的 target。
   *
   * 不 await 是有意的：对 Service Worker 来说，这条命令的响应要等 worker
   * 线程调度起来才回来，而事件处理是并发派发的，卡在这条上没意义。
   */
  private async resumeTarget(sessionId: string): Promise<void> {
    try {
      await this.cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId)
    } catch (error) {
      this.emit('log', `[target] 放行 ${sessionId.slice(0, 8)} 失败: ${(error as Error).message}`)
    }
  }

  /**
   * WS 连接：`sessionId|requestId` → 握手 URL。
   * 帧事件本身不带 URL，只有 webSocketCreated 带 —— 不缓存的话每帧都得现猜。
   */
  private readonly wsUrls = new Map<string, string>()
  private wsFrameCount = 0
  private wsFrameDropped = 0
  /** 正在等应答的 JS 对话框所在的 session。不记住它，agent 想放行都找不到人 */
  private dialogSession: string | null = null
  /** console/exception 这类高噪音事件已经记了多少条 */
  private noisyEventCount = 0
  private noisyEventOverflowed = false
  /** 下载事件的去重键（Browser 与 Page 两个域可能报同一次下载） */
  private readonly seenDownloadKeys = new Set<string>()

  /**
   * 事件流入口。
   *
   * console / exception 是高噪音事件：一个死循环配上 console.error
   * 能在一秒里造出几万条。这类事件封顶；导航、下载、对话框、WebSocket
   * 这些稀疏但重要的照旧全记 —— 丢了它们，事件流就不再是行为时间线了。
   */
  private emitEvent(item: MonitoredEvent): void {
    const noisy = item.kind === 'console' || item.kind === 'exception'
    if (noisy) {
      if (this.noisyEventCount >= EVENT_NOISY_LIMIT) {
        if (!this.noisyEventOverflowed) {
          this.noisyEventOverflowed = true
          this.emit('event', {
            ts: Date.now(),
            kind: 'overflow',
            level: 'warn',
            detail: {
              limit: EVENT_NOISY_LIMIT,
              note:
                'console/exception 事件已达单实例上限，后续同类不再入库（控制台面板仍保留最近 ' +
                CONSOLE_RING +
                ' 条）'
            }
          } satisfies MonitoredEvent)
          this.emit('log', `[events] console/exception 超过 ${EVENT_NOISY_LIMIT} 条，之后同类事件不再入库`)
        }
        return
      }
      this.noisyEventCount += 1
    }
    this.emit('event', item)
  }

  /** 下载事件的去重：同一个 guid 只记一次 */
  private claimDownload(key: string): boolean {
    if (this.seenDownloadKeys.has(key)) return false
    this.seenDownloadKeys.add(key)
    if (this.seenDownloadKeys.size > 256) {
      const oldest = this.seenDownloadKeys.values().next().value
      if (oldest !== undefined) this.seenDownloadKeys.delete(oldest)
    }
    return true
  }

  private wsUrlFor(sessionId: string | undefined, requestId: string): string | undefined {
    return this.wsUrls.get(`${sessionId ?? 'root'}|${requestId}`)
  }

  /**
   * 一帧 WebSocket 数据。
   *
   * payloadData 在文本帧里是文本、在二进制帧里是 base64（CDP 的约定），
   * 所以 size 要按帧类型换算，别把 base64 的长度当成载荷大小报给上层。
   */
  private onWsFrame(event: CdpEvent, direction: 'sent' | 'received'): void {
    const p = params<{
      requestId: string
      timestamp?: number
      response?: { opcode?: number; payloadData?: string }
    }>(event)
    if (this.wsFrameCount >= WS_FRAME_LIMIT) {
      this.wsFrameDropped += 1
      return
    }
    this.wsFrameCount += 1
    const data = p.response?.payloadData ?? ''
    const opcode = p.response?.opcode ?? 0
    const binary = opcode === 2
    const frame: WsFrameRecord = {
      seq: this.resolveSeq(event.sessionId, p.requestId),
      ts: toMs(p.timestamp),
      requestId: p.requestId,
      url: this.wsUrlFor(event.sessionId, p.requestId),
      direction,
      opcode,
      // Keep the original CDP payload until the controller has committed it to
      // ContentStore. Only the database preview is bounded afterwards.
      payload: data,
      size: binary ? Math.floor((data.length * 3) / 4) : data.length,
      truncated: false,
      binary
    }
    this.emit('wsframe', frame)
  }

  /**
   * 应答 JS 对话框。
   *
   * 对话框会把渲染进程挂住（页面从此不再前进），所以「记录」之外还得能让
   * 调用方放行 —— 这是监控之外的控制能力，也是自动化测试会用到的那一半。
   */
  async handleDialog(accept: boolean, promptText?: string): Promise<{ ok: boolean; error?: string }> {
    const sessionId = this.dialogSession ?? this.findSessionByTargetType('page')
    if (!sessionId) return { ok: false, error: '当前没有打开的对话框' }
    try {
      await this.cdp.send(
        'Page.handleJavaScriptDialog',
        promptText === undefined ? { accept } : { accept, promptText },
        sessionId
      )
      return { ok: true }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  }

  /** WS 采集计数，给状态面板与 /status 用 */
  getWsStats(): { frames: number; dropped: number; connections: number } {
    return { frames: this.wsFrameCount, dropped: this.wsFrameDropped, connections: this.wsUrls.size }
  }
  private async onEvent(event: CdpEvent): Promise<void> {
    // Fetch 域的事件先过一遍，认领了就不再往下走
    if (this.bodyCapture.handleEvent(event)) return
    // 脚本事件同理。注意它认领的是 Debugger.scriptParsed，
    // 这类事件量大且只在这里消化，不能掉到下面的 switch 里白跑一遍。
    if (this.scriptCapture.handleEvent(event.sessionId, event.method, event.params)) return

    switch (event.method) {
      case 'Runtime.consoleAPICalled': {
        this.onConsole(event)
        return
      }

      case 'Runtime.exceptionThrown': {
        this.onException(event)
        return
      }

      case 'Target.attachedToTarget': {
        const p = params<AttachedToTarget>(event)
        const info = p.targetInfo
        this.targets.set(info.targetId, {
          targetId: info.targetId,
          type: info.type,
          url: info.url,
          attached: true,
          sessionId: p.sessionId
        })

        const monitored = MONITORED_TARGET_TYPES.has(info.type)
        const known = this.primarySession.get(info.targetId)
        const isPrimary = !known || known === p.sessionId
        if (monitored && isPrimary) this.primarySession.set(info.targetId, p.sessionId)

        // Service Worker 的 Network.enable 要等 worker 线程真的跑起来才回包 ——
        // 命令发出去，响应永远不来。所以对 SW 必须「先放行、再 enable」：
        // 顺序反了 SW 就卡在 install 之前，register() 的 Promise 永不 resolve，
        // 整个站点跟着卡死，而 CDP 侧一个报错都不给。
        const resumeFirst = Boolean(p.waitingForDebugger) && info.type === 'service_worker'
        if (resumeFirst) void this.resumeTarget(p.sessionId)

        if (monitored) {
          if (isPrimary) {
            await this.enableSession(p.sessionId, info.targetId, info.type)
          } else {
            this.emit(
              'log',
              `[target] ${info.type} 已由 ${String(known).slice(0, 8)} 采集，跳过重复会话`
            )
          }
        }
        this.emit('target-attached', {
          type: info.type,
          url: info.url,
          monitored,
          sessionId: p.sessionId
        })

        // waitForDebuggerOnStart 会把新 target 挂住，不放行页面会卡死。
        // 注意这是命令不是 Runtime.enable，不会引入 console 检测面。
        if (p.waitingForDebugger && !resumeFirst) void this.resumeTarget(p.sessionId)

        this.emitStatus()
        return
      }

      case 'Target.detachedFromTarget': {
        const p = params<{ sessionId: string; targetId?: string }>(event)
        this.sessions.delete(p.sessionId)
        this.scriptCapture.forget(p.sessionId)
        this.injection.forget(p.sessionId)
        if (p.targetId) {
          if (this.primarySession.get(p.targetId) === p.sessionId) {
            this.primarySession.delete(p.targetId)
          }
          const info = this.targets.get(p.targetId)
          if (info) {
            info.attached = false
            info.sessionId = null
          }
        }
        this.emitStatus()
        return
      }

      case 'Target.targetInfoChanged': {
        const p = params<{ targetInfo: { targetId: string; type: string; url: string } }>(event)
        const info = this.targets.get(p.targetInfo.targetId)
        if (info) {
          info.url = p.targetInfo.url
          info.type = p.targetInfo.type
        }
        if (info?.sessionId) void this.injection.apply(info.sessionId)
        this.emitStatus()
        return
      }

      // frameRequestedNavigation 是「文档还没建」的那个点，
      // 在这里挂 document_start 才来得及；frameNavigated 到了就晚了，兜底用
      case 'Page.frameRequestedNavigation': {
        void this.injection.apply(event.sessionId)
        return
      }

      case 'Page.frameNavigated': {
        const p = params<{ frame?: { id?: string; parentId?: string; url?: string } }>(event)
        void this.injection.apply(event.sessionId)
        // 换过文档，之前发出去的 nodeId 全废 —— DOM 面板据此丢掉缓存的根
        this.emit('navigated', event.sessionId)
        this.rememberFrameUrl(event.sessionId, p.frame?.url ?? '')
        this.emitEvent({
          ts: Date.now(),
          kind: 'navigation',
          url: p.frame?.url,
          targetType: this.targetTypeOf(event),
          detail: { frameId: p.frame?.id, mainFrame: !p.frame?.parentId }
        })
        return
      }

      case 'Page.domContentEventFired': {
        const url = event.sessionId ? this.frameUrls.get(event.sessionId) ?? '' : ''
        void this.injection.runReady(event.sessionId, url)
        return
      }

      case 'Target.targetDestroyed': {
        const p = params<{ targetId: string }>(event)
        this.primarySession.delete(p.targetId)
        this.targets.delete(p.targetId)
        this.emitStatus()
        return
      }

      case 'Network.requestWillBeSent':
        this.onRequestWillBeSent(event)
        return

      case 'Network.requestWillBeSentExtraInfo':
        this.onRequestExtraInfo(event)
        return

      case 'Network.responseReceivedExtraInfo':
        this.onResponseExtraInfo(event)
        return

      case 'Network.responseReceived':
        this.onResponseReceived(event)
        return

      case 'Network.loadingFinished':
        this.onLoadingFinished(event)
        return

      case 'Network.loadingFailed':
        this.onLoadingFailed(event)
        return

      /* ---- 事件流：WebSocket 生命周期 ---- */

      case 'Network.webSocketCreated': {
        const p = params<{ requestId: string; url: string }>(event)
        this.wsUrls.set(this.keyOf(event, p.requestId), p.url)
        if (this.wsUrls.size > WS_URL_CACHE) {
          const oldest = this.wsUrls.keys().next().value
          if (oldest !== undefined) this.wsUrls.delete(oldest)
        }
        this.emitEvent({
          ts: Date.now(),
          kind: 'websocket',
          url: p.url,
          targetType: this.targetTypeOf(event),
          detail: { event: 'created', requestId: p.requestId }
        })
        return
      }

      case 'Network.webSocketHandshakeResponseReceived': {
        const p = params<{ requestId: string; response?: { status?: number; statusText?: string } }>(event)
        const status = p.response?.status
        this.emitEvent({
          ts: Date.now(),
          kind: 'websocket',
          level: status !== undefined && status >= 400 ? 'warn' : 'info',
          url: this.wsUrlFor(event.sessionId, p.requestId),
          detail: { event: 'handshake', requestId: p.requestId, status, statusText: p.response?.statusText }
        })
        return
      }

      case 'Network.webSocketFrameSent':
        this.onWsFrame(event, 'sent')
        return

      case 'Network.webSocketFrameReceived':
        this.onWsFrame(event, 'received')
        return

      case 'Network.webSocketFrameError': {
        const p = params<{ requestId: string; errorMessage?: string }>(event)
        this.emitEvent({
          ts: Date.now(),
          kind: 'websocket',
          level: 'error',
          url: this.wsUrlFor(event.sessionId, p.requestId),
          detail: { event: 'error', requestId: p.requestId, message: p.errorMessage }
        })
        return
      }

      case 'Network.webSocketClosed': {
        const p = params<{ requestId: string }>(event)
        this.emitEvent({
          ts: Date.now(),
          kind: 'websocket',
          url: this.wsUrlFor(event.sessionId, p.requestId),
          detail: { event: 'closed', requestId: p.requestId }
        })
        this.wsUrls.delete(this.keyOf(event, p.requestId))
        return
      }

      /* ---- 事件流：下载（Browser 与 Page 两个域都可能报，按 guid 去重）---- */

      case 'Page.downloadWillBegin':
      case 'Browser.downloadWillBegin': {
        const p = params<{ guid?: string; url?: string; suggestedFilename?: string }>(event)
        const guid = p.guid ?? p.url ?? String(Date.now())
        if (!this.claimDownload('begin|' + guid)) return
        this.emitEvent({
          ts: Date.now(),
          kind: 'download',
          url: p.url,
          targetType: this.targetTypeOf(event),
          detail: { event: 'begin', guid, filename: p.suggestedFilename }
        })
        return
      }

      case 'Page.downloadProgress':
      case 'Browser.downloadProgress': {
        const p = params<{ guid?: string; state?: string; receivedBytes?: number; totalBytes?: number }>(event)
        const guid = p.guid ?? 'unknown'
        if (!this.claimDownload('progress|' + guid + '|' + String(p.state))) return
        this.emitEvent({
          ts: Date.now(),
          kind: 'download',
          level: p.state === 'canceled' ? 'warn' : 'info',
          detail: { event: p.state ?? 'progress', guid, receivedBytes: p.receivedBytes, totalBytes: p.totalBytes }
        })
        return
      }

      /* ---- 事件流：JS 对话框 ---- */

      case 'Page.javascriptDialogOpening': {
        const p = params<{ url?: string; message?: string; type?: string; defaultPrompt?: string }>(event)
        // 记下来才能应答：不记 session，handleDialog 就只能猜
        this.dialogSession = event.sessionId ?? null
        this.emitEvent({
          ts: Date.now(),
          kind: 'dialog',
          level: 'warn',
          url: p.url,
          targetType: this.targetTypeOf(event),
          detail: { event: 'opened', type: p.type, message: p.message, defaultPrompt: p.defaultPrompt }
        })
        return
      }

      case 'Page.javascriptDialogClosed': {
        const p = params<{ result?: boolean; userInput?: string }>(event)
        this.dialogSession = null
        this.emitEvent({
          ts: Date.now(),
          kind: 'dialog',
          detail: { event: 'closed', result: p.result, userInput: p.userInput }
        })
        return
      }

      default:
        return
    }
  }

  /** 事件里带的 target 类型：事件流面板按它分组看「谁在干什么」 */
  private targetTypeOf(event: CdpEvent): string | undefined {
    return event.sessionId ? this.sessions.get(event.sessionId)?.targetType : undefined
  }

  private keyOf(event: CdpEvent, requestId: string): string {
    return `${event.sessionId ?? 'root'}|${requestId}`
  }

  /** 旁路缓冲的槽位。满了丢最老的 —— 丢掉最多少一次头，不影响请求本身 */
  private extraSlot(key: string): { req?: HeaderMap; resp?: HeaderMap } {
    let slot = this.extraInfo.get(key)
    if (!slot) {
      slot = {}
      this.extraInfo.set(key, slot)
      if (this.extraInfo.size > MAX_EXTRA_INFO) {
        const oldest = this.extraInfo.keys().next().value
        if (oldest !== undefined) this.extraInfo.delete(oldest)
      }
    }
    return slot
  }

  /** 记录刚建好：把比它先到的 extraInfo 认领过来 */
  private claimExtraInfo(key: string, record: RequestRecord): void {
    const slot = this.extraInfo.get(key)
    if (!slot) return
    if (slot.req) record.reqHeaders = slot.req
    if (slot.resp) record.respHeaders = slot.resp
    this.extraInfo.delete(key)
  }

  private onRequestExtraInfo(event: CdpEvent): void {
    const p = params<NetworkRequestExtraInfo>(event)
    this.trackAssociatedCookies(event, p)
    const headers = toHeaderMap(p.headers)
    if (!headers) return
    const key = this.keyOf(event, p.requestId)
    const entry = this.inflight.get(key)
    // 认领过一份就不再认第二份：那一份属于下一跳（重定向复用 requestId）
    if (entry && !entry.claimedReq) {
      entry.claimedReq = true
      entry.record.reqHeaders = headers
      this.trace(entry.record.url, 'requestWillBeSentExtraInfo', event.sessionId, `headers=${Object.keys(headers).length}`)
      return
    }
    this.trace(`requestId=${p.requestId}`, 'requestWillBeSentExtraInfo/BUFFERED', event.sessionId, '')
    this.extraSlot(key).req = headers
  }

  private onResponseExtraInfo(event: CdpEvent): void {
    const p = params<NetworkResponseExtraInfo>(event)
    this.trackSetCookie(event, p)
    this.trackBlockedCookies(event, p)
    const headers = toHeaderMap(p.headers)
    if (!headers) return
    const key = this.keyOf(event, p.requestId)
    const entry = this.inflight.get(key)
    if (entry && !entry.claimedResp) {
      entry.claimedResp = true
      entry.record.respHeaders = headers
      this.trace(entry.record.url, 'responseReceivedExtraInfo', event.sessionId, `headers=${Object.keys(headers).length}`)
      return
    }
    this.trace(`requestId=${p.requestId}`, 'responseReceivedExtraInfo/BUFFERED', event.sessionId, '')
    this.extraSlot(key).resp = headers
  }


  /**
   * Set-Cookie 观测。
   *
   * **不解析 cookie 语义** —— domain/path 匹配、Max-Age 换算、SameSite 默认值
   * 每一条都是坑，自己实现一遍必然和浏览器对不上。这里只记录「哪个 URL 想种哪些名字」，
   * 让上层在对账之后把变化认领回去：谁改的对上号，改成什么样以浏览器的罐为准。
   */
  private trackSetCookie(event: CdpEvent, p: NetworkResponseExtraInfo): void {
    if (!this.siteHooks?.onSetCookie) return
    const names = setCookieNames(p.headersText, p.headers)
    if (names.length === 0) return
    const entry = this.inflight.get(this.keyOf(event, p.requestId))
    const url = entry?.record.url || this.frameUrls.get(event.sessionId ?? '') || ''
    this.siteHooks.onSetCookie(url, names)
  }

  /** 被第三方 cookie 策略挡下来的那些。研究「谁在被拦」比「谁被种上」更有意思 */
  private trackBlockedCookies(event: CdpEvent, p: NetworkResponseExtraInfo): void {
    if (!this.siteHooks?.onCookieBlocked) return
    const blocked = p.blockedCookies
    if (!Array.isArray(blocked) || blocked.length === 0) return
    const names = blocked.map((item) => item.cookie?.name).filter((name): name is string => Boolean(name))
    if (names.length === 0) return
    const entry = this.inflight.get(this.keyOf(event, p.requestId))
    const url = entry?.record.url || this.frameUrls.get(event.sessionId ?? '') || ''
    this.siteHooks.onCookieBlocked?.(url, names)
  }

  /**
   * 这次请求带了哪些 cookie。CDP 在 associatedCookies 里给，别处拿不到。
   * 用「请求所在文档的 host」当站点 —— 一条 cookie 出现在两个站点上，
   * 就是它在跟着用户走，这正是 cookie 画像里最该看见的那件事。
   */
  private trackAssociatedCookies(event: CdpEvent, p: NetworkRequestExtraInfo): void {
    if (!this.siteHooks?.onCookieSent) return
    const list = p.associatedCookies
    if (!Array.isArray(list) || list.length === 0) return
    const entry = this.inflight.get(this.keyOf(event, p.requestId))
    const host = hostOfUrl(entry?.record.frameUrl || entry?.record.url || this.frameUrls.get(event.sessionId ?? ''))
    if (!host) return
    const keys: string[] = []
    for (const item of list) {
      const cookie = item.cookie
      if (!cookie?.name) continue
      // blockedReasons 非空 = 浏览器**本来想带、但拦下了**（SameSite 不匹配是最常见的一种）。
      // 只认真正进了请求头的那批：把被拦的也算成「发出去过」，跨站标记就会误报
      // —— 实测里同域的一条 Lax cookie 就这么被标成了跨站。
      if (Array.isArray(item.blockedReasons) && item.blockedReasons.length > 0) continue
      keys.push(cookieKey(cookie.name, cookie.domain, cookie.path, cookie.partitionKey))
    }
    if (keys.length > 0) this.siteHooks.onCookieSent(host, keys)
  }

  /** 每个 page/iframe 会话都要把站点存储那几个域开上 */
  private async attachSiteSession(sessionId: string, targetType: string): Promise<void> {
    if (!this.siteAttach) return
    await this.siteAttach(sessionId, targetType)
  }

  private onRequestWillBeSent(event: CdpEvent): void {
    const p = params<NetworkRequestWillBeSent>(event)
    // 探针信标不进请求列表：那是我们自己的信道，不是页面流量
    if (this.probe?.matches(p.request.url)) return
    const key = this.keyOf(event, p.requestId)
    const session = event.sessionId ? this.sessions.get(event.sessionId) : undefined
    this.rememberFrameUrl(event.sessionId, p.documentURL ?? '')

    // 重定向会复用同一个 requestId 再次触发，先把上一条结算掉
    const previous = this.inflight.get(key)
    if (previous) {
      if (p.redirectResponse) {
        previous.record.status = p.redirectResponse.status
        previous.record.statusText = p.redirectResponse.statusText
        previous.record.mimeType = p.redirectResponse.mimeType
      }
      previous.record.endTs = Date.now()
      previous.record.durationMs = Math.round((p.timestamp - previous.monoStart) * 1000)
      this.emitRecord(previous.record, !previous.pendingEmitted)
      this.inflight.delete(key)
    }

    const seq = this.nextSeq++
    const record: RequestRecord = {
      seq,
      key,
      requestId: p.requestId,
      sessionId: event.sessionId ?? null,
      targetId: session?.targetId ?? '',
      targetType: session?.targetType ?? 'unknown',
      frameUrl: p.documentURL ?? '',
      url: p.request.url,
      method: p.request.method,
      resourceType: p.type ?? 'Other',
      startTs: p.wallTime ? p.wallTime * 1000 : Date.now()
    }
    if (p.initiator) {
      record.initiatorType = p.initiator.type ?? 'other'
      record.initiator = toInitiator(p.initiator)
    }
    // 请求体：CDP 只在 requestWillBeSent 里给一次，错过就没了。
    // 大 body 会被剪（Chrome 自己也会剪），剪了就不保证还能当 JSON 解析 ——
    // 但「有请求体」和「前 64KB 长什么样」本身就是要留下的信息
    if (typeof p.request.postData === 'string' && p.request.postData.length > 0) {
      record.reqBody =
        p.request.postData.length > REQ_BODY_MAX
          ? p.request.postData.slice(0, REQ_BODY_MAX)
          : p.request.postData
    }

    // extraInfo 可能比这条 requestWillBeSent 先到，建好记录就认领
    this.claimExtraInfo(key, record)

    this.inflight.set(key, { record, monoStart: p.timestamp, since: Date.now() })
    this.indexSeq(seq, key, event.sessionId ?? null, p.requestId)
    this.trace(p.request.url, 'requestWillBeSent', event.sessionId, `seq=${seq} type=${p.type} redirect=${Boolean(p.redirectResponse)}`)
  }

  private onResponseReceived(event: CdpEvent): void {
    const p = params<NetworkResponseReceived>(event)
    const entry = this.inflight.get(this.keyOf(event, p.requestId))
    if (!entry) return

    const { record } = entry
    record.status = p.response.status
    record.statusText = p.response.statusText
    record.mimeType = p.response.mimeType
    record.fromCache = Boolean(p.response.fromDiskCache)
    record.fromServiceWorker = Boolean(p.response.fromServiceWorker)
    record.responseSource = record.fromServiceWorker ? 'service_worker' : record.fromCache ? 'disk_cache' : 'network'
    this.trace(record.url, 'responseReceived', event.sessionId, `status=${p.response.status}`)
  }

  private onLoadingFinished(event: CdpEvent): void {
    const p = params<NetworkLoadingFinished>(event)
    const key = this.keyOf(event, p.requestId)
    const entry = this.inflight.get(key)
    if (!entry) {
      this.trace(`requestId=${p.requestId}`, 'loadingFinished/NO-INFLIGHT', event.sessionId, key)
      return
    }

    entry.record.encodedDataLength = p.encodedDataLength
    entry.record.endTs = Date.now()
    entry.record.durationMs = Math.round((p.timestamp - entry.monoStart) * 1000)
    if (entry.record.fromServiceWorker) {
      // Fetch.getResponseBody may return an empty outer body for a Service
      // Worker synthesized response. Once loadingFinished fires, Network owns
      // the finalized buffer and can provide the actual bytes.
      void this.cdp.send('Network.getResponseBody', { requestId: p.requestId }, event.sessionId)
        .then((value: unknown) => {
          const result = value as { body?: string; base64Encoded?: boolean }
          if (!result.body) return
          const bytes = result.base64Encoded
            ? new Uint8Array(Buffer.from(result.body, 'base64'))
            : new Uint8Array(Buffer.from(result.body, 'utf8'))
          if (bytes.byteLength > 0) this.emit('body', { seq: entry.record.seq, bytes, state: 'stored', size: bytes.byteLength } satisfies CapturedBody)
        })
        .catch(() => undefined)
    }
    this.inflight.delete(key)
    this.trace(entry.record.url, 'loadingFinished', event.sessionId, `bytes=${p.encodedDataLength}`)
    this.emitRecord(entry.record, !entry.pendingEmitted)
  }

  private onLoadingFailed(event: CdpEvent): void {
    const p = params<NetworkLoadingFailed>(event)
    const key = this.keyOf(event, p.requestId)
    const entry = this.inflight.get(key)
    if (!entry) return

    this.trace(entry.record.url, 'loadingFailed', event.sessionId, p.errorText)
    entry.record.failed = p.errorText
    entry.record.endTs = Date.now()
    entry.record.durationMs = Math.round((p.timestamp - entry.monoStart) * 1000)
    this.inflight.delete(key)
    this.emitRecord(entry.record, !entry.pendingEmitted)
  }

  /**
   * 收尾：把还在飞的请求也补成记录。
   * 不补的话，会话结束时未完成的请求一条都进不了库 —— 而「点了页面然后
   * 立刻收工」恰恰是最常见的验收姿势，会以为采集漏了。
   */
  flushInflight(): void {
    this.stopPendingSweep()
    if (this.inflight.size === 0) return
    const now = Date.now()
    for (const entry of this.inflight.values()) {
      if (entry.record.status === undefined) {
        // 连响应头都没拿到，这条确实是没跑完
        entry.record.canceled = true
        entry.record.endTs = now
        entry.record.durationMs = Math.round(now - entry.record.startTs)
      }
      // 有状态码说明响应到了，只是收尾事件没等到 ——
      // 时长留空，不编一个假的数字出来
      this.trace(entry.record.url, 'flushInflight', entry.record.sessionId ?? undefined)
      this.emitRecord(entry.record, !entry.pendingEmitted)
    }
    this.inflight.clear()
  }

  /**
   * 把「已经挂了但还没等到终态事件」的请求先落一次库。
   *
   * 有些请求永远等不到 Network.loadingFinished —— 页面不消费响应体时
   * （`fetch(u).then(r => r.status)` 这种写法）响应流没人读，Chrome 就不发
   * 终态事件，DevTools 里它们也永远显示 (pending)。只靠收尾时 flushInflight
   * 补的话，这些请求在整个会话期间都不可见，界面上「无响应」那个筛选
   * 也就永远是空的 —— 看着像功能，其实是死的。
   *
   * 终态事件到了会再写一次，库里是 upsert，所以不会多出一行。
   */
  private sweepPending(): void {
    const now = Date.now()
    for (const entry of this.inflight.values()) {
      if (entry.pendingEmitted) continue
      if (now - entry.since < PENDING_VISIBLE_MS) continue
      entry.pendingEmitted = true
      this.trace(entry.record.url, 'sweepPending', entry.record.sessionId ?? undefined)
      this.emitRecord(entry.record, true)
    }
  }

  private stopPendingSweep(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
  }

  /**
   * 把一条请求的事件流水打出来。
   * 「这条为什么没进库」这种问题，光看结果猜不出来，必须看事件序列。
   */
  private trace(url: string, event: string, sessionId: string | undefined, extra = ''): void {
    if (!this.traceFilter || !url.includes(this.traceFilter)) return
    this.emit('log', `[trace] ${event} ${(sessionId ?? 'root').slice(0, 8)} ${url} ${extra}`)
  }

  /**
   * first = true 表示这条请求第一次到达上层。
   *
   * 同一条请求可能会到两次：先一条「还没跑完」的临时行（sweepPending），
   * 终态事件到了再一条。上层要靠这个标志把计数算成「多少条请求」，
   * 而不是「写了几次库」。
   */
  private emitRecord(record: RequestRecord, first: boolean): void {
    // 这一跳结束了：缓冲里剩下的那份不属于它（属于它的早就被认领走），
    // 留着只会被下一跳误认领
    this.extraInfo.delete(record.key)
    this.emit('record', record, first)
  }

  private emitStatus(): void {
    this.emit('targets', this.getTargets())
  }
}
