import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  BodyPayload,
  CapabilitySet,
  ConsoleEntry,
  ControllerApi,
  CookieDeleteFilter,
  CookieInput,
  CookieQuery,
  CookieRecord,
  CookieStats,
  SiteDataType,
  SiteDetail,
  SiteOriginRow,
  SiteScanReport,
  SiteSnapshotDiff,
  SiteSnapshotSummary,
  DomInspectResult,
  DomTreeRow,
  ControllerStatus,
  ContractDiff,
  ContractListRow,
  ContractSummary,
  DockSide,
  DockState,
  EndpointDetail,
  EndpointPage,
  EvaluateResult,
  EventPage,
  EventQuery,
  EventStats,
  ExportQuery,
  HarExportReport,
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
  JsonlExportReport,
  RelationReport,
  RequestGraph,
  ResourceExportReport,
  TimelineRow,
  UiSettings,
  WsConnectionRow,
  WsFramePage,
  WsFrameQuery
} from '../shared/types'
import type { WorkspaceCreateInput, WorkspaceOverview, WorkspaceSummary } from '../shared/contracts/workspace'

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

  getWorkspaces: () => ipcRenderer.invoke('monitor:workspaces') as Promise<WorkspaceOverview>,

  onWorkspaces: (callback) => {
    const listener = (_event: IpcRendererEvent, overview: WorkspaceOverview): void => callback(overview)
    ipcRenderer.on('monitor:workspaces', listener)
    return () => {
      ipcRenderer.removeListener('monitor:workspaces', listener)
    }
  },

  createWorkspace: (input: WorkspaceCreateInput) =>
    ipcRenderer.invoke('monitor:workspace-create', input) as Promise<WorkspaceSummary>,

  openWorkspace: (id: string) =>
    ipcRenderer.invoke('monitor:workspace-open', id) as Promise<WorkspaceOverview>,

  suspendWorkspace: (id: string) =>
    ipcRenderer.invoke('monitor:workspace-suspend', id) as Promise<WorkspaceOverview>,

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
  },

  /* ---- 窗口吸附 ---- */

  setDock: (enabled: boolean, side?: DockSide) =>
    ipcRenderer.invoke('monitor:set-dock', enabled, side) as Promise<DockState>,

  onDock: (callback) => {
    const listener = (_event: IpcRendererEvent, state: DockState): void => callback(state)
    ipcRenderer.on('monitor:dock', listener)
    return () => {
      ipcRenderer.removeListener('monitor:dock', listener)
    }
  },

  /* ---- 界面偏好（工作区布局 + 吸附）---- */

  /* ---- 分析层：事件流 / WS / 画像 / 调用图 / 关联 / 导出 / 契约 ---- */

  queryEvents: (query: EventQuery) =>
    ipcRenderer.invoke('monitor:events', query) as Promise<EventPage | null>,

  getEventStats: () => ipcRenderer.invoke('monitor:event-stats') as Promise<EventStats | null>,

  queryWsFrames: (query: WsFrameQuery) =>
    ipcRenderer.invoke('monitor:ws-frames', query) as Promise<WsFramePage | null>,

  getWsConnections: (limit?: number) =>
    ipcRenderer.invoke('monitor:ws-connections', limit) as Promise<{
      rows: WsConnectionRow[]
      total: number
    } | null>,

  getEndpointProfiles: (options) =>
    ipcRenderer.invoke('monitor:endpoints', options) as Promise<EndpointPage | null>,

  getEndpointDetail: (key: string, options) =>
    ipcRenderer.invoke('monitor:endpoint-detail', key, options) as Promise<EndpointDetail | null>,

  getRequestGraph: (options) =>
    ipcRenderer.invoke('monitor:graph', options) as Promise<RequestGraph | null>,

  getRelations: (options) =>
    ipcRenderer.invoke('monitor:relations', options) as Promise<RelationReport | null>,

  exportHar: (options) =>
    ipcRenderer.invoke('monitor:export-har', options) as Promise<HarExportReport>,

  exportJsonl: (options) =>
    ipcRenderer.invoke('monitor:export-jsonl', options) as Promise<JsonlExportReport>,

  exportBodies: (options) =>
    ipcRenderer.invoke('monitor:export-bodies', options) as Promise<ResourceExportReport>,

  contractSnapshot: (options) =>
    ipcRenderer.invoke('monitor:contract-snapshot', options) as Promise<ContractSummary>,

  listContracts: (limit?: number) =>
    ipcRenderer.invoke('monitor:contract-list', limit) as Promise<ContractListRow[] | null>,

  getContract: (id: number, withSchema?: boolean) =>
    ipcRenderer.invoke('monitor:contract-get', id, withSchema) as Promise<unknown>,

  deleteContract: (id: number) =>
    ipcRenderer.invoke('monitor:contract-delete', id) as Promise<{ deleted: number }>,

  contractDiff: (options) =>
    ipcRenderer.invoke('monitor:contract-diff', options) as Promise<ContractDiff>,

  handleDialog: (accept: boolean, promptText?: string) =>
    ipcRenderer.invoke('monitor:dialog', accept, promptText) as Promise<{
      ok: boolean
      error?: string
    }>,
  /* ---- 站点资源：cookie 与站点存储 ---- */

  listCookies: (options) =>
    ipcRenderer.invoke('monitor:cookies', options) as Promise<Page<CookieRecord> | null>,

  getCookieStats: () =>
    ipcRenderer.invoke('monitor:cookie-stats') as Promise<CookieStats | null>,

  getSiteOrigins: (options) =>
    ipcRenderer.invoke('monitor:site-origins', options) as Promise<{
      rows: SiteOriginRow[]
      total: number
    } | null>,

  getSiteDetail: (origin: string) =>
    ipcRenderer.invoke('monitor:site-detail', origin) as Promise<SiteDetail | null>,

  scanSiteData: (options) =>
    ipcRenderer.invoke('monitor:site-scan', options) as Promise<SiteScanReport>,

  setCookie: (input) =>
    ipcRenderer.invoke('monitor:site-cookie-set', input) as Promise<{ ok: boolean; error?: string }>,

  deleteCookies: (filter) =>
    ipcRenderer.invoke('monitor:site-cookie-delete', filter) as Promise<{
      ok: boolean
      error?: string
      deleted: number
    }>,

  clearSiteData: (origin: string, types) =>
    ipcRenderer.invoke('monitor:site-clear', origin, types) as Promise<{
      ok: boolean
      error?: string
      origin: string
      types: string[]
    }>,

  editStorage: (input) =>
    ipcRenderer.invoke('monitor:site-storage', input) as Promise<{ ok: boolean; error?: string }>,

  deleteIdbDatabase: (origin: string, name: string) =>
    ipcRenderer.invoke('monitor:site-idb-delete', origin, name) as Promise<{ ok: boolean; error?: string }>,

  deleteCache: (origin: string, name: string, url?: string) =>
    ipcRenderer.invoke('monitor:site-cache-delete', origin, name, url) as Promise<{ ok: boolean; error?: string }>,

  unregisterServiceWorker: (scopeURL: string) =>
    ipcRenderer.invoke('monitor:site-sw-unregister', scopeURL) as Promise<{ ok: boolean; error?: string }>,

  siteSnapshot: (options) =>
    ipcRenderer.invoke('monitor:site-snapshot', options) as Promise<SiteSnapshotSummary>,

  listSiteSnapshots: (limit?: number) =>
    ipcRenderer.invoke('monitor:site-snapshots', limit) as Promise<SiteSnapshotSummary[] | null>,

  siteSnapshotDiff: (baseId: number) =>
    ipcRenderer.invoke('monitor:site-snapshot-diff', baseId) as Promise<SiteSnapshotDiff | null>,

  deleteSiteSnapshot: (id: number) =>
    ipcRenderer.invoke('monitor:site-snapshot-delete', id) as Promise<{ deleted: number }>,

  uiSettings: () => ipcRenderer.invoke('monitor:ui-settings') as Promise<UiSettings>,

  setUiSettings: (patch) =>
    ipcRenderer.invoke('monitor:set-ui-settings', patch) as Promise<UiSettings>
}

contextBridge.exposeInMainWorld('monitor', api)
