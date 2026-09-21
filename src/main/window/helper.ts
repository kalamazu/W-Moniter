import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

/**
 * `win/dock-helper.ps1` 的客户端。
 *
 * 为什么要常驻进程：吸附要跟着控制窗口的 move/resize 连续改位置。每次现起一个
 * powershell.exe 要 200~300ms，窗口会跟不动；这里进程只起一次，之后一条命令
 * 就是一次 stdin/stdout 往返（实测 1.6ms）。
 *
 * 为什么用 PowerShell 而不是原生模块：项目刻意只依赖 electron + react，
 * 加个需要按 Electron ABI 重编的 FFI 会把打包链路复杂化。代价是多一个
 * 隐藏的 powershell.exe 子进程 —— 它属于控制进程一侧，不碰被监控页面。
 *
 * 协议：`<id> <verb> [args]` → `<id> ok [payload]` / `<id> err <message>`
 */
export class Win32Helper {
  private child: ChildProcess | null = null
  private slots = new Map<
    string,
    { resolve: (value: string[]) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  private nextId = 1
  private stderrTail = ''

  constructor(private readonly scriptPath: string | null) {}

  get available(): boolean {
    return process.platform === 'win32' && !!this.scriptPath && existsSync(this.scriptPath)
  }

  private powershellPath(): string {
    const root = process.env['SystemRoot'] ?? 'C:\\Windows'
    const full = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    return existsSync(full) ? full : 'powershell.exe'
  }

  /** 提前把进程拉起来。Add-Type 要编译一次（实测冷启动 ~3s），别让第一次吸附卡在这儿 */
  warm(): void {
    this.ensure()
  }

  private ensure(): ChildProcess | null {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child
    if (!this.available) return null

    const child = spawn(
      this.powershellPath(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        this.scriptPath as string
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    )
    this.child = child
    this.stderrTail = ''

    const reader = createInterface({ input: child.stdout! })
    reader.on('line', (line) => this.onLine(line))
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-600)
    })

    const fail = (why: string): void => {
      if (this.child !== child) return
      this.child = null
      const slots = [...this.slots.entries()]
      this.slots.clear()
      for (const [, slot] of slots) {
        clearTimeout(slot.timer)
        slot.reject(new Error(why))
      }
    }
    child.on('exit', () => fail('吸附助手退出了'))
    child.on('error', (error) => fail(`吸附助手起不来：${error.message}`))
    return child
  }

  private onLine(line: string): void {
    const text = line.trim()
    if (!text) return
    const parts = text.split(' ')
    const slot = this.slots.get(parts[0])
    if (!slot) return
    this.slots.delete(parts[0])
    clearTimeout(slot.timer)
    if (parts[1] === 'ok') slot.resolve(parts.slice(2))
    else slot.reject(new Error(parts.slice(2).join(' ') || '未知错误'))
  }

  call(command: string, timeoutMs = 20000): Promise<string[]> {
    const child = this.ensure()
    if (!child || !child.stdin) return Promise.reject(new Error('吸附助手不可用'))

    const id = String(this.nextId++)
    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.slots.delete(id)
        reject(new Error(`吸附助手超时：${command} ${this.stderrTail.slice(0, 200)}`))
      }, timeoutMs)
      this.slots.set(id, { resolve, reject, timer })
      child.stdin!.write(`${id} ${command}\n`)
    })
  }

  /** 按进程 id 找窗口句柄；找不到返回 null（不是错误） */
  async findWindow(profileDir: string): Promise<number | null> {
    const base64 = Buffer.from(profileDir, 'utf8').toString('base64')
    const [hwnd] = await this.call(`find ${base64}`, 60000)
    const value = Number(hwnd)
    return Number.isFinite(value) && value > 0 ? value : null
  }

  /** 窗口矩形（物理像素）。窗口没了会抛 gone —— 调用方据此重新找 */
  async rect(hwnd: number): Promise<{ x: number; y: number; width: number; height: number }> {
    const [payload] = await this.call(`rect ${hwnd}`)
    const [left, top, right, bottom] = (payload ?? '').split(',').map(Number)
    return { x: left, y: top, width: right - left, height: bottom - top }
  }

  async move(hwnd: number, rect: { x: number; y: number; width: number; height: number }): Promise<void> {
    const x = Math.round(rect.x)
    const y = Math.round(rect.y)
    const w = Math.max(1, Math.round(rect.width))
    const h = Math.max(1, Math.round(rect.height))
    await this.call(`move ${hwnd} ${x} ${y} ${w} ${h}`)
  }

  async iconic(hwnd: number): Promise<boolean> {
    const [value] = await this.call(`iconic ${hwnd}`)
    return value === '1'
  }

  async minimize(hwnd: number): Promise<void> {
    await this.call(`min ${hwnd}`)
  }

  async restore(hwnd: number): Promise<void> {
    await this.call(`unmin ${hwnd}`)
  }

  dispose(): void {
    const child = this.child
    this.child = null
    for (const [, slot] of this.slots) {
      clearTimeout(slot.timer)
      slot.reject(new Error('吸附助手已关闭'))
    }
    this.slots.clear()
    if (!child) return
    try {
      child.stdin?.write('0 quit\n')
    } catch {
      /* 已经断了 */
    }
    setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退了 */
      }
    }, 500).unref?.()
  }
}