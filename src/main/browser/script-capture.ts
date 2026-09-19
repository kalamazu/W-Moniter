import { createHash } from 'node:crypto'
import type { CdpClient } from './cdp'
import type { ScriptRecord } from '../../shared/types'

/**
 * 脚本采集：Debugger.scriptParsed → 拉源码 → 交给调用方落盘。
 *
 * 为什么用 Debugger 而不是 Network 的响应体：
 *   Network 只看得到「从网络加载的」脚本。内联 <script>、eval、
 *   new Function、importScripts 进来的代码全都看不见 —— 而这恰恰是
 *   分析目标站点时最有意思的部分。Debugger.scriptParsed 是 V8 层事件，
 *   覆盖全部，而且带上 scriptId 可以反向回捞源码。
 *
 * 代价（诚实记录）：
 *   Debugger.enable 会让 V8 进入可调试状态，它本身就是 CDP 检测面的一部分
 *   （§3.4 把 Debugger 列为高风险 domain）。所以只在 Profile L 开；
 *   Profile H 下这条路径整体关闭。
 *
 * 三条纪律：
 *   1) 事件回调里只入队，绝不 await —— 它在 CDP 事件路径上；
 *   2) 拉源码有并发上限 + 超时。页面跑得比采集快是常态，不是错误；
 *   3) 单个脚本有体积上限，超了只留元数据 —— 落盘体积不能由页面决定。
 */

export interface ScriptConfig {
  enabled: boolean
  /** 单个脚本源码上限，超了只留元数据 */
  maxSourceBytes: number
  /** 一次会话最多采集多少个脚本 */
  maxScripts: number
  /** 并发拉源码的上限 */
  concurrency: number
  /** 拉源码超时；超时就当拿不到，不能拖住队列 */
  timeoutMs: number
}

export interface ScriptCaptureStats {
  seen: number
  captured: number
  capturedBytes: number
  tooLarge: number
  failed: number
  dropped: number
  inFlight: number
  queueDepth: number
}

interface PendingFetch {
  sessionId: string
  scriptId: string
  url: string
  size: number
  startLine: number
}

/**
 * 拿不到源码时用的稳定 key：url + 长度。
 * 必须是稳定的，否则同一个超限脚本每次会话都会新落一行。
 * 加前缀是为了让「元数据 key」永远不会和「内容 hash」撞上。
 */
function metaHash(url: string, size: number, startLine: number): string {
  const digest = createHash('sha256')
    .update(url + '\u0000' + size + '\u0000' + startLine)
    .digest('hex')
  return 'meta:' + digest.slice(0, 32)
}

function metaRecord(job: PendingFetch): ScriptRecord {
  return {
    hash: metaHash(job.url, job.size, job.startLine),
    url: job.url,
    size: job.size,
    startLine: job.startLine,
    scriptId: job.scriptId
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('拉取脚本源码超时')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

export class ScriptCapture {
  private readonly sessions = new Set<string>()
  private readonly queue: PendingFetch[] = []
  private inFlight = 0
  private stopped = false
  private readonly stats = {
    seen: 0,
    captured: 0,
    capturedBytes: 0,
    tooLarge: 0,
    failed: 0,
    dropped: 0
  }

  constructor(
    private readonly cdp: CdpClient,
    private readonly config: ScriptConfig,
    private readonly onRecord: (record: ScriptRecord) => void
  ) {}

  isEnabled(): boolean {
    return this.config.enabled
  }

  getStats(): ScriptCaptureStats {
    return { ...this.stats, inFlight: this.inFlight, queueDepth: this.queue.length }
  }

  reset(): void {
    this.stats.seen = 0
    this.stats.captured = 0
    this.stats.capturedBytes = 0
    this.stats.tooLarge = 0
    this.stats.failed = 0
    this.stats.dropped = 0
    this.queue.length = 0
  }

  stop(): void {
    this.stopped = true
    this.queue.length = 0
  }

  /** 每个新 session 都要单独开，否则那个 target 的脚本一条都看不到 */
  async enable(sessionId: string): Promise<void> {
    if (!this.isEnabled()) return
    this.sessions.add(sessionId)
    await this.cdp.send('Debugger.enable', {}, sessionId)
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /**
   * 事件入口。返回 true 表示这个事件被这边消化了。
   * 注意：这里不能 await，只做入队。
   */
  handleEvent(
    sessionId: string | undefined,
    method: string,
    params: Record<string, unknown>
  ): boolean {
    if (method !== 'Debugger.scriptParsed') return false
    if (!sessionId || !this.sessions.has(sessionId)) return false
    if (this.stopped) return true

    const scriptId = String(params.scriptId ?? '')
    if (!scriptId) return true
    const url = typeof params.url === 'string' ? params.url : ''
    const size = Number(params.length ?? 0) || 0
    const startLine = Number(params.startLine ?? 0) || 0

    if (this.stats.seen >= this.config.maxScripts) {
      this.stats.dropped += 1
      return true
    }
    this.stats.seen += 1

    const job: PendingFetch = { sessionId, scriptId, url, size, startLine }

    // 明显超限的连拉都不拉，直接落元数据
    if (size > this.config.maxSourceBytes) {
      this.stats.tooLarge += 1
      this.onRecord(metaRecord(job))
      return true
    }

    this.queue.push(job)
    this.pump()
    return true
  }

  private pump(): void {
    while (!this.stopped && this.inFlight < this.config.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()
      if (!job) break
      this.inFlight += 1
      void this.fetchOne(job).finally(() => {
        this.inFlight -= 1
        this.pump()
      })
    }
  }

  private async fetchOne(job: PendingFetch): Promise<void> {
    let source: string | null = null
    try {
      const result = (await withTimeout(
        this.cdp.send('Debugger.getScriptSource', { scriptId: job.scriptId }, job.sessionId),
        this.config.timeoutMs
      )) as { scriptSource?: unknown } | undefined
      if (result && typeof result.scriptSource === 'string') source = result.scriptSource
    } catch {
      source = null
    }

    // 拿不到就记元数据：脚本确实存在过，「没源码」和「不知道有这脚本」是两回事
    if (source === null || source.length > this.config.maxSourceBytes) {
      if (source !== null) this.stats.tooLarge += 1
      else this.stats.failed += 1
      this.onRecord(metaRecord(job))
      return
    }

    this.stats.captured += 1
    this.stats.capturedBytes += source.length
    this.onRecord({
      hash: createHash('sha256').update(source).digest('hex'),
      url: job.url,
      size: source.length,
      startLine: job.startLine,
      scriptId: job.scriptId,
      source
    })
  }
}
