import type {
  Injection,
  MockFixture,
  Rule,
  RuleHit,
  RuleSet,
  RuleStats
} from '../../shared/types'
import { hostOf, patternHost, RuleMatcher, type MatchContext } from './matcher'
import { ScriptSandbox } from './sandbox'

/**
 * 干预引擎（设计文档 §6）。
 *
 * 两个阶段各编一个匹配器：请求阶段能做的事（拦截/跳转/延时/改请求头/伪造）
 * 和响应阶段能做的事（改响应头/改 body/伪造）不是一回事，混在一起只会
 * 让「这条规则到底会怎样」变得说不清。
 *
 * 每个阶段只应用命中的第一条（见 matcher.ts 里的语义说明）。
 */

export interface Header {
  name: string
  value: string
}

export interface FetchPattern {
  urlPattern?: string
  resourceType?: string
  requestStage?: 'Request' | 'Response'
}

export interface ExchangeContext {
  url: string
  method: string
  resourceType?: string
  targetType?: string
  frameUrl?: string
  status?: number
  requestHeaders: Header[]
  responseHeaders?: Header[]
  mimeType?: string
}

export type RequestVerdict =
  | { kind: 'continue'; headers?: Header[] }
  | { kind: 'block' }
  | { kind: 'redirect'; to: string }
  | { kind: 'fulfill'; status: number; headers?: Header[]; body: string }

export type ResponseVerdict =
  | { kind: 'continue'; status?: number; headers?: Header[] }
  | { kind: 'fulfill'; status: number; headers?: Header[]; body: string }

export interface Plan {
  verdict: RequestVerdict | ResponseVerdict
  /** 放行前先等这么久（delay 动作） */
  delayMs: number
  ruleId: string | null
  ruleName: string | null
  outcome: RuleHit | null
}

export interface ResponsePlan extends Plan {
  verdict: ResponseVerdict
  /** 改写后的 body；undefined = 不改 */
  body?: string
}

/** delay 的上限。规则里写错一个 0 不该把页面挂死。 */
const MAX_DELAY_MS = 30000
const RECENT_CAP = 100

const REQUEST_ACTIONS = new Set(['block', 'redirect', 'delay', 'rewriteHeaders', 'fulfill', 'mock'])
const RESPONSE_ACTIONS = new Set(['rewriteHeaders', 'rewriteBody', 'fulfill', 'mock'])

const emptySet = (): RuleSet => ({ version: 1, rules: [], fixtures: {}, injections: [] })

export class RuleEngine {
  private set: RuleSet = emptySet()
  private requestRules: Rule[] = []
  private responseRules: Rule[] = []
  private requestMatcher = new RuleMatcher([])
  private responseMatcher = new RuleMatcher([])
  private invalid: RuleStats['invalid'] = []
  /** 有 rewriteBody 规则时才值得为规则去取 body（一次管道往返） */
  private needsBody = false
  private readonly sandbox = new ScriptSandbox()
  private readonly recent: RuleHit[] = []

  private readonly counters = {
    matched: 0,
    applied: 0,
    failed: 0,
    timeouts: 0,
    blocked: 0,
    redirected: 0,
    fulfilled: 0,
    delayed: 0,
    headersRewritten: 0,
    bodiesRewritten: 0,
    skippedBinary: 0
  }
  private matchUsTotal = 0
  private matchUsMax = 0
  private matchSamples = 0

  /** 只替换规则集，不动统计 —— 统计是「本次会话」的，改规则不该清零 */
  setRules(set: RuleSet): void {
    this.set = {
      version: set.version ?? 1,
      rules: Array.isArray(set.rules) ? set.rules : [],
      fixtures: set.fixtures ?? {},
      injections: Array.isArray(set.injections) ? set.injections : []
    }

    const enabled = this.set.rules.filter((rule) => rule.enabled)
    this.invalid = []

    const requestCandidates: Rule[] = []
    const responseCandidates: Rule[] = []
    for (const rule of enabled) {
      const allowed = rule.stage === 'request' ? REQUEST_ACTIONS : RESPONSE_ACTIONS
      if (!allowed.has(rule.action.kind)) {
        this.invalid.push({
          ruleId: rule.id,
          ruleName: rule.name,
          message: `${rule.stage} 阶段不支持 ${rule.action.kind}`
        })
        continue
      }
      if (rule.stage === 'request') requestCandidates.push(rule)
      else responseCandidates.push(rule)
    }

    // 编译不过的规则不能留在列表里：requestPatterns() 会把它们当成拦截范围交给 Fetch.enable
    this.requestMatcher = new RuleMatcher(requestCandidates)
    this.responseMatcher = new RuleMatcher(responseCandidates)
    this.requestRules = this.requestMatcher.accepted
    this.responseRules = this.responseMatcher.accepted
    this.needsBody = this.responseRules.some((rule) => rule.action.kind === 'rewriteBody')
    this.invalid.push(...this.requestMatcher.invalid, ...this.responseMatcher.invalid)
  }

  get ruleSet(): RuleSet {
    return this.set
  }

  get injections(): Injection[] {
    return this.set.injections.filter((item) => item.enabled)
  }

  get ruleCount(): number {
    return this.requestRules.length + this.responseRules.length
  }

  get hasRequestRules(): boolean {
    return this.requestRules.length > 0
  }

  get needsResponseBody(): boolean {
    return this.needsBody
  }

  get hasResponseRules(): boolean {
    return this.responseRules.length > 0
  }

  /** 面板用：当前生效的规则（含被丢弃的和被禁用的，注明原因） */
  describe(): { rule: Rule; active: boolean; problem?: string }[] {
    return this.set.rules.map((rule) => {
      const problem = this.invalid.find((item) => item.ruleId === rule.id)
      return { rule, active: rule.enabled && !problem, problem: problem?.message }
    })
  }

  resetStats(): void {
    for (const key of Object.keys(this.counters) as Array<keyof typeof this.counters>) {
      this.counters[key] = 0
    }
    this.matchUsTotal = 0
    this.matchUsMax = 0
    this.matchSamples = 0
    this.recent.length = 0
  }

  stats(): RuleStats {
    return {
      enabled: this.ruleCount > 0 || this.set.injections.some((item) => item.enabled),
      total: this.ruleCount,
      invalid: this.invalid,
      ...this.counters,
      injections: this.set.injections.filter((item) => item.enabled).length,
      avgMatchUs: this.matchSamples === 0 ? 0 : this.matchUsTotal / this.matchSamples,
      maxMatchUs: this.matchUsMax,
      recent: this.recent.slice(-40).reverse()
    }
  }

  /* ---------------------------------------------------------- CDP 拦截范围 */

  /**
   * 由规则反推 `Fetch.enable` 的 pattern。
   *
   * 这一步是性能的关键：拦到的每一条请求都要多一次管道往返，所以**能窄就窄**。
   * 抠得出 host 的规则只拦那个域；只有真写了「全站正则」的规则才会退化成 `*`。
   */
  requestPatterns(): FetchPattern[] {
    return this.patternsOf(this.requestRules, 'Request')
  }

  /**
   * 响应阶段规则的拦截范围。反推逻辑和请求阶段完全一样，只是 requestStage 是 Response。
   *
   * 为什么必须单独发一份：关掉 body 采集（MONITOR_CAPTURE_BODIES=0）时，enable() 里
   * 就没有「全 resourceType + Response」那批兜底 pattern 了，而响应规则否则等不到
   * requestPaused —— 表现是规则静默失效（实测：同一个探针页，关掉 body 采集后
   * rewriteBody 一条都不生效，日志里一个错都没有）。
   */
  responsePatterns(): FetchPattern[] {
    return this.patternsOf(this.responseRules, 'Response')
  }

  private patternsOf(rules: Rule[], stage: 'Request' | 'Response'): FetchPattern[] {
    const out: FetchPattern[] = []
    const seen = new Set<string>()
    const add = (urlPattern: string, resourceType?: string): void => {
      const key = `${urlPattern}|${resourceType ?? ''}`
      if (seen.has(key)) return
      seen.add(key)
      const pattern: FetchPattern = { urlPattern, requestStage: stage }
      if (resourceType) pattern.resourceType = resourceType
      out.push(pattern)
    }

    for (const rule of rules) {
      const pattern = rule.match.urlPattern.trim()
      const types = rule.match.resourceType?.length ? rule.match.resourceType : [undefined]
      const hosts = pattern.startsWith('re:')
        ? ['*']
        : (() => {
            const { exact, suffix } = patternHost(pattern)
            // Chrome 的 match pattern 里没有端口这一维：`*://host/*` 本来就匹配
            // 该 host 的任意端口。写成 `*://host:*/*` 反而会让 Fetch.enable 整条报错。
            // 实测：Fetch 的 urlPattern 真的会看端口 —— `*://host/*` 拦不到
            // `http://host:8080/x`。所以两种都发：`:*` 覆盖任意端口，无端口那条
            // 兜住默认端口（80/443）的写法。
            if (exact) return [`*://${exact}:*/*`, `*://${exact}/*`]
            if (suffix) return [`*://*${suffix}/*`, `*://${suffix.slice(1)}/*`]
            return ['*']
          })()
      for (const host of hosts) {
        for (const type of types) add(host, type)
      }
    }
    return out
  }

  /* -------------------------------------------------------------- 请求阶段 */

  async planRequest(ctx: ExchangeContext): Promise<Plan> {
    const hit = this.matchTimed(this.requestMatcher, ctx)
    if (!hit) return continuePlan()

    const started = Date.now()
    const action = hit.rule.action
    const finish = (verdict: RequestVerdict, ok = true, detail?: string): Plan => {
      this.counters.matched += 1
      if (ok) this.counters.applied += 1
      else this.counters.failed += 1
      return this.plan(verdict, 0, hit, started, ok, detail, ctx.url)
    }

    switch (action.kind) {
      case 'block':
        this.counters.blocked += 1
        return finish({ kind: 'block' })
      case 'redirect':
        {
          // 先算出结果再记账：算挂了就不该留下「生效过一次」的假账
          const to = expand(action.to, ctx)
          this.counters.redirected += 1
          return finish({ kind: 'redirect', to })
        }
      case 'delay': {
        const ms = Math.max(0, Math.min(MAX_DELAY_MS, action.ms))
        this.counters.delayed += 1
        const plan = finish({ kind: 'continue' })
        return { ...plan, delayMs: ms }
      }
      case 'rewriteHeaders': {
        const headers = applyHeaders(ctx.requestHeaders, action.set, action.remove)
        this.counters.headersRewritten += 1
        return finish({ kind: 'continue', headers })
      }
      case 'fulfill': {
        const body = expand(action.body, ctx)
        const headers = toHeaders(action.headers)
        this.counters.fulfilled += 1
        return finish({ kind: 'fulfill', status: action.status, headers, body })
      }
      case 'mock': {
        const fixture = this.set.fixtures[action.fixture]
        if (!fixture) return finish({ kind: 'continue' }, false, `找不到 fixture「${action.fixture}」`)
        this.counters.fulfilled += 1
        return finish({
          kind: 'fulfill',
          status: fixture.status ?? 200,
          headers: toHeaders(fixture.headers),
          body: expand(fixture.body, ctx)
        })
      }
      default:
        return finish({ kind: 'continue' }, false, `${action.kind} 不属于请求阶段`)
    }
  }

  /* -------------------------------------------------------------- 响应阶段 */

  async planResponse(
    ctx: ExchangeContext,
    body: { text: string; isBinary: boolean } | null
  ): Promise<ResponsePlan> {
    const hit = this.matchTimed(this.responseMatcher, ctx)
    if (!hit) return { ...continuePlan(), verdict: { kind: 'continue' } }

    const started = Date.now()
    const action = hit.rule.action
    const baseHeaders = ctx.responseHeaders ?? []
    const status = ctx.status ?? 200

    const done = (verdict: ResponseVerdict, ok: boolean, detail?: string, newBody?: string) => {
      this.counters.matched += 1
      if (ok) this.counters.applied += 1
      else this.counters.failed += 1
      return { ...this.plan(verdict, 0, hit, started, ok, detail, ctx.url), body: newBody }
    }

    switch (action.kind) {
      case 'rewriteHeaders': {
        const headers = applyHeaders(baseHeaders, action.set, action.remove)
        this.counters.headersRewritten += 1
        return done({ kind: 'continue', headers }, true)
      }

      case 'fulfill':
        this.counters.fulfilled += 1
        return done({
          kind: 'fulfill',
          status: action.status,
          headers: toHeaders(action.headers) ?? baseHeaders,
          body: action.body
        }, true)

      case 'mock': {
        const fixture = this.set.fixtures[action.fixture]
        if (!fixture) {
          return done({ kind: 'continue' }, false, `找不到 fixture「${action.fixture}」`)
        }
        this.counters.fulfilled += 1
        return done({
          kind: 'fulfill',
          status: fixture.status ?? status,
          headers: toHeaders(fixture.headers) ?? baseHeaders,
          body: fixture.body
        }, true)
      }

      case 'rewriteBody': {
        if (!body) return done({ kind: 'continue' }, false, '拿不到响应体')
        if (body.isBinary) {
          this.counters.skippedBinary += 1
          return done({ kind: 'continue' }, true, '二进制响应，跳过改写')
        }
        const result = this.sandbox.run(action.script, body.text, {
          url: ctx.url,
          method: ctx.method,
          status,
          headers: toRecord(baseHeaders),
          isBinary: body.isBinary,
          resourceType: ctx.resourceType
        })
        if (!result.ok) {
          if (result.timedOut) this.counters.timeouts += 1
          return done({ kind: 'continue' }, false, result.error)
        }
        if (result.noop || result.body === undefined) {
          return done({ kind: 'continue' }, true, '脚本没返回字符串，按不改处理')
        }
        this.counters.bodiesRewritten += 1
        return done(
          {
            kind: 'fulfill',
            status,
            headers: dropLengthHeaders(baseHeaders),
            body: result.body
          },
          true,
          undefined,
          result.body
        )
      }

      default:
        return done({ kind: 'continue' }, false, `${action.kind} 不属于响应阶段`)
    }
  }

  /* ------------------------------------------------------------------ 内部 */

  private plan<V extends RequestVerdict | ResponseVerdict>(
    verdict: V,
    delayMs: number,
    hit: { rule: Rule },
    started: number,
    ok: boolean,
    detail?: string,
    url = ''
  ): Plan & { verdict: V } {
    const outcome: RuleHit = {
      ts: started,
      ruleId: hit.rule.id,
      ruleName: hit.rule.name,
      kind: hit.rule.action.kind,
      url,
      ok,
      detail,
      durationMs: Date.now() - started
    }
    this.recent.push(outcome)
    if (this.recent.length > RECENT_CAP) this.recent.shift()
    return { verdict, delayMs, ruleId: hit.rule.id, ruleName: hit.rule.name, outcome }
  }

  /** 匹配耗时单独计时：这是 §6.2 那条 < 50µs 的指标 */
  private matchTimed(matcher: RuleMatcher, ctx: ExchangeContext): { rule: Rule } | null {
    if (matcher.size === 0) return null
    const started = process.hrtime.bigint()
    const hit = matcher.match(ctx as MatchContext)
    const us = Number(process.hrtime.bigint() - started) / 1000
    this.matchUsTotal += us
    this.matchSamples += 1
    if (us > this.matchUsMax) this.matchUsMax = us
    return hit
  }
}

/* ---------------------------------------------------------------- 工具函数 */

function continuePlan(): Plan & { verdict: RequestVerdict } {
  return { verdict: { kind: 'continue' }, delayMs: 0, ruleId: null, ruleName: null, outcome: null }
}

/** set 覆盖、remove 删除；名字大小写不敏感，输出统一小写 */
export function applyHeaders(
  headers: Header[] | Record<string, string>,
  set?: Record<string, string>,
  remove?: string[]
): Header[] {
  // CDP 在 Fetch.requestPaused 里给的 request.headers 是对象、Network 事件里是数组，
  // 两种都收 —— 免得每个调用点各自记得转换一次
  const list: Header[] = Array.isArray(headers)
    ? headers
    : Object.entries(headers ?? {}).map(([name, value]) => ({ name, value: String(value) }))
  const drop = new Set((remove ?? []).map((name) => name.toLowerCase()))
  const override = new Map(
    Object.entries(set ?? {}).map(([name, value]) => [name.toLowerCase(), value])
  )
  const out: Header[] = []
  for (const header of list) {
    const key = header.name.toLowerCase()
    if (drop.has(key)) continue
    if (override.has(key)) {
      out.push({ name: header.name, value: override.get(key) as string })
      override.delete(key)
      continue
    }
    out.push({ name: header.name, value: header.value })
  }
  for (const [name, value] of override) out.push({ name, value })
  return out
}

/**
 * 改过 body 之后 content-length 必然对不上，留着会让浏览器截断或报错。
 * 交给 Chromium 自己按新 body 算。
 */
export function dropLengthHeaders(headers: Header[]): Header[] {
  return headers.filter((header) => {
    const name = header.name.toLowerCase()
    return name !== 'content-length' && name !== 'content-encoding'
  })
}

export function toHeaders(map?: Record<string, string>): Header[] | undefined {
  if (!map) return undefined
  return Object.entries(map).map(([name, value]) => ({ name, value }))
}

function toRecord(headers: Header[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const header of headers) out[header.name.toLowerCase()] = header.value
  return out
}

/** 动作里的 $URL / $HOST 占位符 —— 同一个规则换域名时不用改 */
export function expand(value: string, ctx: ExchangeContext): string {
  if (!value.includes('$')) return value
  return value.replace(/\$URL/g, ctx.url).replace(/\$HOST/g, hostOf(ctx.url))
}

export type { Rule }

// 匹配器的这些零件给单测和管道用，从这里统一出口
export { RuleMatcher, globToRegex, hostOf, patternHost } from './matcher'
