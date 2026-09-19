import type { RequestQuery, StoredRequest } from '../../shared/types'

export function formatSize(bytes?: number | null): string {
  if (bytes === undefined || bytes === null || bytes < 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export function formatMs(ms?: number | null): string {
  if (ms === undefined || ms === null) return '-'
  if (ms < 1) return '<1 ms'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

export function formatTime(ts?: number | null): string {
  if (!ts) return '-'
  const date = new Date(ts)
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

export function formatCount(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(2)}M`
}

export function statusClass(status?: number | null, failed?: string | null): string {
  if (failed) return 'st-err'
  if (!status) return 'st-dim'
  if (status >= 500) return 'st-err'
  if (status >= 400) return 'st-warn'
  if (status >= 300) return 'st-info'
  if (status >= 200) return 'st-ok'
  return 'st-dim'
}

export function splitUrl(url: string): { host: string; path: string } {
  try {
    const parsed = new URL(url)
    return { host: parsed.host, path: `${parsed.pathname}${parsed.search}` }
  } catch {
    return { host: '', path: url }
  }
}

/**
 * body_state 是采集侧的真实结论，不是「有没有」的二值 ——
 * 「没采到」和「本来就没有」必须能一眼分开。
 */
export const BODY_STATE_LABEL: Record<string, string> = {
  none: '未采集',
  stored: '已落盘',
  hash_only: '超大·仅摘要',
  too_large: '超大·未取',
  no_length: '无长度·未取',
  streaming: '流式·跳过',
  empty: '空响应',
  error: '取回失败',
  timeout: '取回超时',
  evicted: '已被驱逐',
  unmatched: '未关联',
  skipped: '已关闭采集'
}

export function bodyStateLabel(state?: string | null): string {
  if (!state) return '-'
  return BODY_STATE_LABEL[state] ?? state
}

/** 常见资源类型 → 颜色，瀑布图和类型标签共用 */
export const TYPE_COLOR: Record<string, string> = {
  Document: '#6fb6ff',
  Stylesheet: '#c792ea',
  Script: '#e0a548',
  Image: '#4ec9a0',
  Font: '#ff9ecb',
  XHR: '#7ee787',
  Fetch: '#7ee787',
  EventSource: '#ffd479',
  Media: '#ff8a65',
  Manifest: '#8b95a5',
  WebSocket: '#ffd479',
  Ping: '#8b95a5',
  Other: '#8b95a5'
}

export function typeColor(type?: string | null): string {
  if (!type) return '#8b95a5'
  return TYPE_COLOR[type] ?? '#8b95a5'
}

export interface UiFilters {
  search: string
  resourceType: string
  statusBand: string
  targetType: string
  onlyFailed: boolean
  onlyWithBody: boolean
}

export function buildQuery(filters: UiFilters): RequestQuery {
  const query: RequestQuery = {}
  if (filters.search.trim()) query.search = filters.search.trim()
  if (filters.resourceType !== 'all') query.resourceType = filters.resourceType
  if (filters.targetType !== 'all') query.targetType = filters.targetType
  if (filters.onlyFailed) query.onlyFailed = true
  if (filters.onlyWithBody) query.hasBody = true
  switch (filters.statusBand) {
    case '2xx':
      query.statusMin = 200
      query.statusMax = 299
      break
    case '3xx':
      query.statusMin = 300
      query.statusMax = 399
      break
    case '4xx':
      query.statusMin = 400
      query.statusMax = 499
      break
    case '5xx':
      query.statusMin = 500
      break
    case 'pending':
      query.onlyPending = true
      break
    default:
      break
  }
  return query
}

export function rowKey(row: StoredRequest): string {
  return `${row.inst}:${row.seq}`
}
