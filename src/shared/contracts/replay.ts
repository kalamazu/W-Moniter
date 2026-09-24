export type ReplayMode = 'browser' | 'independent'
export interface ReplayTemplate {
  id: string
  version: number
  name: string
  collection?: string
  sourceSeq?: number
  method: string
  url: string
  headers: Array<{ name: string; value: string }>
  body?: { kind: 'text' | 'base64'; value: string; contentType?: string }
  cookiePolicy: 'browser' | 'omit' | 'explicit'
  createdAt: number
  updatedAt: number
}

export interface ReplayRun {
  id: string
  templateId: string
  templateVersion: number
  mode: ReplayMode
  startedAt: number
  finishedAt: number
  state: 'succeeded' | 'failed' | 'canceled' | 'unknown'
  request: { method: string; url: string; headers: Array<{ name: string; value: string }>; bodyHash?: string }
  response?: { status: number; url: string; headers: Array<{ name: string; value: string }>; bodyHash?: string; size: number; durationMs: number }
  diff?: { statusChanged?: [number | null, number]; bodyChanged?: boolean }
  error?: string
}

export interface ReplayExecutionInput { templateId: string; version?: number; mode: ReplayMode; timeoutMs?: number; confirmWrite?: boolean }
