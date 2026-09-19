import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Controller } from './controller'
import { ControlBridge } from './control/bridge'
import { resolveRuntimeFile, resolveRuntimeRoot } from './paths'
import { locateNode } from './storage/locate-node'
import { DEFAULT_WINDOW_MS } from '../../proxy/correlate.mjs'
import { emptyRuleSet, readRuleSet, writeRuleSet } from './rules/store'
import type {
  ConsoleEntry,
  ControllerStatus,
  InputAction,
  Profile,
  RequestOrder,
  RequestQuery,
  RequestRecord,
  RuleSet,
  ScriptOrder,
  ScriptQuery
} from '../shared/types'

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
const CAPTURE_BODIES = process.env['MONITOR_CAPTURE_BODIES'] !== '0'
const BODY_MAX_BYTES = envInt('MONITOR_BODY_MAX_KB', 256) * 1024
const BODY_STORE_BYTES = envInt('MONITOR_BODY_STORE_MB', 512) * 1024 * 1024
const BODY_STORE_COUNT = envInt('MONITOR_BODY_STORE_COUNT', 50_000)
const BODY_TIMEOUT_MS = envInt('MONITOR_BODY_TIMEOUT_MS', 2000)
const BODY_TYPES = (process.env['MONITOR_BODY_TYPES'] ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

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
const UI_TAB = process.env['MONITOR_UI_TAB'] ?? ''

/** 开局自动选中哪条请求（按 URL 子串匹配）。截图详情面板用 */
const UI_SELECT = process.env['MONITOR_UI_SELECT'] ?? ''

/** 详情面板开局停在哪个 tab：overview / headers / body */
const UI_DTAB = process.env['MONITOR_UI_DTAB'] ?? ''

/** 规则文件。面板里改的规则落在这里，下次启动自动加载 */
const RULES_PATH = process.env['MONITOR_RULES'] ?? join(DATA_DIR, 'rules.json')

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

let controller: Controller | null = null
let controlBridge: ControlBridge | null = null
let controlPort: number | null = null
let controlWindow: BrowserWindow | null = null

function createControlWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    show: false,
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
  ipcMain.handle('monitor:status', (): ControllerStatus | null => controller?.getStatus() ?? null)

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

  ipcMain.handle('monitor:switch-profile', async (_event, profile: Profile) =>
    (await controller?.switchProfile(profile === 'H' ? 'H' : 'L')) ?? {
      ok: false,
      error: '控制器还没起来',
      profile: 'L' as Profile
    }
  )

  ipcMain.handle('monitor:save-rules', (_event, set: RuleSet) => {
    if (!set || typeof set !== 'object' || !Array.isArray(set.rules)) {
      return { ok: false, error: '规则集格式不对：需要 { rules: [...] }' }
    }
    const stats = controller?.setRuleSet(set)
    try {
      writeRuleSet(RULES_PATH, set)
    } catch (err) {
      return { ok: false, error: `写入 ${RULES_PATH} 失败：${(err as Error).message}` }
    }
    // 其它窗口/面板要能看到最新规则
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('monitor:rules', set)
    }
    return { ok: true, invalid: stats?.invalid ?? [] }
  })

  ipcMain.handle('monitor:open-data-dir', async (): Promise<void> => {
    await shell.openPath(dirname(DB_PATH))
  })
}

app.whenReady().then(async () => {
  wireIpc()
  controlWindow = createControlWindow()

  controller = new Controller({
    // 独立 profile，绝不碰用户真实的浏览器数据
    userDataDir: PROFILE_DIR,
    startUrl: START_URL,
    profile: PROFILE,
    headless: HEADLESS,
    dbPath: DB_PATH,
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
    // P5：本地代理 + 三源关联
    proxy: PROXY,
    proxyRewriteMaxBytes: PROXY_REWRITE_MB * 1024 * 1024,
    proxyMergeWindowMs: PROXY_WINDOW_MS,
    proxyUpstreamRejectUnauthorized: PROXY_UPSTREAM_VERIFY,
    ...(PROXY_KEY ? { proxyKeyFile: PROXY_KEY } : {})
  })

  controller.on('records', (batch: RequestRecord[]) => {
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('monitor:records', batch)
    }
  })

  controller.on('status', (status: ControllerStatus) => {
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('monitor:status', status)
    }
  })

  controller.on('log', (line: string) => {
    console.log(line)
  })

  // 控制台面板要实时看到页面里的 console 输出，攒批没意义（量小、人要看时序）
  controller.on('console', (entry: ConsoleEntry) => {
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('monitor:console', entry)
    }
  })

  controller.setRuleSet(readRuleSet(RULES_PATH))
  await controller.start()

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
      await controller?.shutdown()
      console.log('MONITOR_SUMMARY ' + JSON.stringify(controller?.summary() ?? {}))
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
  controller?.stop()
  app.quit()
})

app.on('before-quit', () => {
  void controlBridge?.stop()
  controller?.stop()
})
