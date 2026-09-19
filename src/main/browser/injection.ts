import type { CdpClient } from './cdp'
import type { Injection } from '../../shared/types'
import { globToRegex } from '../rules/matcher'

/**
 * 注入脚本（设计文档 §7.1 #6）。
 *
 * document_start 走 `Page.addScriptToEvaluateOnNewDocument` —— 它在页面里第一行
 * 脚本之前执行，而且 Profile H 下也能用（不属于 Runtime 域）。
 * document_ready 只能靠 `Runtime.evaluate`，而 Runtime.enable 在 Profile H 是红线
 * （§3.4），所以那个档位下只登记不执行，并把次数记进 skipped 让人看得见。
 *
 * 为什么挂载时不做 URL 过滤：`addScriptToEvaluateOnNewDocument` 必须在文档创建
 * **之前**调用，而导航的目标 URL 只有 `Page.frameRequestedNavigation` 那一刻才知道，
 * 等 CDP 往返回来文档可能已经跑起来了 —— 这是个真实的竞态。所以挂载是无条件的，
 * URL 过滤编译成守卫写进脚本本体，在页面里判断。代价只是多执行几行 if。
 */

export interface InjectionStats {
  count: number
  installed: number
  evaluated: number
  skipped: number
  errors: number
}

interface Prepared {
  injection: Injection
  /** document_ready 用：那个时机不赶时间，按 URL 直接过滤就行 */
  test: (url: string) => boolean
  /** document_start 用：带 URL 守卫的源码 */
  source: string
}

function compile(pattern: string): ((url: string) => boolean) | null {
  const trimmed = pattern.trim()
  if (!trimmed) return () => true
  try {
    const regex = globToRegex(trimmed)
    return (url: string) => regex.test(url)
  } catch {
    return null
  }
}

function guardSource(code: string, regex: RegExp | null): string {
  if (!regex) return code
  // 用 RegExp 构造函数而不是正则字面量：pattern 里可能有 `/`，字面量会被它截断
  return (
    ';(function(){try{if(!(new RegExp(' +
    JSON.stringify(regex.source) +
    ')).test(location.href))return;\n' +
    code +
    '\n}catch(e){}})()\n'
  )
}

export class InjectionRunner {
  private prepared: Prepared[] = []
  /** session → 已经挂过的脚本 id。`addScriptToEvaluateOnNewDocument` 对该 target 的后续文档都生效 */
  private readonly installed = new Map<string, Set<string>>()
  private readonly stats = { installed: 0, evaluated: 0, skipped: 0, errors: 0 }

  constructor(
    private readonly cdp: CdpClient,
    /** Profile H 下没有 Runtime，document_ready 只能是空转 */
    private readonly runtimeAllowed: boolean
  ) {}

  setInjections(injections: Injection[] | undefined): void {
    this.prepared = (injections ?? [])
      .filter((item) => item.enabled && item.code.trim().length > 0)
      .flatMap((injection) => {
        const test = compile(injection.urlPattern)
        if (!test) return []
        let regex: RegExp | null = null
        if (injection.urlPattern.trim()) {
          try {
            regex = globToRegex(injection.urlPattern.trim())
          } catch {
            regex = null
          }
        }
        return [{ injection, test, source: guardSource(injection.code, regex) }]
      })
  }

  getStats(): InjectionStats {
    return { ...this.stats, count: this.prepared.length }
  }

  forget(sessionId: string): void {
    this.installed.delete(sessionId)
  }

  /** 每个 session 调一次（重复调无害）：把所有 document_start 脚本挂上去 */
  async apply(sessionId: string | undefined): Promise<void> {
    if (!sessionId || this.prepared.length === 0) return
    let done = this.installed.get(sessionId)
    if (!done) {
      done = new Set()
      this.installed.set(sessionId, done)
    }

    for (const { injection, source } of this.prepared) {
      if (injection.runAt !== 'document_start') continue
      if (done.has(injection.id)) continue
      try {
        await this.cdp.send(
          'Page.addScriptToEvaluateOnNewDocument',
          { source },
          sessionId
        )
        done.add(injection.id)
        this.stats.installed += 1
      } catch {
        this.stats.errors += 1
      }
    }
  }

  /** document_ready：DOM 建好之后在页面里跑一次 */
  async runReady(sessionId: string | undefined, url: string): Promise<void> {
    if (!sessionId || this.prepared.length === 0) return

    for (const { injection, test } of this.prepared) {
      if (injection.runAt !== 'document_ready') continue
      if (!test(url)) continue
      if (!this.runtimeAllowed) {
        this.stats.skipped += 1
        continue
      }
      try {
        await this.cdp.send('Runtime.evaluate', { expression: injection.code }, sessionId)
        this.stats.evaluated += 1
      } catch {
        this.stats.errors += 1
      }
    }
  }
}