import type { Rule, RuleProblem, RuleSet } from '../../shared/types'
import { globToRegex } from '../rules/matcher'
import type { ProxyRule } from './client'

/**
 * 规则集 → 代理层形状的映射（§6.3 第 2 条：大 body 改写下沉到代理层）。
 *
 * 只下发代理**能等价执行**的规则，宁可漏改也不能改错：
 *   1. 只认 response 阶段的 rewriteBody。改响应头、拦截、延时这些 CDP 那条路都做得了，
 *      同一份规则下发过去只会让两边各执行一次（脚本不一定幂等，重叠比漏改严重得多）；
 *   2. 匹配信号里代理只有 url / method / statusCode —— URL 里没有 frame 信息，
 *      也没有 resourceType / targetType。带这些约束的规则不下发：拿不到信号就没法判，
 *      硬发等于把用户显式写的约束丢掉；
 *   3. urlPattern 的 glob / re: 语义在这里一次性编译成正则（globToRegex 就是主进程
 *      matcher 用的那个），代理侧只做 test，两个执行方的匹配语义因此完全一致。
 *
 * 顺序即优先级：主进程 matcher 的规则是 priority 降序、同号按列表顺序，这里照同一套排，
 * 代理层「取第一条命中的」就等价于「每阶段只应用优先级最高的一条」。
 *
 * 只下发的 rewriteBody 规则条数通常是个位数，所以代理层线性扫列表是可以接受的。
 */
export interface ProxyRulePlan {
  rules: ProxyRule[]
  skipped: RuleProblem[]
}

export function toProxyRules(set: RuleSet): ProxyRulePlan {
  const skipped: RuleProblem[] = []
  const candidates: Array<{ rule: Rule; script: string; regex: RegExp; order: number }> = []
  const list = Array.isArray(set.rules) ? set.rules : []

  list.forEach((rule, order) => {
    if (!rule.enabled) return
    if (rule.stage !== 'response' || rule.action.kind !== 'rewriteBody') return
    const match = rule.match
    const pattern = (match?.urlPattern ?? '').trim()
    const problem = (message: string): void => {
      skipped.push({ ruleId: rule.id, ruleName: rule.name, message })
    }
    if (!pattern) return problem('urlPattern 为空，代理层判不了')
    let regex: RegExp
    try {
      regex = pattern.startsWith('re:') ? new RegExp(pattern.slice(3)) : globToRegex(pattern)
    } catch (err) {
      return problem('urlPattern 不是合法正则：' + (err as Error).message)
    }
    if (match?.frameUrl) return problem('带 frameUrl 约束，代理层拿不到 frame 信息，不下发')
    if (match?.resourceType?.length) {
      return problem('带 resourceType 约束，代理层拿不到资源类型，不下发')
    }
    if (match?.targetType?.length) {
      return problem('带 targetType 约束，代理层拿不到 target 类型，不下发')
    }
    candidates.push({ rule, script: rule.action.script, regex, order })
  })

  candidates.sort((a, b) => b.rule.priority - a.rule.priority || a.order - b.order)

  return {
    skipped,
    rules: candidates.map(({ rule, script, regex }) => {
      const out: ProxyRule = {
        id: rule.id,
        name: rule.name,
        enabled: true,
        urlRegex: regex.source,
        bodyScript: script
      }
      if (regex.flags) out.urlFlags = regex.flags
      if (rule.match?.method?.length) out.methods = rule.match.method.map((m) => m.toUpperCase())
      if (rule.match?.statusCode?.length) out.statuses = rule.match.statusCode
      return out
    })
  }
}
