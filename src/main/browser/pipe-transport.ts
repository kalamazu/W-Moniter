import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'

/** Chromium 的 pipe 传输用 \0 分隔 JSON 消息 */
const NUL = 0x00

export interface CdpMessage {
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: string }
  sessionId?: string
}

export interface PipeTransportOptions {
  /** 父进程 → 浏览器（浏览器侧 fd 3） */
  toBrowser: Writable
  /** 浏览器 → 父进程（浏览器侧 fd 4） */
  fromBrowser: Readable
}

export class PipeTransport extends EventEmitter {
  private buffer: Buffer = Buffer.alloc(0)
  private closed = false

  constructor(private readonly options: PipeTransportOptions) {
    super()
    const { toBrowser, fromBrowser } = options

    fromBrowser.on('data', (chunk: Buffer) => this.consume(chunk))
    fromBrowser.on('error', (err: Error) => this.emit('error', err))
    fromBrowser.on('close', () => {
      this.closed = true
      this.emit('close')
    })
    toBrowser.on('error', (err: Error) => this.emit('error', err))
  }

  send(message: CdpMessage): void {
    if (this.closed) throw new Error('CDP pipe 已关闭')
    const payload = Buffer.from(JSON.stringify(message), 'utf8')
    this.options.toBrowser.write(Buffer.concat([payload, Buffer.from([NUL])]))
  }

  close(): void {
    this.closed = true
  }

  private consume(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])

    let index = this.buffer.indexOf(NUL)
    while (index !== -1) {
      const frame = this.buffer.subarray(0, index)
      this.buffer = this.buffer.subarray(index + 1)
      if (frame.length > 0) {
        try {
          this.emit('message', JSON.parse(frame.toString('utf8')) as CdpMessage)
        } catch (err) {
          this.emit('error', new Error(`CDP 消息解析失败: ${(err as Error).message}`))
        }
      }
      index = this.buffer.indexOf(NUL)
    }
  }
}
