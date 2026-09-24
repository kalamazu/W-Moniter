export interface BrowserTabState {
  targetId: string
  type: string
  url: string
  attached: boolean
  generation: number
  frames: Array<{ id: string; parentId?: string; url: string; name?: string }>
}

export interface BrowserTree {
  browserId: 'primary'
  tabs: BrowserTabState[]
  capturedAt: number
}

export type BrowserTabCommand =
  | { kind: 'navigate'; url: string }
  | { kind: 'reload'; ignoreCache?: boolean }
  | { kind: 'activate' }
  | { kind: 'close' }
  | { kind: 'upload'; selector: string; files: string[] }
  | { kind: 'wait'; condition: 'load' | 'selector' | 'url'; value?: string; timeoutMs?: number }

export interface BrowserActionEvidence {
  actionId: string
  targetId: string
  generation: number
  kind: string
  startedAt: number
  finishedAt: number
  ok: boolean
  result?: unknown
  error?: string
}
