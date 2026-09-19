import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Injection, MockFixture, Rule, RuleSet } from '../../shared/types'

/**
 * 规则集的落盘格式。
 *
 * 单独一个模块是为了能被单测直接打 —— 规则文件是面板和验收脚本共用的接口，
 * 「文件坏了怎么办」这种事必须有测试，而不是靠人肉试。
 */

export function emptyRuleSet(): RuleSet {
  return { version: 1, rules: [], fixtures: {}, injections: [] }
}

/**
 * 读规则。坏文件不能让应用起不来：记一条日志，当空规则跑。
 * 字段类型不对也不抛 —— 面板存下来的东西可能被人手改过。
 */
export function readRuleSet(path: string, log: (line: string) => void = console.log): RuleSet {
  if (!existsSync(path)) return emptyRuleSet()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RuleSet>
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      rules: Array.isArray(parsed.rules) ? (parsed.rules as Rule[]) : [],
      fixtures:
        parsed.fixtures && typeof parsed.fixtures === 'object'
          ? (parsed.fixtures as Record<string, MockFixture>)
          : {},
      injections: Array.isArray(parsed.injections) ? (parsed.injections as Injection[]) : []
    }
  } catch (err) {
    log(`[rules] ${path} 解析失败，按空规则跑：${(err as Error).message}`)
    return emptyRuleSet()
  }
}

export function writeRuleSet(path: string, set: RuleSet): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(set, null, 2), 'utf8')
}