import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import type { InputAction, Profile, RequestQuery, RequestOrder, RuleSet, ScreenshotOptions, ScriptQuery, ScriptOrder } from '../../shared/types'
import type { Controller } from '../controller'

/**
 * 控制桥：把主进程里的 Controller 暴露给「控制服务」子进程（control/server.mjs）。
 *
 * 方向：
 *   控制进程 → 主进程：stdout 上的 { id, method, params }（我们要应答）
 *   主进程 → 控制进程：stdin 上的 { id, method, params }（我们发问候/收工）
 *
 * 与存储、代理保持同一个模式：主进程只编排，网络面在子进程里。
 */
export class ControlBridge {
  private child: ChildProcess | null = null
  private api: Controller | null = null
  private dataDir: string
  private root: string
  private port: number
  private nodePath: string
  private stopping = false
  /** 控制服务实际监听的端口（端口传 0 时由系统分配，ready 事件里回传） */
  readyPort: number | null = null
  onLog: (line: string) => void = () => {}

  constructor(options: { root: string; dataDir: string; port: number; nodePath: string }) {
    this.root = options.root
    this.dataDir = options.dataDir
    this.port = options.port
    this.nodePath = options.nodePath
  }

  attach(api: Controller): void {
    this.api = api
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
        return api.getStatus()
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