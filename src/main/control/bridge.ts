import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import type {
  ControllerStatus,
  CookieDeleteFilter,
  CookieInput,
  CookieQuery,
  EventQuery,
  InputAction,
  Profile,
  RequestQuery,
  RequestOrder,
  RuleSet,
  ScreenshotOptions,
  ScriptOrder,
  ScriptQuery,
  SiteDataType,
  WsFrameQuery
} from '../../shared/types'
import type { ActionCatalog, ActionRequest, ActionResult, TaskSnapshot } from '../../shared/contracts/action'
import type { Controller } from '../controller'

/** 工作区动作不依赖“当前浏览器已经连上”，所以与 Controller 桥接单独保留。 */
export interface WorkspaceControlApi {
  execute(request: ActionRequest): Promise<ActionResult>
  catalog(): ActionCatalog
  cancel(taskId: string): TaskSnapshot
  task(taskId: string): ActionResult | null
  taskEvents(after?: number, limit?: number): unknown
}

/**
 * 控制桥：把主进程里的 Controller 暴露给「控制服务」子进程（control/server.mjs）。
 *
 * 方向：
 *   控制进程 → 主进程：stdout 上的 { id, method, params }（我们要应答）
 *   主进程 → 控制进程：stdin 上的 { id, method, params }（我们发问候/收工）
 *
 * 与存储、代理保持同一个模式：主进程只编排，网络面在子进程里。
 */
/** 控制面传进来的是字符串/undefined，统一收成可选数字 —— 别把 undefined 变成 NaN */
function numOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

export class ControlBridge {
  private child: ChildProcess | null = null
  private api: Controller | null = null
  private workspaceApi: WorkspaceControlApi | null = null
  private dataDir: string
  private root: string
  private port: number
  private nodePath: string
  private stopping = false
  /** 控制服务实际监听的端口（端口传 0 时由系统分配，ready 事件里回传） */
  readyPort: number | null = null
  onLog: (line: string) => void = () => {}
  /**
   * 主进程补的额外状态（目前是窗口吸附）。
   *
   * status 是 agent 的入口（HTTP /status、MCP status 工具都读它），但窗口吸附是主进程
   * 这边的事、控制器自己不知道 —— 在这儿补一次，agent 读到的就是完整的应用状态，
   * 不用为「现在吸没吸附」单开一个接口。
   */
  decorateStatus: (status: ControllerStatus) => ControllerStatus = (status) => status

  constructor(options: { root: string; dataDir: string; port: number; nodePath: string }) {
    this.root = options.root
    this.dataDir = options.dataDir
    this.port = options.port
    this.nodePath = options.nodePath
  }

  attach(api: Controller | null): void {
    this.api = api
  }

  attachWorkspace(api: WorkspaceControlApi | null): void {
    this.workspaceApi = api
  }

  start(): void {
    if (this.child) return
    const entry = join(this.root, 'control', 'server.mjs')
    const child = spawn(
      this.nodePath,
      [entry, `--data-dir=${this.dataDir}`, `--port=${this.port}`],
      { cwd: this.root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    )
    this.child = child
    this.stopping = false

    const out = createInterface({ input: child.stdout! })
    out.on('line', (line) => this.onLine(line))
    const err = createInterface({ input: child.stderr! })
    err.on('line', (line) => this.onLog(`[control] ${line}`))

    child.on('exit', (code) => {
      if (this.child !== child) return
      this.child = null
      if (!this.stopping) this.onLog(`[control] 控制服务退出（code=${code}），HTTP API 已不可用`)
    })
    child.on('error', (error) => {
      if (this.child !== child) return
      this.onLog(`[control] 起不来：${error.message}`)
    })
  }

  private onLine(line: string): void {
    const text = line.trim()
    if (!text) return
    let msg: { id?: number; method?: string; params?: Record<string, unknown>; event?: string; payload?: unknown }
    try {
      msg = JSON.parse(text)
    } catch {
      this.onLog(`[control] 收到坏行：${text.slice(0, 200)}`)
      return
    }
    if (msg.event) {
      if (msg.event === 'ready') {
        const payload = msg.payload as { port?: number } | undefined
        if (payload?.port) this.readyPort = payload.port
        this.onLog(`[control] HTTP API 就绪：http://127.0.0.1:${payload?.port ?? this.port}`)
      } else if (msg.event === 'log') {
        this.onLog(`[control] ${String(msg.payload)}`)
      }
      return
    }
    if (typeof msg.id === 'number' && msg.method) {
      void this.dispatch(msg.id, msg.method, msg.params ?? {})
    }
  }

  private reply(payload: Record<string, unknown>): void {
    if (!this.child) return
    this.child.stdin?.write(JSON.stringify(payload) + '\n')
  }

  private async dispatch(id: number, method: string, params: Record<string, unknown>): Promise<void> {
    if (method === 'workspaces.list' || method === 'workspace.create' || method === 'workspace.open' || method === 'workspace.suspend' || method === 'tasks.diagnostics' || method === 'actions.catalog' || method === 'action.execute' || method === 'task.cancel' || method === 'task.get' || method === 'task.events') {
      const workspace = this.workspaceApi
      if (!workspace) return this.reply({ id, error: '工作区服务还没起来' })
      try {
        if (method === 'actions.catalog') return this.reply({ id, result: workspace.catalog() })
        if (method === 'task.cancel') return this.reply({ id, result: workspace.cancel(String(params.taskId ?? '')) })
        if (method === 'task.get') return this.reply({ id, result: workspace.task(String(params.taskId ?? '')) })
        if (method === 'task.events') return this.reply({ id, result: workspace.taskEvents(Number(params.after ?? 0), Number(params.limit ?? 200)) })
        if (method === 'action.execute') return this.reply({ id, result: await workspace.execute(params.request as ActionRequest) })
        let request: ActionRequest
        switch (method) {
          case 'workspaces.list':
            request = { action: 'workspaces.list', input: {}, target: { kind: 'workspace-collection' } }
            break
          case 'tasks.diagnostics':
            request = { action: 'tasks.diagnostics', input: {} }
            break
          case 'workspace.create':
            request = {
              action: 'workspace.create',
              input: { name: String(params.name ?? ''), ...(params.profile === 'H' || params.profile === 'L' ? { profile: params.profile } : {}) },
              target: (params.target as ActionRequest['target']) ?? { kind: 'workspace-collection' },
              ...(typeof params.idempotencyKey === 'string' ? { idempotencyKey: params.idempotencyKey } : {})
            }
            break
          case 'workspace.open':
            request = {
              action: 'workspace.open', input: {},
              target: (params.target as ActionRequest['target']) ?? { kind: 'workspace', workspaceId: String(params.id ?? '') },
              ...(typeof params.idempotencyKey === 'string' ? { idempotencyKey: params.idempotencyKey } : {})
            }
            break
          default:
            request = {
              action: 'workspace.suspend', input: {},
              target: (params.target as ActionRequest['target']) ?? { kind: 'workspace', workspaceId: String(params.id ?? '') },
              ...(typeof params.idempotencyKey === 'string' ? { idempotencyKey: params.idempotencyKey } : {})
            }
        }
        return this.reply({ id, result: await workspace.execute(request) })
      } catch (error) {
        return this.reply({ id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    const api = this.api
    if (!api) return this.reply({ id, error: '控制器还没起来' })
    try {
      const result = await this.callApi(api, method, params)
      this.reply({ id, result: result ?? null })
    } catch (error) {
      this.reply({ id, error: error instanceof Error ? error.message : String(error) })
    }
  }

  private async callApi(api: Controller, method: string, p: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'status':
        return this.decorateStatus(api.getStatus())
      case 'capabilities':
        return api.getCapabilities()
      case 'clear':
        return api.clear()
      case 'requests.query':
        return api.queryRequests(
          (p.query ?? {}) as RequestQuery,
          Number(p.limit ?? 100),
          Number(p.offset ?? 0),
          (p.order ?? 'time_desc') as RequestOrder
        )
      case 'request.detail':
        return api.getDetail(Number(p.seq))
      case 'body.get':
        return api.getBody(String(p.hash ?? ''), p.withData !== false)
      case 'body.fetchNow':
        return api.fetchBodyNow(Number(p.seq))
      case 'stats':
        return api.getStats()
      case 'timeline':
        return api.getTimeline((p.query ?? {}) as RequestQuery, Number(p.limit ?? 200))
      case 'scripts.query':
        return api.queryScripts(
          (p.query ?? {}) as ScriptQuery,
          Number(p.limit ?? 100),
          Number(p.offset ?? 0),
          (p.order ?? 'time_desc') as ScriptOrder
        )
      case 'script.source':
        return api.getScriptSource(String(p.hash ?? ''))
      case 'scriptStats':
        return api.getScriptStats()
      case 'instances':
        return api.listInstances()
      case 'rules.get':
        return api.getRuleSet()
      case 'rules.save':
        return api.setRuleSet((p.set ?? { rules: [] }) as RuleSet)
      case 'rules.stats':
        return api.getRuleStats()
      case 'probe.run':
        return api.runProbe((p.options ?? {}) as { viaInject?: boolean })
      case 'evaluate':
        return api.evaluate(String(p.expression ?? ''))
      case 'console.list':
        return api.getConsole()
      case 'console.clear':
        return api.clearConsole()
      case 'input.run':
        return api.runInput((p.action ?? {}) as InputAction)
      case 'dom.tree':
        return api.domGetTree(
          p.nodeId === undefined ? undefined : Number(p.nodeId),
          p.depth === undefined ? undefined : Number(p.depth)
        )
      case 'dom.inspect':
        return api.domInspect((p.target ?? {}) as { selector?: string; nodeId?: number })
      case 'navigate':
        return api.navigate(String(p.url ?? ''))
      case 'screenshot':
        return api.screenshot((p.options ?? {}) as ScreenshotOptions)
      case 'dom.highlight':
        return api.domHighlight(Number(p.nodeId), Boolean(p.on))
      case 'sessions':
        return api.getSessions()
      case 'sessions.switchProfile':
        return api.switchProfile((p.profile === 'H' ? 'H' : 'L') as Profile)

      /* ---- 事件流 / WebSocket ---- */

      case 'events.query':
        return api.queryEvents((p.query ?? {}) as EventQuery)
      case 'eventStats':
        return api.getEventStats()
      case 'ws.query':
        return api.queryWsFrames((p.query ?? {}) as WsFrameQuery)
      case 'ws.connections':
        return api.getWsConnections(numOrUndefined(p.limit))

      /* ---- 分析：画像 / 调用图 / 关联 ---- */

      case 'endpoints.profiles':
        return api.getEndpointProfiles({
          query: p.query as RequestQuery | undefined,
          sort: p.sort === undefined ? undefined : String(p.sort),
          minCalls: numOrUndefined(p.minCalls),
          limit: numOrUndefined(p.limit),
          maxRows: numOrUndefined(p.maxRows)
        })
      case 'endpoint.detail':
        return api.getEndpointDetail(String(p.key ?? ''), {
          query: p.query as RequestQuery | undefined,
          sampleLimit: numOrUndefined(p.sampleLimit),
          callLimit: numOrUndefined(p.callLimit),
          maxRows: numOrUndefined(p.maxRows)
        })
      case 'graph':
        return api.getRequestGraph({
          query: p.query as RequestQuery | undefined,
          maxRows: numOrUndefined(p.maxRows),
          maxNodes: numOrUndefined(p.maxNodes)
        })
      case 'relations':
        return api.getRelations({
          query: p.query as RequestQuery | undefined,
          maxRows: numOrUndefined(p.maxRows),
          limit: numOrUndefined(p.limit)
        })

      /* ---- 导出 ---- */

      case 'export.har':
        return api.exportHar({
          query: p.query as RequestQuery | undefined,
          maxRows: numOrUndefined(p.maxRows),
          includeBodies: p.includeBodies !== false
        })
      case 'export.jsonl':
        return api.exportJsonl({
          query: p.query as RequestQuery | undefined,
          maxRows: numOrUndefined(p.maxRows),
          includeBodies: p.includeBodies !== false
        })
      case 'export.bodies':
        return api.exportBodies({
          query: p.query as RequestQuery | undefined,
          maxRows: numOrUndefined(p.maxRows),
          includeBodies: p.includeBodies !== false,
          dir: p.dir === undefined ? undefined : String(p.dir)
        })

      /* ---- 契约快照与回归 ---- */

      case 'contract.snapshot':
        return api.contractSnapshot({
          label: p.label === undefined ? undefined : String(p.label),
          query: p.query as RequestQuery | undefined,
          sampleLimit: numOrUndefined(p.sampleLimit)
        })
      case 'contract.list':
        return api.listContracts(numOrUndefined(p.limit))
      case 'contract.get':
        return api.getContract(Number(p.id), p.withSchema !== false)
      case 'contract.delete':
        return api.deleteContract(Number(p.id))
      case 'contract.diff':
        return api.contractDiff({
          baseId: Number(p.baseId),
          query: p.query as RequestQuery | undefined,
          sampleLimit: numOrUndefined(p.sampleLimit)
        })

      /* ---- 站点资源：cookie 与站点存储 ---- */

      case 'cookie.list':
        return api.listCookies({ query: (p.query ?? {}) as CookieQuery })
      case 'cookie.stats':
        return api.getCookieStats()
      case 'cookie.set':
        return api.setCookie((p.cookie ?? {}) as CookieInput)
      case 'cookie.delete':
        return api.deleteCookies((p.filter ?? {}) as CookieDeleteFilter)
      case 'site.origins':
        return api.getSiteOrigins({
          limit: numOrUndefined(p.limit),
          onlyScanned: p.onlyScanned === true
        })
      case 'site.detail':
        return api.getSiteDetail(String(p.origin ?? ''))
      case 'site.scan':
        return api.scanSiteData({
          origin: p.origin === undefined ? undefined : String(p.origin),
          limit: numOrUndefined(p.limit),
          cookies: p.cookies !== false
        })
      case 'site.clear':
        return api.clearSiteData(String(p.origin ?? ''), Array.isArray(p.types) ? (p.types as SiteDataType[]) : [])
      case 'site.storage':
        return api.editStorage(p.input as Parameters<Controller['editStorage']>[0])
      case 'site.idbDelete':
        return api.deleteIdbDatabase(String(p.origin ?? ''), String(p.name ?? ''))
      case 'site.cacheDelete':
        return api.deleteCache(String(p.origin ?? ''), String(p.name ?? ''), p.url === undefined ? undefined : String(p.url))
      case 'site.swUnregister':
        return api.unregisterServiceWorker(String(p.scopeURL ?? ''))
      case 'site.snapshot':
        return api.siteSnapshot({ label: p.label === undefined ? undefined : String(p.label) })
      case 'site.snapshots':
        return api.listSiteSnapshots(numOrUndefined(p.limit))
      case 'site.snapshotDiff':
        return api.siteSnapshotDiff(Number(p.baseId))
      case 'site.snapshotDelete':
        return api.deleteSiteSnapshot(Number(p.id))

      /* ---- 对话框 ---- */

      case 'dialog.handle':
        return api.handleDialog(p.accept !== false, p.promptText === undefined ? undefined : String(p.promptText))
      default:
        throw new Error(`未知的控制方法：${method}`)
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    const child = this.child
    this.child = null
    if (!child) return
    try {
      child.stdin?.end()
    } catch {
      /* 已经断了 */
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* 已经退了 */
        }
        resolve()
      }, 1500)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}
