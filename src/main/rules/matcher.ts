import type { Rule } from '../../shared/types'

/**
 * URL 匹配器（设计文档 §6.2）。
 *
 * 规则上到几千条时，逐条跑正则会把 Fetch 管道拖垮 —— 而管道是串行的，
 * 慢一点就是页面整体变慢。所以这里做两件事：
 *   1. **按 host 分桶**：绝大多数规则都盯着某一两个域，先按 host 取候选，
 *      全局兜底的那几条单独放一个桶。要测的规则数从「全部」降到「同域的几条」。
 *   2. **正则编译期建好**，匹配路径上只做 `regex.test` 和几个 Set 查询。
 *
 * 语义：每个阶段只应用**优先级最高的一条命中规则**（同优先级按列表顺序）。
 * 多条规则叠加会让「到底哪条生效」没法推理，宁可让用户显式调优先级。
 */

export interface MatchContext {
  url: string
  method: string
  resourceType?: string
  targetType?: string
  frameUrl?: string
  /** 只有响应阶段有 */
  status?: number
}

export interface CompiledRule {
  rule: Rule
  regex: RegExp
  /** 在编译进来的规则里的序号，同优先级时用它定序 */
  index: number
  method: Set<string> | null
  resourceType: Set<string> | null
  statusCode: Set<number> | null
  frameUrl: RegExp | null
  targetType: Set<string> | null
}

export interface RuleProblem {
  ruleId: string
  ruleName: string
  message: string
}

const META = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\'])

/** `*` 匹配任意字符（含 `/`），`?` 匹配单个字符，其余按字面量 */
export function globToRegex(glob: string): RegExp {
  let out = ''
  for (const ch of glob) {
    if (ch === '*') out += '[^]*'
    else if (ch === '?') out += '.'
    else if (META.has(ch)) out += '\\' + ch
    else out += ch
  }
  return new RegExp('^' + out + '$')
}

/**
 * 从 pattern 里把 host 抠出来当分桶键。
 * `*://*.example.com/*` 这种才有价值 —— 抠不出来就丢进全局桶。
 */
export function patternHost(pattern: string): { exact: string | null; suffix: string | null } {
  let rest = pattern.replace(/^(\*|[a-zA-Z][a-zA-Z0-9+.-]*):\/\//, '')
  if (rest.startsWith('//')) rest = rest.slice(2)
  const cut = rest.search(/[/?#]/)
  const authority = cut === -1 ? rest : rest.slice(0, cut)
  // `host:8080` 和 `host:*` 都归到同一个 host —— 端口不进分桶键
  const host = authority.replace(/:\d+$/, '').replace(/:\*$/, '').toLowerCase()
  if (!host) return { exact: null, suffix: null }
  if (!host.includes('*') && !host.includes('?')) return { exact: host, suffix: null }
  const wildcard = /^\*\.([^*?]+)$/.exec(host)
  if (wildcard) return { exact: null, suffix: '.' + wildcard[1] }
  return { exact: null, suffix: null }
}

/**
 * 手写而不是 `new URL()` —— 这条路径每个请求都要走一遍，
 * URL 构造函数要 1~2µs，手写这十来行是纳秒级。
 */
export function hostOf(url: string): string {
  const schemeEnd = url.indexOf('://')
  let rest = schemeEnd === -1 ? url : url.slice(schemeEnd + 3)
  const cut = rest.search(/[/?#]/)
  if (cut !== -1) rest = rest.slice(0, cut)
  const at = rest.lastIndexOf('@')
  if (at !== -1) rest = rest.slice(at + 1)
  // IPv6 字面量 `[::1]:8080` 里的冒号不是端口分隔符，别在 `[` 后截断
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']')
    return (close === -1 ? rest : rest.slice(0, close + 1)).toLowerCase()
  }
  const port = rest.indexOf(':')
  if (port !== -1) rest = rest.slice(0, port)
  return rest.toLowerCase()
}

function setOf(values: string[] | undefined, upper: boolean): Set<string> | null {
  if (!values || values.length === 0) return null
  return new Set(values.map((value) => (upper ? value.toUpperCase() : value)))
}

export class RuleMatcher {
  private readonly exact = new Map<string, CompiledRule[]>()
  private readonly suffix = new Map<string, CompiledRule[]>()
  private readonly any: CompiledRule[] = []
  private readonly acceptedRules: Rule[] = []
  private readonly problems: RuleProblem[] = []
  private count = 0

  constructor(rules: Rule[]) {
    const order = (a: CompiledRule, b: CompiledRule): number =>
      b.rule.priority - a.rule.priority || a.index - b.index

    rules.forEach((rule, index) => {
      const compiled = compile(rule, index)
      if ('message' in compiled) {
        this.problems.push({ ruleId: rule.id, ruleName: rule.name, message: compiled.message })
        return
      }
      this.count += 1
      this.acceptedRules.push(rule)
      const pattern = rule.match.urlPattern.trim()
      if (pattern.startsWith('re:')) {
        this.any.push(compiled)
        return
      }
      const { exact, suffix } = patternHost(pattern)
      if (exact) push(this.exact, exact, compiled)
      else if (suffix) push(this.suffix, suffix, compiled)
      else this.any.push(compiled)
    })

    // 桶内先排好，匹配时就不用再排 —— 匹配路径上一个分配都不做
    for (const list of this.exact.values()) list.sort(order)
    for (const list of this.suffix.values()) list.sort(order)
    this.any.sort(order)
  }

  get size(): number {
    return this.count
  }

  get invalid(): RuleProblem[] {
    return this.problems
  }

  /** 通过编译的规则（原顺序）—— 引擎用它剔掉坏规则 */
  get accepted(): Rule[] {
    return this.acceptedRules
  }

  /** 桶结构，测试和统计用 */
  buckets(): { exact: number; suffix: number; any: number } {
    let exact = 0
    let suffix = 0
    for (const list of this.exact.values()) exact += list.length
    for (const list of this.suffix.values()) suffix += list.length
    return { exact, suffix, any: this.any.length }
  }

  match(ctx: MatchContext): CompiledRule | null {
    if (this.count === 0) return null

    const host = hostOf(ctx.url)
    let best: CompiledRule | null = null
    let bestPriority = -Infinity
    let bestIndex = Infinity

    const consider = (list: CompiledRule[] | undefined): void => {
      if (!list) return
      for (const candidate of list) {
        // 桶内已按优先级降序，比不过当前的就不用再测了
        if (
          candidate.rule.priority < bestPriority ||
          (candidate.rule.priority === bestPriority && candidate.index > bestIndex)
        ) {
          continue
        }
        if (!test(candidate, ctx)) continue
        best = candidate
        bestPriority = candidate.rule.priority
        bestIndex = candidate.index
      }
    }

    consider(this.exact.get(host))
    // a.b.example.com → 试 .b.example.com、.example.com（`*.example.com` 落在这）
    let dot = host.indexOf('.')
    while (dot !== -1) {
      consider(this.suffix.get(host.slice(dot)))
      dot = host.indexOf('.', dot + 1)
    }
    consider(this.any)
    return best
  }
}

function push(map: Map<string, CompiledRule[]>, key: string, rule: CompiledRule): void {
  const list = map.get(key)
  if (list) list.push(rule)
  else map.set(key, [rule])
}

function test(rule: CompiledRule, ctx: MatchContext): boolean {
  if (rule.method && !rule.method.has(ctx.method.toUpperCase())) return false
  if (rule.resourceType && !(ctx.resourceType && rule.resourceType.has(ctx.resourceType))) {
    return false
  }
  if (rule.targetType && !(ctx.targetType && rule.targetType.has(ctx.targetType))) return false
  if (rule.statusCode && (ctx.status === undefined || !rule.statusCode.has(ctx.status))) return false
  if (rule.frameUrl && !(ctx.frameUrl && rule.frameUrl.test(ctx.frameUrl))) return false
  return rule.regex.test(ctx.url)
}

function compile(rule: Rule, index: number): CompiledRule | { message: string } {
  const pattern = (rule.match.urlPattern ?? '').trim()
  if (!pattern) return { message: 'urlPattern 为空' }

  let regex: RegExp
  try {
    regex = pattern.startsWith('re:') ? new RegExp(pattern.slice(3)) : globToRegex(pattern)
  } catch (err) {
    return { message: `urlPattern 不是合法正则：${(err as Error).message}` }
  }

  let frameUrl: RegExp | null = null
  if (rule.match.frameUrl) {
    try {
      frameUrl = globToRegex(rule.match.frameUrl)
    } catch (err) {
      return { message: `frameUrl 不是合法 glob：${(err as Error).message}` }
    }
  }

  return {
    rule,
    regex,
    index,
    method: setOf(rule.match.method, true),
    resourceType: setOf(rule.match.resourceType, false),
    targetType: setOf(rule.match.targetType, false),
    statusCode:
      rule.match.statusCode && rule.match.statusCode.length > 0
        ? new Set(rule.match.statusCode)
        : null,
    frameUrl
  }
}
