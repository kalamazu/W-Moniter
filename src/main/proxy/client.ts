import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { locateNode } from '../storage/locate-node'
import type { ProxyFlow } from '../../../proxy/correlate.mjs'

/**
 * 本地代理的客户端（P5）。
 *
 * 形状和 StorageClient 一样：独立 node 子进程 + stdin/stdout 上的 NDJSON。
 *   请求  {id, op, args}
 *   应答  {id, ok, result} / {id, ok, error}
 *   事件  {ev:'flow'|'log', data}
 *
 * 为什么不塞进主进程：见 proxy/server.mjs 头部的三条理由（§5.2 不许在回调里做同步 IO、
 * §6.3 大 body 改写要下沉、以及能脱离 Electron 单独测）。
 */

export interface ProxyConfig {
  /** 0 = 让内核挑；实际端口从 start() 的返回值里拿 */
  port?: number
  /** CA 私钥落盘位置；复用同一把密钥，pin 的 SPKI 才跨重启不变 */
  keyFile: string
  bodyMaxBytes?: number
  rewriteMaxBytes?: number
  /**
   * 大 body 改写的分界（§6.3 第 2 条）：声明长度 > 这个值的响应才在代理层套 body 规则。
   * 必须等于 bodyMaxBytes —— CDP 那条路是按「声明长度 > bodyMaxBytes 就不取 body」
   * 判的，用同一个数才会两边正好互补、绝不重叠。
   */
  sinkAboveBytes?: number
  /** 上游 TLS 校验，默认开 */
  upstreamRejectUnauthorized?: boolean
}

export interface ProxyStartResult {
  port: number
  host: string
  spki: string
}

/**
 * 代理层的规则形状。由 src/main/proxy/rules.ts 从主进程的 RuleSet 映射而来：
 * urlPattern 已经编译成 urlRegex（glob 或 re: 的语义在主进程那边一次定死），
 * rewriteBody 动作变成 bodyScript —— 代理和主进程跑的是同一份沙箱实现。
 * replaceInBody / setResponseHeader / removeResponseHeader 是更早的简化形状，留作测试用。
 */
export interface ProxyRule {
  id: string
  name?: string
  enabled?: boolean
  /** 完整正则（含锚点）；由 urlPattern 编译而来 */
  urlRegex?: string
  urlFlags?: string
  /** 老形状：子串匹配 */
  urlPattern?: string
  methods?: string[]
  /** 响应阶段的状态码过滤 */
  statuses?: number[]
  /** rewriteBody 动作的脚本：一段函数体 (body, ctx) => 新的 body */
  bodyScript?: string
  replaceInBody?: Array<{ find: string; replace: string; all?: boolean }>
  setResponseHeader?: { name: string; value: string }
  removeResponseHeader?: string[]
}

function resolveServerPath(): string | null {
  const override = process.env['MONITOR_PROXY_SERVER']
  if (override) return existsSync(override) ? override : null
  const candidates = [
    join(__dirname, '..', '..', 'proxy', 'server.mjs'),
    join(app.getAppPath(), 'proxy', 'server.mjs'),
    join(process.resourcesPath ?? '', 'proxy', 'server.mjs')
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

export class ProxyClient extends EventEmitter {
  private child: ChildProcess | null = null
  private seq = 0
  private buf = ''
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private info: ProxyStartResult | null = null
  private flowCount = 0

  constructor(private readonly config: ProxyConfig) {
    super()
  }

  get running(): boolean {
    return this.child !== null && this.info !== null
  }

  get startInfo(): ProxyStartResult | null {
    return this.info
  }

  get flowsSeen(): number {
    return this.flowCount
  }

  async start(): Promise<ProxyStartResult> {
    const node = await locateNode()
    if (!node.candidate) {
      throw new Error('没有找到可用的 Node（>=22），代理进程起不来。可用 MONITOR_NODE_PATH 指定。')
    }
    const serverPath = resolveServerPath()
    if (!serverPath) {
      throw new Error('找不到代理进程脚本 proxy/server.mjs（可用 MONITOR_PROXY_SERVER 指定）')
    }

    const child = spawn(node.candidate.path, ['--no-warnings', serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.consume(chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      const line = chunk.trim()
      if (line) this.emit('log', line)
    })
    child.on('exit', (code, signal) => {
      this.child = null
      this.info = null
      this.emit('log', '代理进程退出 (code=' + String(code) + ', signal=' + String(signal) + ')')
    })

    const result = (await this.call('start', {
      port: this.config.port ?? 0,
      keyFile: this.config.keyFile
    })) as ProxyStartResult
    this.info = result
    await this.call('setConfig', {
      ...(this.config.bodyMaxBytes !== undefined ? { bodyMaxBytes: this.config.bodyMaxBytes } : {}),
      ...(this.config.rewriteMaxBytes !== undefined
        ? { rewriteMaxBytes: this.config.rewriteMaxBytes }
        : {}),
      ...(this.config.upstreamRejectUnauthorized !== undefined
        ? { upstreamRejectUnauthorized: this.config.upstreamRejectUnauthorized }
        : {}),
      // 分界判据必须和 CDP 那条路用同一个数，否则会出现「两边都改」或「两边都不改」
      ...(this.config.sinkAboveBytes !== undefined
        ? { sinkAboveBytes: this.config.sinkAboveBytes }
        : {})
    })
    return this.info
  }

  /** 给 Chromium 的启动开关。两个都不能少：少了 proxy-server 就不过代理，少了 pin 就是证书错。 */
  browserArgs(): string[] {
    if (!this.info) return []
    return [
      '--proxy-server=http://' + this.info.host + ':' + this.info.port,
      // Chrome 默认绕过 loopback —— 我们要观测的恰恰是 loopback 上的目标
      '--proxy-bypass-list=<-loopback>',
      // 自签证书靠 SPKI pin 放行，不碰系统信任库（装系统根是个全局可观察的改动）
      '--ignore-certificate-errors-spki-list=' + this.info.spki
    ]
  }

  setRules(rules: ProxyRule[]): Promise<unknown> {
    return this.call('setRules', { rules })
  }

  status(): Promise<unknown> {
    return this.call('status', {})
  }

  /**
   * 收工前把还开着的长连接（SSE/流式）补报回来。
   * 必须在 Correlator.flush() 之前 await —— 补报的 flow 走的是事件通道，
   * 应答是在这些事件之后写的，所以 await 返回时它们已经全部进过关联器了。
   */
  async drain(): Promise<number> {
    if (!this.child) return 0
    try {
      const result = (await this.call('drain', {}, 3000)) as { drained?: number }
      return result?.drained ?? 0
    } catch {
      // 收工路径上不该因为补报失败而卡住
      return 0
    }
  }

  async stop(): Promise<void> {
    if (!this.child) return
    try {
      await this.call('stop', {}, 2000)
    } catch {
      // 停不下来就直接杀，别卡住退出流程
    }
    try {
      this.child.kill()
    } catch {
      // 已经死了
    }
    this.child = null
    this.info = null
  }

  private call(op: string, args: unknown, timeoutMs = 10000): Promise<unknown> {
    const child = this.child
    if (!child || !child.stdin) return Promise.reject(new Error('代理进程没在跑'))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('代理进程 ' + op + ' 超时'))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        }
      })
      child.stdin?.write(JSON.stringify({ id, op, args }) + '\n')
    })
  }

  private consume(chunk: string): void {
    this.buf += chunk
    let index = this.buf.indexOf('\n')
    while (index >= 0) {
      const line = this.buf.slice(0, index).trim()
      this.buf = this.buf.slice(index + 1)
      index = this.buf.indexOf('\n')
      if (!line) continue
      let msg: {
        id?: number
        ok?: boolean
        result?: unknown
        error?: string
        ev?: string
        data?: unknown
      }
      try {
        msg = JSON.parse(line) as typeof msg
      } catch {
        this.emit('log', '代理进程吐了非法 JSON: ' + line.slice(0, 200))
        continue
      }
      if (msg.ev) {
        if (msg.ev === 'flow') {
          this.flowCount += 1
          this.emit('flow', msg.data as ProxyFlow)
        } else if (msg.ev === 'log') {
          const data = msg.data as { level?: string; msg?: string }
          this.emit('log', '[' + String(data.level) + '] ' + String(data.msg))
        }
        continue
      }
      if (typeof msg.id !== 'number') continue
      const slot = this.pending.get(msg.id)
      if (!slot) continue
      this.pending.delete(msg.id)
      if (msg.ok) slot.resolve(msg.result)
      else slot.reject(new Error(msg.error ?? '代理进程返回失败'))
    }
  }
}
