/**
 * proxy/correlate.mjs 的类型声明（给主进程的 TS 用）。
 * 实现刻意留在 .mjs：这样 scripts/test-correlate.mjs 能直接跑，不需要先 build。
 */
import type { RequestRecord } from '../src/shared/types'

export interface NetTimings {
  dns?: number
  connect?: number
  tls?: number
  ttfb?: number
  download?: number
}

export interface ProxyFlow {
  flowId: string
  startedAt: number
  finishedAt?: number
  scheme: string
  host: string
  port: number
  method: string
  url: string
  status?: number
  statusText?: string
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string>
  timings: NetTimings
  upstreamIp?: string
  tlsVersion?: string
  tlsCipher?: string
  upstreamAlpn?: string
  responseBytes?: number
  error?: string
  /** 收工 drain 补报的：响应还没结束，时序不完整（没有 download） */
  open?: boolean
}

export interface CorrelateStats {
  cdpCount: number
  proxyCount: number
  merged: number
  cdpOnly: number
  proxyOnly: number
  ambiguous: number
  mergeRate: number
  cdpMergeRate: number
  proxyMergeRate: number
}

export declare const DEFAULT_WINDOW_MS: number
export declare function correlate(
  cdpRecords: RequestRecord[],
  proxyFlows: ProxyFlow[],
  opts?: { windowMs?: number }
): { records: RequestRecord[]; stats: CorrelateStats }

export interface Correlator {
  addFlow(flow: ProxyFlow): void
  /**
   * 晚配的修正记录（长连接的 flow 收工补报时反向配上已标 cdp-only 的记录）。
   * 按同一个 seq 重投即可 —— 存储是 upsert，UI 是重查库的，不会多出一行。
   */
  takeRevisions(): RequestRecord[]
  match(record: RequestRecord): RequestRecord
  flush(now?: number): RequestRecord[]
  readonly stats: CorrelateStats
  /** 受控范围内的关联统计（§12 的关联率按它算） */
  readonly scopeStats: CorrelateStats
}

export declare function makeCorrelator(opts?: {
  windowMs?: number
  retentionMs?: number
  /** 只统计这个谓词为真的 URL（Chrome 自身后台请求 CDP 看不到，算进来会稀释关联率） */
  inScope?: (url: string) => boolean
}): Correlator
