import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'

export interface WorkerReplayInput {
  method: string
  url: string
  headers: Array<{ name: string; value: string }>
  cookiePolicy: 'browser' | 'omit' | 'explicit'
  bodyBase64: string
  timeoutMs: number
}

export interface WorkerReplayOutput {
  status: number
  url: string
  headers: Array<{ name: string; value: string }>
  bodyBase64: string
  workerPid: number
}

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout; detach?: () => void }

/** JSONL RPC client. Worker crashes reject only its in-flight jobs; the next call starts a clean process. */
export class ExecutionWorkerClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private readonly pending = new Map<string, Pending>()
  private readonly expectedExits = new WeakSet<ChildProcessWithoutNullStreams>()
  private starts = 0
  private crashes = 0

  constructor(private readonly nodePath: string, private readonly entryPath: string) {}

  health(): Promise<{ pid: number }> { return this.call('health', {}, 5_000) }
  replay(input: WorkerReplayInput, signal?: AbortSignal): Promise<WorkerReplayOutput> { return this.call('runner.request', input, input.timeoutMs + 5_000, signal) }
  async extract(bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
    const result = await this.call<{ text: string }>('index.extract', { bodyBase64: Buffer.from(bytes).toString('base64') }, 30_000, signal)
    return result.text
  }
  diagnostics(): { pid: number | null; starts: number; crashes: number; pending: number } { return { pid: this.child?.pid ?? null, starts: this.starts, crashes: this.crashes, pending: this.pending.size } }
  stop(): void { if (this.child) { this.expectedExits.add(this.child); this.child.kill(); this.child = null } }

  private call<T>(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new Error('任务已取消'))
    const child = this.ensureChild()
    const id = randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); child.stdin.write(`${JSON.stringify({ cancel: id })}\n`); reject(new Error(`Worker 调用超时：${method}`)) }, timeoutMs)
      const abort = (): void => { child.stdin.write(`${JSON.stringify({ cancel: id })}\n`); const item = this.pending.get(id); if (item) { clearTimeout(item.timer); this.pending.delete(id); reject(new Error('任务已取消')) } }
      signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(id, { resolve, reject, timer, ...(signal ? { detach: () => signal.removeEventListener('abort', abort) } : {}) })
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child
    const child = spawn(this.nodePath, [this.entryPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    this.starts += 1
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => this.onLine(line))
    child.stderr.on('data', (chunk) => console.error(`[worker] ${String(chunk).trim()}`))
    child.stdin.on('error', () => { /* exit handler rejects every in-flight call */ })
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = null
      if (!this.expectedExits.has(child)) this.crashes += 1
      const error = new Error(`执行 Worker 已退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`)
      for (const [id, item] of this.pending) { clearTimeout(item.timer); item.detach?.(); item.reject(error); this.pending.delete(id) }
    })
    return child
  }

  private onLine(line: string): void {
    try {
      const response = JSON.parse(line) as { id?: string; ok?: boolean; result?: unknown; error?: string }
      if (!response.id) return
      const item = this.pending.get(response.id)
      if (!item) return
      clearTimeout(item.timer); item.detach?.(); this.pending.delete(response.id)
      if (response.ok) item.resolve(response.result)
      else item.reject(new Error(response.error ?? 'Worker 调用失败'))
    } catch (error) { console.error(`[worker] 无效响应：${error instanceof Error ? error.message : String(error)}`) }
  }
}
