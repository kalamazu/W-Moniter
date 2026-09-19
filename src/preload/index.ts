import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  BodyPayload,
  CapabilitySet,
  ConsoleEntry,
  ControllerApi,
  DomInspectResult,
  DomTreeRow,
  ControllerStatus,
  EvaluateResult,
  InstanceRow,
  InputAction,
  InputReport,
  Page,
  Profile,
  ProbeReport,
  RequestDetail,
  RequestOrder,
  RequestQuery,
  RequestRecord,
  RuleSet,
  RuleStats,
  ScriptOrder,
  ScriptQuery,
  ScriptRow,
  ScriptSource,
  ScriptStats,
  SessionOverview,
  Stats,
  StoredRequest,
  TimelineRow
} from '../shared/types'

const api: ControllerApi = {
  getStatus: () => ipcRenderer.invoke('monitor:status'),
  clear: () => ipcRenderer.invoke('monitor:clear'),

  onRequests: (callback) => {
    const listener = (_event: IpcRendererEvent, batch: RequestRecord[]): void => callback(batch)
    ipcRenderer.on('monitor:records', listener)
    return () => {
      ipcRenderer.removeListener('monitor:records', listener)
    }
  },

  onStatus: (callback) => {
    const listener = (_event: IpcRendererEvent, status: ControllerStatus): void => callback(status)
    ipcRenderer.on('monitor:status', listener)
    return () => {
      ipcRenderer.removeListener('monitor:status', listener)
    }
  },

  queryRequests: (query: RequestQuery, limit: number, offset: number, order: RequestOrder) =>
    ipcRenderer.invoke('monitor:query', query, limit, offset, order) as Promise<Page<StoredRequest> | null>,

  getDetail: (seq: number) =>
    ipcRenderer.invoke('monitor:detail', seq) as Promise<RequestDetail | null>,

  getBody: (hash: string, withData: boolean) =>
    ipcRenderer.invoke('monitor:body', hash, withData) as Promise<BodyPayload | null>,

  fetchBodyNow: (seq: number) =>
    ipcRenderer.invoke('monitor:fetch-body-now', seq) as Promise<{ ok: boolean; state: string }>,

  getStats: () => ipcRenderer.invoke('monitor:stats') as Promise<Stats | null>,

  queryScripts: (query: ScriptQuery, limit: number, offset: number, order: ScriptOrder) =>
    ipcRenderer.invoke('monitor:scripts', query, limit, offset, order) as Promise<Page<ScriptRow> | null>,

  getScriptSource: (hash: string) =>
    ipcRenderer.invoke('monitor:script-source', hash) as Promise<ScriptSource | null>,

  getScriptStats: () =>
    ipcRenderer.invoke('monitor:script-stats') as Promise<ScriptStats | null>,

  getTimeline: (query: RequestQuery, limit: number) =>
    ipcRenderer.invoke('monitor:timeline', query, limit) as Promise<TimelineRow[]>,

  listInstances: () => ipcRenderer.invoke('monitor:instances') as Promise<InstanceRow[]>,

  getRules: () => ipcRenderer.invoke('monitor:rules') as Promise<RuleSet>,

  saveRules: (rules: RuleSet) =>
    ipcRenderer.invoke('monitor:save-rules', rules) as Promise<{
      ok: boolean
      error?: string
      invalid?: Array<{ ruleId: string; ruleName: string; message: string }>
    }>,

  getRuleStats: () => ipcRenderer.invoke('monitor:rule-stats') as Promise<RuleStats | null>,

  onRules: (callback) => {
    const listener = (_event: IpcRendererEvent, rules: RuleSet): void => callback(rules)
    ipcRenderer.on('monitor:rules', listener)
    return () => {
      ipcRenderer.removeListener('monitor:rules', listener)
    }
  },

  getCapabilities: () =>
    ipcRenderer.invoke('monitor:capabilities') as Promise<CapabilitySet | null>,

  runProbe: (options) =>
    ipcRenderer.invoke('monitor:probe-run', options) as Promise<{
      ok: boolean
      report?: ProbeReport
      error?: string
      via: string
    }>,

  evaluate: (expression: string) =>
    ipcRenderer.invoke('monitor:evaluate', expression) as Promise<EvaluateResult>,

  getConsole: () => ipcRenderer.invoke('monitor:console') as Promise<ConsoleEntry[]>,

  clearConsole: () => ipcRenderer.invoke('monitor:console-clear') as Promise<void>,

  onConsole: (callback) => {
    const listener = (_event: IpcRendererEvent, entry: ConsoleEntry): void => callback(entry)
    ipcRenderer.on('monitor:console', listener)
    return () => {
      ipcRenderer.removeListener('monitor:console', listener)
    }
  },

  runInput: (action: InputAction) =>
    ipcRenderer.invoke('monitor:input', action) as Promise<InputReport>,

  openDataDir: () => ipcRenderer.invoke('monitor:open-data-dir') as Promise<void>,

  /* ---- §7.1 #3 DOM 与元素检查 ---- */

  domGetTree: (nodeId?: number, depth?: number) =>
    ipcRenderer.invoke('monitor:dom-tree', nodeId, depth) as Promise<{
      ok: boolean
      error?: string
      rows: DomTreeRow[]
      enabledDomains: string[]
    }>,

  domInspect: (target: { selector?: string; nodeId?: number }) =>
    ipcRenderer.invoke('monitor:dom-inspect', target) as Promise<DomInspectResult>,

  domHighlight: (nodeId: number, on: boolean) =>
    ipcRenderer.invoke('monitor:dom-highlight', nodeId, on) as Promise<{
      ok: boolean
      error?: string
      enabledDomains: string[]
    }>,

  /* ---- §7.1 #9 会话管理 ---- */

  getSessions: () =>
    ipcRenderer.invoke('monitor:sessions') as Promise<SessionOverview | null>,

  switchProfile: (profile: Profile) =>
    ipcRenderer.invoke('monitor:switch-profile', profile) as Promise<{
      ok: boolean
      error?: string
      profile: Profile
    }>,

  /* ---- 自绘标题栏（frame: false）的窗口控制 ---- */

  isWindowMaximized: () =>
    ipcRenderer.invoke('monitor:window-is-maximized') as Promise<boolean>,

  windowMinimize: () => ipcRenderer.invoke('monitor:window-minimize') as Promise<void>,

  windowToggleMaximize: () =>
    ipcRenderer.invoke('monitor:window-toggle-maximize') as Promise<boolean>,

  windowClose: () => ipcRenderer.invoke('monitor:window-close') as Promise<void>,

  onWindowMaximized: (callback) => {
    const listener = (_event: IpcRendererEvent, maximized: boolean): void => callback(maximized)
    ipcRenderer.on('monitor:window-maximized', listener)
    return () => {
      ipcRenderer.removeListener('monitor:window-maximized', listener)
    }
  }
}

contextBridge.exposeInMainWorld('monitor', api)
