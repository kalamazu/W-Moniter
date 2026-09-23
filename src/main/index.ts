import { app, BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Controller } from './controller'
import { ControlBridge } from './control/bridge'
import { WindowDock } from './window/dock'
import { asLayout, asSide, readUiSettings, writeUiSettings } from './window/settings'
import { resolveRuntimeFile, resolveRuntimeRoot } from './paths'
import { locateNode } from './storage/locate-node'
import { DEFAULT_WINDOW_MS } from '../../proxy/correlate.mjs'
import { emptyRuleSet, readRuleSet, writeRuleSet } from './rules/store'
import { WorkspaceService } from './workspace/service'
import { WorkspaceActionRegistry } from './actions/registry'
import { CaptureEvidenceLedger } from './content/evidence'
import type {
  ConsoleEntry,
  ControllerStatus,
  CookieDeleteFilter as SiteCookieFilter,
  CookieInput as SiteCookieInput,
  EventQuery,
  ExportQuery,
  DockSide,
  DockState,
  InputAction,
  Profile,
  RequestOrder,
  RequestQuery,
  RequestRecord,
  RuleSet,
  ScriptOrder,
  ScriptQuery,
  SiteDataType,
  UiSettings,
  WsFrameQuery
} from '../shared/types'
import type {
  WorkspaceCreateInput,
  WorkspaceOverview,
  WorkspaceSummary
} from '../shared/contracts/workspace'
import type { ActionRequest, ActionResult, TaskSnapshot } from '../shared/contracts/action'

/** 存储编辑的入参（就是 Controller.editStorage 那一个） */
type SiteStorageEdit = Parameters<Controller['editStorage']>[0]

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

const START_URL = process.env['MONITOR_URL'] ?? 'https://example.com'
const PROFILE: Profile = process.env['MONITOR_PROFILE'] === 'H' ? 'H' : 'L'
const HEADLESS = process.env['MONITOR_HEADLESS'] === '1'

/**
 * 数据目录。验收脚本每次都要一个干净的起点 —— Service Worker 会留在
 * profile 里，复用 profile 会让第二次跑出来的请求集合同第一次不一样。
 */
const DATA_DIR = process.env['MONITOR_DATA_DIR'] ?? app.getPath('userData')
const DB_PATH = process.env['MONITOR_DB'] ?? join(DATA_DIR, 'monitor.db')
const PROFILE_DIR = process.env['MONITOR_PROFILE_DIR'] ?? join(DATA_DIR, 'browser-profile')
/** 下载目录。空串 = 用浏览器默认的下载夹（老行为） */
const DOWNLOAD_DIR = process.env['MONITOR_DOWNLOAD_DIR'] ?? join(DATA_DIR, 'downloads')
const CAPTURE_BODIES = process.env['MONITOR_CAPTURE_BODIES'] !== '0'
const BODY_MAX_BYTES = envInt('MONITOR_BODY_MAX_KB', 256) * 1024
const BODY_STORE_BYTES = envInt('MONITOR_BODY_STORE_MB', 512) * 1024 * 1024
const BODY_STORE_COUNT = envInt('MONITOR_BODY_STORE_COUNT', 50_000)
const BODY_TIMEOUT_MS = envInt('MONITOR_BODY_TIMEOUT_MS', 2000)
/** 空 = 全部 resourceType（默认）。`*` / `all` 也认，写法更直白。 */
const BODY_TYPES = (process.env['MONITOR_BODY_TYPES'] ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => Boolean(value) && value !== '*' && value.toLowerCase() !== 'all')

/** 脚本采集。Debugger 域只在 Profile L 开，所以 H 下这里自动失效。 */
const CAPTURE_SCRIPTS = process.env['MONITOR_CAPTURE_SCRIPTS'] !== '0'
const SCRIPT_MAX_KB = envInt('MONITOR_SCRIPT_MAX_KB', 2048)
const SCRIPT_MAX_COUNT = envInt('MONITOR_SCRIPT_MAX_COUNT', 3000)
const SCRIPT_TIMEOUT_MS = envInt('MONITOR_SCRIPT_TIMEOUT_MS', 4000)
const SCRIPT_CONCURRENCY = envInt('MONITOR_SCRIPT_CONCURRENCY', 4)

/**
 * 自动收工。验收脚本要在「跑够时间」之后让应用体面退出 ——
 * 硬杀进程会把采集队列里没落盘的东西丢掉，还会留下孤儿 chrome。
 */
const AUTO_QUIT_MS = envInt('MONITOR_AUTO_QUIT_MS', 0)

/**
 * 出现这个文件就收工。验收脚本靠它精确控制时机 ——
 * 死等固定秒数要么浪费时间，要么在慢机器上截断还没跑完的页面。
 */
const QUIT_FILE = process.env['MONITOR_QUIT_FILE'] ?? ''


/**
 * AI 友好面：控制服务（本地 HTTP API + MCP 的后端）。
 * 默认端口 0 = 让系统分配，实际端口写在 <dataDir>/control.json 里，agent 自己读。
 * MONITOR_API=0 可以整体关掉（比如做「零额外监听面」的隐蔽性验收时）。
 */
const CONTROL_API = process.env['MONITOR_API'] !== '0'
const CONTROL_PORT = envInt('MONITOR_API_PORT', 0)

/** 开局停在哪个面板。截图/演示用，也方便直接从瀑布图开始看 */
// Chrome 不会替我们建这个目录（setDownloadBehavior 指过去但目录不存在时下载会失败）
if (DOWNLOAD_DIR) {
  try {
    mkdirSync(DOWNLOAD_DIR, { recursive: true })
  } catch {
    /* 建不出来就交给浏览器默认行为，不因为它起不来 */
  }
}

const UI_TAB = process.env['MONITOR_UI_TAB'] ?? ''

/** 开局自动选中哪条请求（按 URL 子串匹配）。截图详情面板用 */
const UI_SELECT = process.env['MONITOR_UI_SELECT'] ?? ''

/** 详情面板开局停在哪个 tab：overview / headers / body */
const UI_DTAB = process.env['MONITOR_UI_DTAB'] ?? ''

/** 规则文件。面板里改的规则落在这里，下次启动自动加载 */
const RULES_PATH = process.env['MONITOR_RULES'] ?? join(DATA_DIR, 'rules.json')

/**
 * 窗口吸附的 Win32 助手（`win/dock-helper.ps1`）。
 * 和 control / mcp / proxy 一个套路：打包后走 extraResources 落在 resources/win 下，
 * 必须**在 asar 之外** —— 它是要被 spawn 起来的子进程。
 */
const DOCK_SCRIPT = resolveRuntimeFile('win', 'dock-helper.ps1')

/** 界面偏好（目前只有窗口吸附）。单独一个文件，不和 rules.json 搅在一起 */
const SETTINGS_PATH = join(DATA_DIR, 'ui-settings.json')

/**
 * 本地代理（P5）。开了才有 DNS/TLS 时序，也才有「大 body 改写下沉到代理层」。
 * 默认关：代理会多一个 --proxy-server 特征，不做观测的时候没必要挂着。
 */
const PROXY = process.env['MONITOR_PROXY'] === '1'
const PROXY_KEY = process.env['MONITOR_PROXY_KEY'] ?? ''
const PROXY_REWRITE_MB = envInt('MONITOR_PROXY_REWRITE_MB', 32)
/** 三源关联窗口（ms，单边）。默认 200：§4.3 的 ±50ms 是没量过的先验值，实测不够 */
const PROXY_WINDOW_MS = envInt('MONITOR_PROXY_WINDOW_MS', DEFAULT_WINDOW_MS)
/** 上游 TLS 校验。本地自签 origin 的验收要关掉 */
const PROXY_UPSTREAM_VERIFY = process.env['MONITOR_PROXY_UPSTREAM_VERIFY'] !== '0'
/** 每个工作区都会持有 Chromium、CDP、存储和可选代理；默认先保守限制为 4 个。 */
const MAX_ACTIVE_WORKSPACES = Math.max(1, envInt('MONITOR_MAX_ACTIVE_WORKSPACES', 4))

let controller: Controller | null = null
/** 所有真实运行中的工作区；`controller` 只是其中当前被 UI/Agent 聚焦的一个。 */
const workspaceControllers = new Map<string, Controller>()
let controlBridge: ControlBridge | null = null
let controlPort: number | null = null
let controlWindow: BrowserWindow | null = null
let dock: WindowDock | null = null
let workspaceService: WorkspaceService | null = null
let workspaceActions: WorkspaceActionRegistry | null = null
let activeWorkspace: WorkspaceSummary | null = null

function currentWorkspacePaths(): {
  profileDir: string
  dbPath: string
  contentDir: string
  downloadDir: string
  rulesPath: string
  uiSettingsPath: string
} {
  if (!workspaceService || !activeWorkspace) throw new Error('当前没有活动工作区')
  return workspaceService.pathsFor(activeWorkspace.id)
}

/** 旧 Controller 的配置保持不变；变化的只有由工作区决定的状态目录和采集 Profile。 */
function createControllerForWorkspace(workspace: WorkspaceSummary): Controller {
  if (!workspaceService) throw new Error('WorkspaceService 尚未初始化')
  const paths = workspaceService.pathsFor(workspace.id)
  mkdirSync(paths.downloadDir, { recursive: true })
  return new Controller({
    workspaceId: workspace.id,
    profileId: 'primary',
    userDataDir: paths.profileDir,
    startUrl: START_URL,
    profile: workspace.profile,
    headless: HEADLESS,
    dbPath: paths.dbPath,
    contentDir: paths.contentDir,
    downloadDir: paths.downloadDir,
    captureBodies: CAPTURE_BODIES,
    bodyMaxBytes: BODY_MAX_BYTES,
    bodyStoreMaxBytes: BODY_STORE_BYTES,
    bodyStoreMaxCount: BODY_STORE_COUNT,
    bodyTypes: BODY_TYPES,
    bodyTimeoutMs: BODY_TIMEOUT_MS,
    captureScripts: CAPTURE_SCRIPTS,
    scriptMaxBytes: SCRIPT_MAX_KB * 1024,
    scriptMaxCount: SCRIPT_MAX_COUNT,
    scriptTimeoutMs: SCRIPT_TIMEOUT_MS,
    scriptConcurrency: SCRIPT_CONCURRENCY,
    proxy: PROXY,
    proxyRewriteMaxBytes: PROXY_REWRITE_MB * 1024 * 1024,
    proxyMergeWindowMs: PROXY_WINDOW_MS,
    proxyUpstreamRejectUnauthorized: PROXY_UPSTREAM_VERIFY,
    ...(PROXY_KEY ? { proxyKeyFile: PROXY_KEY } : {})
  })
}

function bindController(next: Controller, workspaceId: string): void {
  next.on('records', (batch: RequestRecord[]) => {
    if (controller !== next) return
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('monitor:records', batch)
    }
  })

  next.on('status', (status: ControllerStatus) => {
    if (status.state === 'error' && workspaceControllers.get(workspaceId) === next) {
      workspaceService?.markError(workspaceId, status.error ?? '浏览器运行失败')
      publishWorkspaces()
    }
    if (controller !== next) return
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('monitor:status', withDock(status))
    }
  })

  next.on('log', (line: string) => console.log(line))
  next.on('console', (entry: ConsoleEntry) => {
    if (controller !== next) return
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('monitor:console', entry)
    }
  })
}

function publishWorkspaces(): void {
  if (!workspaceService || !controlWindow || controlWindow.isDestroyed()) return
  controlWindow.webContents.send('monitor:workspaces', workspaceService.overview())
}

function runningWorkspaceCount(): number {
  let count = 0
  for (const candidate of workspaceControllers.values()) {
    const state = candidate.getStatus().state
    if (state === 'connected' || state === 'connecting' || state === 'launching') count += 1
  }
  return count
}

/** 切工作台焦点不改变任何后台浏览器的运行状态。 */
function focusWorkspace(workspace: WorkspaceSummary, next: Controller | null): void {
  activeWorkspace = workspace
  controller = next
  const paths = currentWorkspacePaths()
  rebuildDock(paths.profileDir, paths.uiSettingsPath)
  controlBridge?.attach(next)
  if (next && controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('monitor:status', withDock(next.getStatus()))
    void dock?.restore()
  }
  publishWorkspaces()
}

function createWorkspace(input: WorkspaceCreateInput): WorkspaceSummary {
  if (!workspaceService) throw new Error('WorkspaceService 尚未初始化')
  const workspace = workspaceService.create(input)
  publishWorkspaces()
  return workspace
}

function getWorkspaceRules(id: string): RuleSet {
  if (!workspaceService) throw new Error('工作区服务还没准备好')
  const running = workspaceControllers.get(id)
  return running?.getRuleSet() ?? readRuleSet(workspaceService.pathsFor(id).rulesPath)
}

function saveWorkspaceRules(id: string, set: RuleSet): { ok: boolean; invalid: unknown[] } {
  if (!workspaceService) throw new Error('工作区服务还没准备好')
  if (!set || typeof set !== 'object' || !Array.isArray(set.rules)) throw new Error('规则集格式不对：需要 { rules: [...] }')
  const paths = workspaceService.pathsFor(id)
  writeRuleSet(paths.rulesPath, set)
  const stats = workspaceControllers.get(id)?.setRuleSet(set)
  if (activeWorkspace?.id === id) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('monitor:rules', set)
    }
  }
  return { ok: true, invalid: stats?.invalid ?? [] }
}

function rebuildDock(profileDir: string, settingsPath: string): void {
  if (!controlWindow) return
  dock?.dispose()
  dock = new WindowDock({
    win: controlWindow,
    scriptPath: DOCK_SCRIPT,
    profileDir,
    settingsPath,
    log: (line: string) => console.log(line)
  })
  dock.onState((state: DockState) => {
    const status = controller?.getStatus()
    if (status) status.dock = state
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('monitor:dock', state)
    }
  })
}

/**
 * 打开工作区会保留其它工作区的 Chromium。切换 UI 焦点不是停止后台工作区；只有
 * suspend 才会关闭指定工作区的浏览器与 CDP。每个运行实例始终绑定自己的 profile。
 */
async function openWorkspace(id: string): Promise<WorkspaceOverview> {
  if (!workspaceService) throw new Error('WorkspaceService 尚未初始化')
  if (activeWorkspace?.id === id && controller?.getStatus().state === 'connected') {
    return workspaceService.overview()
  }

  const intended = workspaceService.get(id)
  if (intended.state === 'archived') throw new Error('已归档工作区不能直接打开')
  const existing = workspaceControllers.get(id)
  if (existing) {
    const state = existing.getStatus().state
    if (state === 'connected' || state === 'connecting' || state === 'launching') {
      focusWorkspace(workspaceService.select(id), existing)
      return workspaceService.overview()
    }
    try {
      await existing.shutdown()
    } finally {
      workspaceControllers.delete(id)
      if (controller === existing) controller = null
    }
  }

  if (runningWorkspaceCount() >= MAX_ACTIVE_WORKSPACES) {
    throw new Error(`同时运行的工作区已达上限（${MAX_ACTIVE_WORKSPACES}）；请先休眠一个工作区`)
  }

  const target = workspaceService.beginOpen(id)
  const next = createControllerForWorkspace(target)
  workspaceControllers.set(target.id, next)
  bindController(next, target.id)
  focusWorkspace(target, next)
  const paths = workspaceService.pathsFor(target.id)
  next.setRuleSet(readRuleSet(paths.rulesPath))

  try {
    await next.start()
    if (next.getStatus().state === 'error') {
      workspaceService.markError(target.id, next.getStatus().error ?? '浏览器启动失败')
    } else {
      workspaceService.markRunning(target.id)
      activeWorkspace = workspaceService.get(target.id)
      publishWorkspaces()
      void dock?.restore()
    }
  } catch (error) {
    workspaceService.markError(target.id, error instanceof Error ? error.message : String(error))
    throw error
  }
  return workspaceService.overview()
}

async function suspendWorkspace(id: string): Promise<WorkspaceOverview> {
  if (!workspaceService) throw new Error('WorkspaceService 尚未初始化')
  const running = workspaceControllers.get(id)
  if (running) await running.shutdown()
  workspaceControllers.delete(id)
  if (controller === running) {
    controller = null
    controlBridge?.attach(null)
  }
  workspaceService.markSuspended(id)
  if (activeWorkspace?.id === id) activeWorkspace = workspaceService.get(id)
  publishWorkspaces()
  return workspaceService.overview()
}

async function shutdownAllWorkspaces(): Promise<Record<string, unknown>> {
  const summaries: Record<string, unknown> = {}
  const running = [...workspaceControllers.entries()]
  workspaceControllers.clear()
  controller = null
  controlBridge?.attach(null)
  for (const [workspaceId, instance] of running) {
    try {
      await instance.shutdown()
      summaries[workspaceId] = instance.summary()
    } catch (error) {
      summaries[workspaceId] = { error: error instanceof Error ? error.message : String(error) }
    }
    try {
      workspaceService?.markSuspended(workspaceId)
    } catch {
      /* 应用关闭时不因一条历史坏记录阻塞其它工作区收尾 */
    }
  }
  return summaries
}

function stopAllWorkspaces(): void {
  for (const [workspaceId, instance] of workspaceControllers) {
    instance.stop()
    try {
      workspaceService?.markSuspended(workspaceId)
    } catch {
      /* 同上：收尾尽力而为 */
    }
  }
  workspaceControllers.clear()
  controller = null
  controlBridge?.attach(null)
}

/**
 * 把吸附状态合进控制器状态。
 *
 * 控制器自己不管窗口吸附（那是主进程这边的事），但面板 / HTTP API / MCP 都只读
 * `getStatus()` —— 在这里补一次，三个面同时就有了，不用各自去问 WindowDock。
 * 和 `publishControl` 往 status 上挂 `control` 是一个套路。
 */
function withDock(status: ControllerStatus | null): ControllerStatus | null {
  if (!status) return status
  const state = dock?.state()
  if (state) status.dock = state
  return status
}

function createControlWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    show: false,
    // 自绘标题栏：系统边框一个像素都不留，拖动 / 三键全在渲染层实现
    // （见 src/renderer/src/components/TitleBar.tsx）。
    // thickFrame 保持默认 true —— 否则窗口连可拖拽的边缘都没了，最大化也铺不满。
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#0d1014',
    title: 'Chromium 监控容器',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    controlWindow = null
  })

  // 自绘标题栏的「最大化 / 还原」图标必须跟着窗口的**真实**状态走：
  // 拖边、双击标题栏、Win+↑、系统吸附都会改状态，只靠点击回调同步会显示错图标。
  const pushMaximized = (): void => {
    if (win.isDestroyed()) return
    win.webContents.send('monitor:window-maximized', win.isMaximized())
  }
  win.on('maximize', pushMaximized)
  win.on('unmaximize', pushMaximized)

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  const params = new URLSearchParams()
  if (UI_TAB) params.set('tab', UI_TAB)
  if (UI_SELECT) params.set('sel', UI_SELECT)
  if (UI_DTAB) params.set('dtab', UI_DTAB)
  const search = params.toString()
  if (devServerUrl) {
    void win.loadURL(search ? `${devServerUrl}?${search}` : devServerUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), search ? { search } : undefined)
  }

  return win
}

function wireIpc(): void {
  ipcMain.handle(
    'monitor:status',
    (): ControllerStatus | null => withDock(controller?.getStatus() ?? null)
  )

  ipcMain.handle('monitor:clear', (): void => {
    controller?.clear()
  })

  ipcMain.handle(
    'monitor:query',
    async (_event, query: RequestQuery, limit: number, offset: number, order: RequestOrder) =>
      (await controller?.queryRequests(query, limit, offset, order)) ?? null
  )

  ipcMain.handle('monitor:detail', async (_event, seq: number) =>
    (await controller?.getDetail(seq)) ?? null
  )

  ipcMain.handle('monitor:body', async (_event, hash: string, withData: boolean) =>
    (await controller?.getBody(hash, withData)) ?? null
  )

  ipcMain.handle('monitor:fetch-body-now', async (_event, seq: number) =>
    (await controller?.fetchBodyNow(seq)) ?? { ok: false, state: 'no_controller' }
  )

  ipcMain.handle('monitor:stats', async () => (await controller?.getStats()) ?? null)

  /* ------------------------------------- 分析层：事件流 / WS / 画像 / 导出 */

  ipcMain.handle('monitor:events', async (_event, query: EventQuery) =>
    (await controller?.queryEvents(query)) ?? null
  )

  ipcMain.handle('monitor:event-stats', async () => (await controller?.getEventStats()) ?? null)

  ipcMain.handle('monitor:ws-frames', async (_event, query: WsFrameQuery) =>
    (await controller?.queryWsFrames(query)) ?? null
  )

  ipcMain.handle('monitor:ws-connections', async (_event, limit?: number) =>
    (await controller?.getWsConnections(limit)) ?? null
  )

  ipcMain.handle(
    'monitor:endpoints',
    async (_event, options: Parameters<Controller['getEndpointProfiles']>[0]) =>
      (await controller?.getEndpointProfiles(options)) ?? null
  )

  ipcMain.handle(
    'monitor:endpoint-detail',
    async (_event, key: string, options: Parameters<Controller['getEndpointDetail']>[1]) =>
      (await controller?.getEndpointDetail(key, options)) ?? null
  )

  ipcMain.handle(
    'monitor:graph',
    async (_event, options: Parameters<Controller['getRequestGraph']>[0]) =>
      (await controller?.getRequestGraph(options)) ?? null
  )

  ipcMain.handle(
    'monitor:relations',
    async (_event, options: Parameters<Controller['getRelations']>[0]) =>
      (await controller?.getRelations(options)) ?? null
  )

  // 导出/契约/对话框这几条不吞异常：它们是「点下去要结果」的动作，
  // 失败必须把原因原样带回渲染进程，返回 null 只会让人以为「没数据」
  ipcMain.handle('monitor:export-har', async (_event, options: ExportQuery) => {
    if (!controller) throw new Error('控制器还没起来')
    return controller.exportHar(options)
  })

  ipcMain.handle('monitor:export-jsonl', async (_event, options: ExportQuery) => {
    if (!controller) throw new Error('控制器还没起来')
    return controller.exportJsonl(options)
  })

  ipcMain.handle('monitor:export-bodies', async (_event, options: ExportQuery & { dir?: string }) => {
    if (!controller) throw new Error('控制器还没起来')
    return controller.exportBodies(options)
  })

  ipcMain.handle(
    'monitor:contract-snapshot',
    async (_event, options: Parameters<Controller['contractSnapshot']>[0]) => {
      if (!controller) throw new Error('控制器还没起来')
      return controller.contractSnapshot(options)
    }
  )

  ipcMain.handle('monitor:contract-list', async (_event, limit?: number) =>
    (await controller?.listContracts(limit)) ?? null
  )

  ipcMain.handle('monitor:contract-get', async (_event, id: number, withSchema?: boolean) =>
    (await controller?.getContract(id, withSchema)) ?? null
  )

  ipcMain.handle('monitor:contract-delete', async (_event, id: number) =>
    (await controller?.deleteContract(id)) ?? { deleted: 0 }
  )

  ipcMain.handle(
    'monitor:contract-diff',
    async (_event, options: Parameters<Controller['contractDiff']>[0]) => {
      if (!controller) throw new Error('控制器还没起来')
      return controller.contractDiff(options)
    }
  )

  /* ---- 站点资源：cookie 与站点存储 ---- */

  ipcMain.handle('monitor:cookies', async (_event, options?: Parameters<Controller['listCookies']>[0]) =>
    (await controller?.listCookies(options ?? {})) ?? null
  )

  ipcMain.handle('monitor:cookie-stats', async () => (await controller?.getCookieStats()) ?? null)

  ipcMain.handle('monitor:site-origins', async (_event, options?: Parameters<Controller['getSiteOrigins']>[0]) =>
    (await controller?.getSiteOrigins(options ?? {})) ?? null
  )

  ipcMain.handle('monitor:site-detail', async (_event, origin: string) =>
    (await controller?.getSiteDetail(origin)) ?? null
  )

  ipcMain.handle('monitor:site-scan', async (_event, options?: Parameters<Controller['scanSiteData']>[0]) => {
    if (!controller) throw new Error('控制器还没起来')
    return controller.scanSiteData(options ?? {})
  })

  ipcMain.handle('monitor:site-cookie-set', async (_event, input: SiteCookieInput) =>
    (await controller?.setCookie(input)) ?? { ok: false, error: '控制器还没起来' }
  )

  ipcMain.handle('monitor:site-cookie-delete', async (_event, filter: SiteCookieFilter) =>
    (await controller?.deleteCookies(filter)) ?? { ok: false, error: '控制器还没起来', deleted: 0 }
  )

  ipcMain.handle('monitor:site-clear', async (_event, origin: string, types: SiteDataType[]) =>
    (await controller?.clearSiteData(origin, types)) ?? { ok: false, error: '控制器还没起来', origin, types: [] }
  )

  ipcMain.handle('monitor:site-storage', async (_event, input: SiteStorageEdit) =>
    (await controller?.editStorage(input)) ?? { ok: false, error: '控制器还没起来' }
  )

  ipcMain.handle('monitor:site-idb-delete', async (_event, origin: string, name: string) =>
    (await controller?.deleteIdbDatabase(origin, name)) ?? { ok: false, error: '控制器还没起来' }
  )

  ipcMain.handle('monitor:site-cache-delete', async (_event, origin: string, name: string, url?: string) =>
    (await controller?.deleteCache(origin, name, url)) ?? { ok: false, error: '控制器还没起来' }
  )

  ipcMain.handle('monitor:site-sw-unregister', async (_event, scopeURL: string) =>
    (await controller?.unregisterServiceWorker(scopeURL)) ?? { ok: false, error: '控制器还没起来' }
  )

  ipcMain.handle('monitor:site-snapshot', async (_event, options?: { label?: string }) => {
    if (!controller) throw new Error('控制器还没起来')
    return controller.siteSnapshot(options ?? {})
  })

  ipcMain.handle('monitor:site-snapshots', async (_event, limit?: number) =>
    (await controller?.listSiteSnapshots(limit)) ?? null
  )

  ipcMain.handle('monitor:site-snapshot-diff', async (_event, baseId: number) =>
    (await controller?.siteSnapshotDiff(baseId)) ?? null
  )

  ipcMain.handle('monitor:site-snapshot-delete', async (_event, id: number) =>
    (await controller?.deleteSiteSnapshot(id)) ?? { deleted: 0 }
  )

  ipcMain.handle('monitor:dialog', async (_event, accept: boolean, promptText?: string) =>
    (await controller?.handleDialog(accept, promptText)) ?? { ok: false, error: '控制器还没起来' }
  )
  ipcMain.handle('monitor:timeline', async (_event, query: RequestQuery, limit: number) =>
    (await controller?.getTimeline(query, limit)) ?? []
  )

  ipcMain.handle(
    'monitor:scripts',
    async (_event, query: ScriptQuery, limit: number, offset: number, order: ScriptOrder) =>
      (await controller?.queryScripts(query, limit, offset, order)) ?? null
  )

  ipcMain.handle('monitor:script-source', async (_event, hash: string) =>
    (await controller?.getScriptSource(hash)) ?? null
  )

  ipcMain.handle('monitor:script-stats', async () => (await controller?.getScriptStats()) ?? null)

  ipcMain.handle('monitor:instances', async () => (await controller?.listInstances()) ?? [])

  ipcMain.handle('monitor:rules', (): RuleSet => controller?.getRuleSet() ?? emptyRuleSet())

  ipcMain.handle('monitor:rule-stats', () => controller?.getRuleStats() ?? null)

  /* ------------------------------------------------------ P6 探针 / 控制台 */

  ipcMain.handle('monitor:capabilities', () => controller?.getCapabilities() ?? null)

  ipcMain.handle('monitor:probe-run', async (_event, options: { viaInject?: boolean } | undefined) =>
    (await controller?.runProbe(options ?? {})) ?? {
      ok: false,
      error: '控制器还没起来',
      via: 'none'
    }
  )

  ipcMain.handle('monitor:evaluate', async (_event, expression: string) =>
    (await controller?.evaluate(String(expression ?? ''))) ?? {
      ok: false,
      error: '控制器还没起来',
      durationMs: 0
    }
  )

  ipcMain.handle('monitor:console', () => controller?.getConsole() ?? [])

  ipcMain.handle('monitor:console-clear', () => {
    controller?.clearConsole()
  })

  ipcMain.handle('monitor:input', async (_event, action: InputAction) =>
    (await controller?.runInput(action)) ?? {
      kind: action?.kind ?? 'move',
      ok: false,
      points: 0,
      durationMs: 0,
      straight: 0,
      pathLength: 0,
      maxStep: 0,
      minStep: 0,
      maxStepMs: 0,
      minStepMs: 0,
      pauses: 0,
      error: '控制器还没起来'
    }
  )

  /* ---- §7.1 #3 DOM 与元素检查 ---- */

  ipcMain.handle('monitor:dom-tree', async (_event, nodeId?: number, depth?: number) =>
    (await controller?.domGetTree(nodeId, depth)) ?? {
      ok: false,
      error: '控制器还没起来',
      rows: [],
      enabledDomains: []
    }
  )

  ipcMain.handle(
    'monitor:dom-inspect',
    async (_event, target: { selector?: string; nodeId?: number }) =>
      (await controller?.domInspect(target ?? {})) ?? {
        ok: false,
        error: '控制器还没起来',
        enabledDomains: [],
        durationMs: 0
      }
  )

  ipcMain.handle('monitor:dom-highlight', async (_event, nodeId: number, on: boolean) =>
    (await controller?.domHighlight(nodeId, Boolean(on))) ?? {
      ok: false,
      error: '控制器还没起来',
      enabledDomains: []
    }
  )

  /* ---- §7.1 #9 会话管理 ---- */

  ipcMain.handle('monitor:sessions', async () => (await controller?.getSessions()) ?? null)

  ipcMain.handle('monitor:switch-profile', async (_event, profile: Profile) => {
    const result = (await controller?.switchProfile(profile === 'H' ? 'H' : 'L')) ?? {
      ok: false,
      error: '控制器还没起来',
      profile: 'L' as Profile
    }
    // 换 Profile = 换了一个浏览器进程/窗口，旧句柄必然失效 —— 重新抓一次贴上去
    if (result.ok) {
      if (activeWorkspace) activeWorkspace = workspaceService?.setProfile(activeWorkspace.id, result.profile) ?? activeWorkspace
      void dock?.resnap()
    }
    return result
  })

  /* ---- Core 0.1：持久工作区 ---- */

  const executeWorkspaceAction = async (request: ActionRequest): Promise<ActionResult> => {
    if (!workspaceActions) throw new Error('工作区动作服务还没准备好')
    return workspaceActions.execute(request)
  }

  ipcMain.handle('monitor:workspaces', (): Promise<ActionResult> =>
    executeWorkspaceAction({ action: 'workspaces.list', input: {}, target: { kind: 'workspace-collection' } })
  )

  ipcMain.handle('monitor:workspace-create', (_event, input: WorkspaceCreateInput, idempotencyKey?: string): Promise<ActionResult> => {
    if (!input || typeof input !== 'object' || typeof input.name !== 'string') {
      throw new Error('工作区参数格式不对：需要 name')
    }
    return executeWorkspaceAction({
      action: 'workspace.create',
      input: { name: input.name, ...(input.profile === 'H' || input.profile === 'L' ? { profile: input.profile } : {}) },
      target: { kind: 'workspace-collection' },
      ...(typeof idempotencyKey === 'string' ? { idempotencyKey } : {})
    })
  })

  ipcMain.handle('monitor:workspace-open', (_event, id: string, idempotencyKey?: string): Promise<ActionResult> => {
    if (typeof id !== 'string' || !id) throw new Error('缺少工作区 ID')
    return executeWorkspaceAction({
      action: 'workspace.open', input: {}, target: { kind: 'workspace', workspaceId: id },
      ...(typeof idempotencyKey === 'string' ? { idempotencyKey } : {})
    })
  })

  ipcMain.handle('monitor:workspace-suspend', (_event, id: string, idempotencyKey?: string): Promise<ActionResult> => {
    if (typeof id !== 'string' || !id) throw new Error('缺少工作区 ID')
    return executeWorkspaceAction({
      action: 'workspace.suspend', input: {}, target: { kind: 'workspace', workspaceId: id },
      ...(typeof idempotencyKey === 'string' ? { idempotencyKey } : {})
    })
  })

  ipcMain.handle('monitor:action-execute', (_event, request: ActionRequest): Promise<ActionResult> => executeWorkspaceAction(request))
  ipcMain.handle('monitor:action-catalog', () => workspaceActions?.catalog() ?? { actions: [] })
  ipcMain.handle('monitor:task-cancel', (_event, taskId: string): TaskSnapshot => {
    if (!workspaceActions) throw new Error('工作区动作服务还没准备好')
    return workspaceActions.cancel(taskId)
  })

  ipcMain.handle('monitor:save-rules', (_event, workspaceId: string, set: RuleSet): Promise<ActionResult> =>
    executeWorkspaceAction({ action: 'rules.save', input: { set }, target: { kind: 'workspace', workspaceId } })
  )

  ipcMain.handle('monitor:open-data-dir', async (): Promise<void> => {
    await shell.openPath(dirname(currentWorkspacePaths().dbPath))
  })

  /* ---- 自绘标题栏（frame: false）的窗口控制 ---- */

  /**
   * 用 sender 反查窗口，而不是直接用模块级的 controlWindow：
   * 将来开多个控制窗口（多会话）时各管各的，渲染层不用告诉主进程「我是谁」。
   */
  const senderWindow = (event: IpcMainInvokeEvent): BrowserWindow | null => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win && !win.isDestroyed() ? win : null
  }

  ipcMain.handle(
    'monitor:window-is-maximized',
    (event): boolean => senderWindow(event)?.isMaximized() ?? false
  )

  ipcMain.handle('monitor:window-minimize', (event): void => {
    senderWindow(event)?.minimize()
  })

  ipcMain.handle('monitor:window-toggle-maximize', (event): boolean => {
    const win = senderWindow(event)
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })

  ipcMain.handle('monitor:window-close', (event): void => {
    // 用 win.close() 而不是 app.exit()：走正常关闭流程，
    // window-all-closed 里会停掉控制服务、排空采集队列，不会丢没落盘的数据。
    senderWindow(event)?.close()
  })

  /* ---- 窗口吸附 ---- */

  ipcMain.handle(
    'monitor:set-dock',
    async (_event, enabled: boolean, side?: DockSide): Promise<DockState> =>
      (await dock?.setEnabled(Boolean(enabled), side)) ?? {
        enabled: false,
        available: false,
        attached: false,
        side: 'right',
        reason: 'not-ready'
      }
  )

  /* ---- 界面偏好（吸附 + 工作区布局）。每个工作区各有一份。 ---- */

  ipcMain.handle('monitor:ui-settings', (): UiSettings =>
    readUiSettings(currentWorkspacePaths().uiSettingsPath)
  )

  ipcMain.handle(
    'monitor:set-ui-settings',
    (_event, patch: Partial<UiSettings>): UiSettings => {
      const settingsPath = currentWorkspacePaths().uiSettingsPath
      const current = readUiSettings(settingsPath)
      const next: UiSettings = {
        // 逐字段修：布局是渲染层摆出来的，坏值不能落盘把下次启动也带坏
        dock: patch?.dock ? { enabled: patch.dock.enabled === true, side: asSide(patch.dock.side) } : current.dock,
        layout: patch?.layout ? asLayout(patch.layout) : current.layout
      }
      writeUiSettings(settingsPath, next)
      return next
    }
  )
}

app.whenReady().then(async () => {
  wireIpc()
  const controlWin = createControlWindow()
  controlWindow = controlWin

  workspaceService = new WorkspaceService({
    dataDir: DATA_DIR,
    // 默认工作区保留升级前目录，不移动既有浏览器资料和 monitor.db。
    legacy: {
      profileDir: PROFILE_DIR,
      dbPath: DB_PATH,
      contentDir: join(DATA_DIR, 'content'),
      downloadDir: DOWNLOAD_DIR,
      rulesPath: RULES_PATH,
      uiSettingsPath: SETTINGS_PATH
    },
    defaultProfile: PROFILE
  })
  workspaceService.initialize()
  workspaceActions = new WorkspaceActionRegistry(workspaceService, {
    create: createWorkspace,
    open: openWorkspace,
    suspend: suspendWorkspace,
    getRules: getWorkspaceRules,
    saveRules: saveWorkspaceRules,
    getEvidence: (id, seq) => {
      const instance = workspaceControllers.get(id)
      if (instance) return instance.getBodyEvidence(seq)
      const ledger = new CaptureEvidenceLedger(workspaceService!.pathsFor(id).contentDir)
      return ledger.entriesBySeq(seq).then((events) => ({ request: null, events, classification: events.length ? 'offline_evidence_only' : 'request_not_found' }))
    },
    revokeContent: (id, hash, reason) => {
      const instance = workspaceControllers.get(id)
      if (!instance) throw new Error('目标工作区未运行，清理前需打开工作区以对账 SQLite 引用')
      return instance.revokeContent(hash, reason)
    },
    getAuth: (id) => {
      const instance = workspaceControllers.get(id)
      if (!instance) throw new Error('目标工作区未运行，登录证据暂不可读')
      return instance.authSummary()
    },
    verifyAuth: (id, origin) => {
      const instance = workspaceControllers.get(id)
      if (!instance) throw new Error('目标工作区未运行，无法主动验证')
      return instance.verifyFixtureAuth(origin)
    }
  }, { journalPath: join(DATA_DIR, 'tasks', 'journal.json') })
  activeWorkspace = workspaceService.active()
  await openWorkspace(activeWorkspace.id)

  // AI 友好面：把控制服务拉起来，并把它的地址写进状态（面板与 agent 都读得到）
  if (CONTROL_API) {
    try {
      const located = await locateNode()
      if (!located.candidate) throw new Error('找不到系统 Node（控制服务需要 node >= 22）')
      const nodePath = located.candidate.path
      controlBridge = new ControlBridge({
        root: resolveRuntimeRoot(),
        dataDir: DATA_DIR,
        port: CONTROL_PORT,
        nodePath
      })
      controlBridge.onLog = (line: string) => console.log(line)
      // agent 读的 /status 也要能看到吸附状态（和面板走同一份 withDock）
      controlBridge.decorateStatus = (status: ControllerStatus): ControllerStatus =>
        withDock(status) ?? status
      controlBridge.attachWorkspace({
        execute: async (request) => {
          if (!workspaceActions) throw new Error('工作区动作服务还没准备好')
          return workspaceActions.execute(request)
        },
        catalog: () => workspaceActions?.catalog() ?? { actions: [] },
        cancel: (taskId) => {
          if (!workspaceActions) throw new Error('工作区动作服务还没准备好')
          return workspaceActions.cancel(taskId)
        }
      })
      if (!controller) throw new Error('活动工作区没有可用的浏览器控制器')
      controlBridge.attach(controller)
      controlBridge.start()
    } catch (error) {
      console.log(`[control] 控制服务没起来：${(error as Error).message}`)
      controlBridge = null
    }
  }

  const publishControl = (): void => {
    const port = controlBridge?.readyPort ?? (CONTROL_PORT || null)
    controlPort = port
    const status = controller?.getStatus()
    if (!status) return
    status.control = {
      enabled: CONTROL_API,
      host: CONTROL_API ? '127.0.0.1' : null,
      port: CONTROL_API ? port : null,
      infoPath: CONTROL_API ? join(DATA_DIR, 'control.json') : null,
      mcp: CONTROL_API ? resolveRuntimeFile('mcp', 'server.mjs') : null
    }
  }
  publishControl()
  const controlPoll = setInterval(() => {
    if (controlBridge?.readyPort) {
      publishControl()
      clearInterval(controlPoll)
    }
  }, 200)
  controlPoll.unref?.()

  const finish = (): void => {
    // 先排空再打汇总 —— 否则看到的是收工前的队列残留，会误判成丢数据
    void (async () => {
      await controlBridge?.stop()
      controlBridge = null
      const summaries = await shutdownAllWorkspaces()
      console.log('MONITOR_SUMMARY ' + JSON.stringify({ workspaces: summaries }))
      app.quit()
    })()
  }

  if (AUTO_QUIT_MS > 0) setTimeout(finish, AUTO_QUIT_MS)
  if (QUIT_FILE) {
    const poll = setInterval(() => {
      if (!existsSync(QUIT_FILE)) return
      clearInterval(poll)
      finish()
    }, 200)
  }
})

app.on('window-all-closed', () => {
  void controlBridge?.stop()
  stopAllWorkspaces()
  dock?.dispose()
  dock = null
  app.quit()
})

app.on('before-quit', () => {
  void controlBridge?.stop()
  stopAllWorkspaces()
  dock?.dispose()
  dock = null
})
