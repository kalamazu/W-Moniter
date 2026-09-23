import type { CdpClient, CdpEvent } from './cdp'
import type {
  ExchangeContext,
  FetchPattern,
  Header,
  Plan,
  ResponsePlan,
  RuleEngine
} from '../rules/engine'
import { dropLengthHeaders } from '../rules/engine'
import type { ProbeChannel } from './probe'

/**
 * 响应体采集：用 Fetch 域在 Response 阶段拦。
 *
 * 为什么不用 Network.getResponseBody：它依赖资源还在 buffer 里，
 * 大响应/流式/被驱逐的都拿不到。Fetch 拦截时由浏览器把响应交给调试器，
 * 拿到的是解码后的完整 body，可靠得多，而且 Fetch 在 Profile H 的白名单里。
 *
 * 代价与纪律：
 *   - 拦下的请求**必须**放行，否则页面直接卡死。所有路径都走 finally 收口。
 *   - 拦一个请求就多一次管道往返，所以只拦配置里指定的资源类型，
 *     图片/字体/媒体这些大流量默认不碰。
 *   - 有 content-length 且超上限 → 直接放行，只记 hash 层信息；
 *     没有 content-length 且看着像流式（SSE/分块长连接）→ 不取 body，避免把长连接拖住。
 */

export interface BodyConfig {
  enabled: boolean
  /** 大响应由本地代理的二进制流接管，避免 CDP 一次性缓冲。 */
  proxyStreaming?: boolean
  /** 要拦的 CDP resourceType 集合。**空集 = 全部类型**（不带 resourceType 的 Response pattern） */
  resourceTypes: Set<string>
  /** 单条 body 采集上限，超过只记状态 */
  maxBytes: number
  /** getResponseBody 的硬超时，超了无条件放行 */
  timeoutMs: number
}

export type BodyState =
  | 'stored'
  | 'too_large'
  | 'no_length'
  | 'streaming'
  | 'empty'
  | 'error'
  | 'timeout'
  | 'unmatched'
  | 'incomplete'

export interface CapturedBody {
  seq: number
  bytes: Uint8Array | null
  state: BodyState
  size: number
  /** 服务端报的 content-length，body 被截断时用得上 */
  declaredSize?: number
}

export interface BodyCaptureStats {
  paused: number
  captured: number
  capturedBytes: number
  tooLarge: number
  streaming: number
  empty: number
  unmatched: number
  timeouts: number
  errors: number
  inFlight: number
  continueMethod: string
}

interface FetchRequestPaused {
  requestId: string
  networkId?: string
  resourceType?: string
  request?: {
    url: string
    method: string
    headers?: Record<string, string> | Array<{ name: string; value: string }>
  }
  responseStatusCode?: number
  responseStatusText?: string
  responseHeaders?: Array<{ name: string; value: string }>
  responseErrorReason?: string
}

/**
 * 只看 content-type，不猜字节 —— 二进制响应走 base64 往返会把字节改坏，
 * 所以宁可漏改一个没写 content-type 的文本，也不毁一个没写 content-type 的图片。
 */
const TEXTY = /(^text\/|json|javascript|ecmascript|xml|html|x-www-form-urlencoded|graphql|svg)/i

/** 无 body 的响应（204/304）在规则眼里是「空 body」，不是「拿不到 body」 */
const EMPTY_BYTES = new Uint8Array(0)

function isTexty(contentType: string | null): boolean {
  return contentType === null ? true : TEXTY.test(contentType)
}

function toCdpHeaders(headers: Header[] | undefined): Array<{ name: string; value: string }> {
  return (headers ?? []).map((header) => ({ name: header.name, value: header.value }))
}

/** Fetch.requestPaused 里的 request.headers 是对象，不是数组 —— 统一成数组交出去 */
function toHeaderArray(
  headers: Record<string, string> | Array<{ name: string; value: string }> | undefined
): Header[] {
  if (!headers) return []
  if (Array.isArray(headers)) return headers
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function headerValue(
  headers: Array<{ name: string; value: string }> | undefined,
  name: string
): string | null {
  if (!headers) return null
  const wanted = name.toLowerCase()
  for (const header of headers) {
    if (header.name.toLowerCase() === wanted) return header.value
  }
  return null
}

function contentLength(headers: Array<{ name: string; value: string }> | undefined): number | null {
  const raw = headerValue(headers, 'content-length')
  if (!raw) return null
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * 流式响应绝不能拿 body —— getResponseBody 会一直等到连接结束，
 * 等于把一个长连接挂在我们手里。SSE 是最典型的例子。
 */
function looksStreaming(contentType: string | null): boolean {
  if (!contentType) return false
  const value = contentType.toLowerCase()
  return (
    value.includes('text/event-stream') ||
    value.includes('multipart/x-mixed-replace') ||
    value.includes('application/grpc')
  )
}

/** 状态码里天然没有 body 的那些 */
function isBodyless(status: number): boolean {
  return status === 204 || status === 205 || status === 304 || (status >= 100 && status < 200)
}

export class BodyCapture {
  private continueMethod = 'Fetch.continueResponse'
  private continueMethodLocked = false
  private continueFallbackReason: string | null = null
  private inFlight = 0
  private readonly stats = {
    paused: 0,
    captured: 0,
    capturedBytes: 0,
    tooLarge: 0,
    streaming: 0,
    empty: 0,
    unmatched: 0,
    timeouts: 0,
    errors: 0
  }

  constructor(
    private readonly cdp: CdpClient,
    private readonly config: BodyConfig,
    /** 由 Collector 提供：把 (sessionId, networkId) 映射到请求的 seq */
    private readonly resolveSeq: (sessionId: string | undefined, networkId: string) => number | undefined,
    /** 由 Collector 提供：session → target 类型 / 文档 URL，规则的过滤条件用 */
    private readonly resolveMeta: (sessionId: string | undefined) => {
      targetType?: string
      frameUrl?: string
    },
    private readonly onBody: (body: CapturedBody) => void,
    /** 干预引擎。null = 纯采集，行为与接线前完全一致 */
    private readonly rules: RuleEngine | null,
    /**
     * 探针信道。挂上它之后 Fetch 恒开 —— 信标请求必须在 Request 阶段被拦下，
     * 否则 probe.monitor.local 会真的走 DNS。代价只有一个窄 pattern。
     */
    private readonly probe: ProbeChannel | null = null
  ) {}

  /** 只采 body（不含规则）时是否要开 Fetch */
  private capturesBodies(): boolean {
    return this.config.enabled
  }

  private rulesWantsBody(): boolean {
    return this.rules?.needsResponseBody ?? false
  }

  private rulesHaveResponseRules(): boolean {
    return this.rules?.hasResponseRules ?? false
  }

  isEnabled(): boolean {
    // 有规则时同样要开 Fetch，否则规则永远等不到 requestPaused
    return this.capturesBodies() || (this.rules?.ruleCount ?? 0) > 0 || this.probe !== null
  }

  getStats(): BodyCaptureStats {
    return {
      ...this.stats,
      inFlight: this.inFlight,
      continueMethod: this.continueFallbackReason
        ? `${this.continueMethod} (${this.continueFallbackReason.slice(0, 60)})`
        : this.continueMethod
    }
  }

  reset(): void {
    this.stats.paused = 0
    this.stats.captured = 0
    this.stats.capturedBytes = 0
    this.stats.tooLarge = 0
    this.stats.streaming = 0
    this.stats.empty = 0
    this.stats.unmatched = 0
    this.stats.timeouts = 0
    this.stats.errors = 0
  }

  /** 已经开过 Fetch 的 session。刷新拦截范围时只照顾这些 */
  private readonly enabledSessions = new Set<string>()

  /**
   * 当前该拦哪些。规则集变更后必须重算，所以单独抽出来。
   *
   * 组成不能乱动：body 采集那批管 Response 阶段，规则反推的那批管各自阶段，
   * 探针那条管内部信标信道。
   */
  private buildPatterns(): FetchPattern[] {
    const patterns: FetchPattern[] = []
    if (this.capturesBodies()) {
      if (this.config.resourceTypes.size === 0) {
        // 不带 resourceType 的 pattern = 全部类型。写死一份类型清单会漏掉内核以后新增的
        patterns.push({ requestStage: 'Response' })
      } else {
        for (const resourceType of this.config.resourceTypes) {
          patterns.push({ resourceType, requestStage: 'Response' })
        }
      }
    }
    // 规则的拦截范围由引擎反推：能窄就窄，见 engine.requestPatterns()
    if (this.rules) {
      patterns.push(...this.rules.requestPatterns())
      // 响应阶段的规则要单独发一份 Response pattern —— 但**只在 body 采集关掉时**：
      // 采集开着时上面那批「resourceType + Response」已经把它们覆盖了，再发一遍
      // 会让同一条响应同时命中两个 Response pattern（实测 paused/tooLarge 各多一条），
      // 而「同一条响应被处理两次」正是 §6.3 要避免的重叠。
      if (!this.capturesBodies()) patterns.push(...this.rules.responsePatterns())
    }
    // 探针信标：只有一个 host，命中的请求一个都别放出去
    if (this.probe) patterns.push({ urlPattern: 'http://probe.monitor.local/*', requestStage: 'Request' })
    return patterns
  }

  /** 每个新 session 都要单独开，否则那个 target 的 body 全是空的 */
  async enable(sessionId: string): Promise<void> {
    if (!this.isEnabled()) return
    const patterns = this.buildPatterns()
    if (patterns.length === 0) return
    await this.cdp.send('Fetch.enable', { patterns, handleAuthRequests: false }, sessionId)
    this.enabledSessions.add(sessionId)
  }

  /**
   * 拦截范围变了：对每个开过的 session 重下发一次。
   *
   * 必须覆盖「已经 attach 的 session」：CDP 的 session 跨导航存活，
   * 新规则只在新 session 上生效的话，页面刷新多少次都还是旧的拦截范围 ——
   * 实测表现就是规则写进去了、页面也重载了，blocked 恒为 0。
   *
   * `Fetch.enable` 是覆盖语义（不是叠加），重发一次就是当前该有的范围；
   * 范围算空了必须显式 disable，否则旧 pattern 会一直拦下去。
   */
  refreshAll(): void {
    for (const sessionId of [...this.enabledSessions]) {
      const patterns = this.buildPatterns()
      if (patterns.length === 0) {
        this.enabledSessions.delete(sessionId)
        void this.cdp.send('Fetch.disable', {}, sessionId).catch(() => undefined)
        continue
      }
      void this.cdp
        .send('Fetch.enable', { patterns, handleAuthRequests: false }, sessionId)
        .catch((error: Error) => {
          this.stats.errors += 1
        })
    }
  }

  /**
   * 探针信标就地了结：解析 URL、回 204。
   * 不进 body 统计也不进请求列表 —— 它是我方内部信道，不是页面流量。
   */
  private handleProbeBeacon(
    p: FetchRequestPaused,
    requestId: string,
    sessionId: string | undefined
  ): boolean {
    const url = p.request?.url ?? ''
    if (!this.probe || !this.probe.matches(url)) return false
    // 采集范围放开到全部类型之后，信标（new Image）也会在 Response 阶段被再暂停一次。
    // 那一次既不能再 feed（同一条信标计两次），也不能 fulfill —— 请求阶段已经就地了结了。
    if (p.responseStatusCode !== undefined) {
      void this.cdp
        .send('Fetch.continueResponse', { requestId }, sessionId)
        .catch(() => undefined)
      return true
    }
    this.probe.feed(url)
    void this.cdp
      .send(
        'Fetch.fulfillRequest',
        { requestId, responseCode: 204, responseHeaders: [], body: '' },
        sessionId
      )
      .catch(() => undefined)
    return true
  }

  /** 返回 true 表示这个事件已被本模块消费 */
  handleEvent(event: CdpEvent): boolean {
    switch (event.method) {
      case 'Fetch.requestPaused':
        void this.onPaused(event)
        return true
      case 'Fetch.authRequired': {
        // 不为认证而暂停页面，直接放行
        const p = event.params as unknown as { requestId: string }
        void this.cdp
          .send(
            'Fetch.continueWithAuth',
            { requestId: p.requestId, authChallengeResponse: { response: 'Default' } },
            event.sessionId
          )
          .catch(() => undefined)
        return true
      }
      default:
        return false
    }
  }

  private ctxOf(
    p: FetchRequestPaused,
    sessionId: string | undefined,
    status?: number
  ): ExchangeContext {
    const meta = this.resolveMeta(sessionId)
    return {
      url: p.request?.url ?? '',
      method: p.request?.method ?? 'GET',
      resourceType: p.resourceType,
      targetType: meta.targetType,
      frameUrl: meta.frameUrl,
      status,
      requestHeaders: toHeaderArray(p.request?.headers),
      responseHeaders: p.responseHeaders ?? [],
      mimeType: headerValue(p.responseHeaders, 'content-type') ?? undefined
    }
  }

  /**
   * 请求阶段的规则。返回 true = 已经替这条请求做了决定（拒绝 / 跳转 / 伪造 / 放行），
   * 调用方不能再碰它。false = 没命中，或者命中了但不需要额外动作。
   */
  private async applyRequestRules(
    p: FetchRequestPaused,
    sessionId: string | undefined,
    requestId: string,
    send: (method: string, params: Record<string, unknown>) => Promise<void>
  ): Promise<boolean> {
    if (!this.rules || this.rules.ruleCount === 0) return false

    let plan: Plan
    try {
      plan = await this.rules.planRequest(this.ctxOf(p, sessionId))
    } catch {
      // 引擎内部已经吞了脚本异常；这里再兜一层，规则炸了也不能把页面挂住
      return false
    }

    if (plan.delayMs > 0) await sleep(plan.delayMs)

    switch (plan.verdict.kind) {
      case 'block':
        await send('Fetch.failRequest', { requestId, errorReason: 'Aborted' })
        return true
      case 'redirect':
        await send('Fetch.continueRequest', { requestId, url: plan.verdict.to })
        return true
      case 'fulfill':
        await send('Fetch.fulfillRequest', {
          requestId,
          responseCode: plan.verdict.status,
          responseHeaders: toCdpHeaders(plan.verdict.headers),
          body: Buffer.from(plan.verdict.body, 'utf8').toString('base64')
        })
        return true
      case 'continue':
        if (plan.verdict.headers) {
          await send('Fetch.continueRequest', {
            requestId,
            headers: toCdpHeaders(plan.verdict.headers)
          })
          return true
        }
        return false
    }
  }

  /**
   * 响应阶段的规则。返回 true = 已经自己放行/伪造了，调用方不要再 release。
   * 拿不到 body 也要走一遍：改响应头、伪造响应都不需要 body。
   */
  private async applyResponseRules(
    p: FetchRequestPaused,
    sessionId: string | undefined,
    requestId: string,
    body: { text: string; isBinary: boolean } | null,
    bytes: Uint8Array | null,
    send: (method: string, params: Record<string, unknown>) => Promise<void>
  ): Promise<boolean> {
    if (!this.rules || this.rules.ruleCount === 0) return false

    let plan: ResponsePlan
    try {
      plan = await this.rules.planResponse(
        this.ctxOf(p, sessionId, p.responseStatusCode),
        body
      )
    } catch {
      return false
    }

    if (plan.verdict.kind === 'fulfill') {
      await send('Fetch.fulfillRequest', {
        requestId,
        responseCode: plan.verdict.status,
        responseHeaders: toCdpHeaders(plan.verdict.headers),
        body: Buffer.from(plan.verdict.body, 'utf8').toString('base64')
      })
      return true
    }

    const headers = plan.verdict.headers
    if (!headers) return false
    await this.resendWithHeaders(p, requestId, headers, bytes, send)
    return true
  }

  /**
   * 响应阶段没有「只改响应头」的可靠命令：`Fetch.continueResponse` 虽然声明了
   * responseHeaders，实测发过去页面读不到。所以自己把响应重发一次
   * （fulfillRequest 的响应头、状态码、body 都是我们说了算）。
   *
   * 关键：body 是 getResponseBody 给的**已解码**字节，所以必须去掉
   * content-length / content-encoding，否则浏览器会拿 gzip 去解明文。
   */
  private async resendWithHeaders(
    p: FetchRequestPaused,
    requestId: string,
    headers: Header[],
    bytes: Uint8Array | null,
    send: (method: string, params: Record<string, unknown>) => Promise<void>
  ): Promise<void> {
    const status = p.responseStatusCode ?? 200
    // 304 / 1xx 有自己的缓存语义，重发会把缓存搞乱；拿不到 body 的（流式、超限）同理
    const reserviceable = bytes !== null && status !== 304 && !(status >= 100 && status < 200)
    if (!reserviceable) {
      // 宁可丢一次头改写，也不能把响应毁掉
      await send('Fetch.continueResponse', { requestId })
      return
    }
    await send('Fetch.fulfillRequest', {
      requestId,
      responseCode: status,
      responseHeaders: toCdpHeaders(dropLengthHeaders(headers)),
      body: Buffer.from(bytes).toString('base64')
    })
  }

  private async onPaused(event: CdpEvent): Promise<void> {
    const p = event.params as unknown as FetchRequestPaused
    const requestId = p.requestId
    const sessionId = event.sessionId

    // 探针信标先认领：它不参与 body 统计，也不该走规则
    if (this.handleProbeBeacon(p, requestId, sessionId)) return

    /** 规则自己放行过就让开，避免第二次 continue 打到同一个拦截 id */
    let released = false
    const send = async (method: string, params: Record<string, unknown>): Promise<void> => {
      await this.cdp.send(method, params, sessionId)
      released = true
    }

    this.stats.paused += 1
    this.inFlight += 1

    try {
      let seq = p.networkId ? this.resolveSeq(sessionId, p.networkId) : undefined
      // Fetch Response 事件偶尔先于 Network.responseReceived；短暂等待关联索引，
      // 不能把这种正常乱序误记为 unmatched 并丢掉正文。
      if (seq === undefined && p.networkId) {
        for (let attempt = 0; attempt < 20 && seq === undefined; attempt += 1) {
          await sleep(10)
          seq = this.resolveSeq(sessionId, p.networkId)
        }
      }

      // responseStatusCode 缺席 ≠ 已经到响应了：连接失败走的是 responseErrorReason
      if (!p.responseErrorReason && p.responseStatusCode === undefined) {
        if (await this.applyRequestRules(p, sessionId, requestId, send)) return
        await send('Fetch.continueRequest', { requestId })
        return
      }

      if (p.responseErrorReason) {
        if (seq !== undefined) this.onBody({ seq, bytes: null, state: 'error', size: 0 })
        else this.stats.unmatched += 1
        await this.applyResponseRules(p, sessionId, requestId, null, null, send)
        return
      }

      const status = p.responseStatusCode ?? 0
      // CDP 返回的是解码后的正文；存在 content-encoding 时不可直接和线上的长度比较。
      const declared = headerValue(p.responseHeaders, 'content-encoding') ? null : contentLength(p.responseHeaders)
      const mimeType = headerValue(p.responseHeaders, 'content-type')
      const bodyless = isBodyless(status)
      const streaming = looksStreaming(mimeType)
      // 正文大小不再决定是否采集：ContentStore 分块落盘，展示和保留才另设上限。
      const tooLarge = Boolean(this.config.proxyStreaming && declared !== null && declared > 1024 * 1024 &&
        !this.rulesWantsBody() && !this.rulesHaveResponseRules())

      // 三种用途共用这一次管道往返：存 body、rewriteBody 要 body、
      // 改响应头要重发响应（也得有 body）
      const wantBytes =
        !streaming &&
        !tooLarge &&
        ((this.capturesBodies() && seq !== undefined) ||
          this.rulesWantsBody() ||
          this.rulesHaveResponseRules())

      let bytes: Uint8Array | null = null
      let fetchFailure: 'timeout' | 'error' | null = null
      if (wantBytes) {
        if (bodyless) {
          bytes = EMPTY_BYTES
        } else {
          const outcome = await this.withTimeout(
            this.getBody(requestId, sessionId),
            this.config.timeoutMs
          )
          if (outcome.ok) bytes = outcome.value.bytes
          else fetchFailure = outcome.reason
        }
      }

      // 先记账：被规则改写过的响应同样是页面真收到的响应，不该从库里消失
      if (this.capturesBodies()) {
        if (seq === undefined) this.stats.unmatched += 1
        else if (tooLarge) {
          this.stats.tooLarge += 1
          this.onBody({ seq, bytes: null, state: 'too_large', size: declared ?? 0 })
        } else this.accountResponse(seq, status, declared, mimeType, bytes, fetchFailure)
      }

      const text =
        bytes && bytes.byteLength > 0
          ? { text: Buffer.from(bytes).toString('utf8'), isBinary: !isTexty(mimeType) }
          : null
      await this.applyResponseRules(p, sessionId, requestId, text, bytes, send)
    } catch {
      this.stats.errors += 1
    } finally {
      this.inFlight -= 1
      // 无条件放行。这里出问题 = 页面卡死，比丢一条 body 严重得多。
      if (!released) await this.release(requestId, sessionId)
    }
  }

  /** 响应体的记账分支。只为「这个响应到底存不存、为什么没存」负责，不碰放行 */
  private accountResponse(
    seq: number,
    status: number,
    declared: number | null,
    mimeType: string | null,
    bytes: Uint8Array | null,
    fetchFailure: 'timeout' | 'error' | null
  ): void {
    if (isBodyless(status)) {
      this.stats.empty += 1
      this.onBody({ seq, bytes: null, state: 'empty', size: 0 })
      return
    }

    if (looksStreaming(mimeType)) {
      this.stats.streaming += 1
      this.onBody({ seq, bytes: null, state: 'streaming', size: 0 })
      return
    }

    if (fetchFailure) {
      if (fetchFailure === 'timeout') this.stats.timeouts += 1
      else this.stats.errors += 1
      this.onBody({ seq, bytes: null, state: fetchFailure, size: 0 })
      return
    }

    if (!bytes || bytes.byteLength === 0) {
      this.stats.empty += 1
      this.onBody({ seq, bytes: null, state: 'empty', size: 0 })
      return
    }

    if (declared !== null && bytes.byteLength < declared) {
      this.stats.errors += 1
      this.onBody({ seq, bytes: null, state: 'incomplete', size: bytes.byteLength, declaredSize: declared })
      return
    }

    this.stats.captured += 1
    this.stats.capturedBytes += bytes.byteLength
    this.onBody({ seq, bytes, state: 'stored', size: bytes.byteLength })
  }

  private async getBody(
    requestId: string,
    sessionId: string | undefined
  ): Promise<{ bytes: Uint8Array }> {
    const result = (await this.cdp.send('Fetch.getResponseBody', { requestId }, sessionId)) as {
      body: string
      base64Encoded: boolean
    }
    if (result.base64Encoded) {
      return { bytes: new Uint8Array(Buffer.from(result.body, 'base64')) }
    }
    return { bytes: new Uint8Array(Buffer.from(result.body, 'utf8')) }
  }

  private async release(requestId: string, sessionId: string | undefined): Promise<void> {
    const attempt = (method: string): Promise<unknown> =>
      this.cdp.send(method, { requestId }, sessionId)

    try {
      await attempt(this.continueMethod)
      return
    } catch (err) {
      if (this.continueMethodLocked) return

      const message = err instanceof Error ? err.message : String(err)
      // 只有「这个命令根本不存在」才值得永久退化到 continueRequest。
      // 'Invalid InterceptionId' 是单条请求的状态问题（比如已经超时放行过），
      // 拿它锁死整个会话会让后面每条响应都白转一次失败调用。
      const methodMissing = /not found|wasn't found|unknown method|not supported/i.test(message)
      if (!methodMissing) return

      this.continueFallbackReason = message
      this.continueMethod = 'Fetch.continueRequest'
      this.continueMethodLocked = true
      await attempt(this.continueMethod).catch(() => undefined)
    }
  }

/**
   * 超时和报错是两回事，别混成一个裸值 —— 否则统计里分不清
   * 「页面有个长连接」和「CDP 调用真的失败了」。
   * 超时后原 promise 还挂着，必须自己吞掉拒绝，否则会冒成 unhandled rejection。
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    ms: number
  ): Promise<{ ok: true; value: T } | { ok: false; reason: 'timeout' | 'error' }> {
    let timedOut = false
    const guarded = promise.then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const, reason: 'error' as const })
    )
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<{ ok: false; reason: 'timeout' }>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true
        resolve({ ok: false, reason: 'timeout' })
      }, ms)
    })
    try {
      return await Promise.race([guarded, timeout])
    } finally {
      if (timer) clearTimeout(timer)
      void timedOut
    }
  }
}
