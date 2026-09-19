import { EventEmitter } from 'node:events'
import type { CdpMessage, PipeTransport } from './pipe-transport'

const CALL_TIMEOUT_MS = 30_000

interface PendingCall {
  method: string
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: NodeJS.Timeout
}

export interface CdpEvent {
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

/**
 * 极简 CDP 客户端：命令/响应配对 + 事件分发 + sessionId 路由。
 * 走 pipe 传输，全程不经过网络端口。
 */
export class CdpClient extends EventEmitter {
  private nextId = 1
  private readonly pending = new Map<number, PendingCall>()

  constructor(private readonly transport: PipeTransport) {
    super()
    transport.on('message', (msg: CdpMessage) => this.dispatch(msg))
    transport.on('error', (err: Error) => this.emit('error', err))
    transport.on('close', () => {
      this.rejectAll(new Error('CDP 连接已关闭'))
      this.emit('close')
    })
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string
  ): Promise<unknown> {
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 调用超时: ${method}`))
      }, CALL_TIMEOUT_MS)

      this.pending.set(id, { method, resolve, reject, timer })
      this.transport.send({ id, method, params, ...(sessionId ? { sessionId } : {}) })
    })
  }

  private dispatch(msg: CdpMessage): void {
    if (msg.id !== undefined) {
      const call = this.pending.get(msg.id)
      if (!call) return
      this.pending.delete(msg.id)
      clearTimeout(call.timer)
      if (msg.error) {
        call.reject(new Error(`${call.method} 失败: ${msg.error.message}`))
      } else {
        call.resolve(msg.result)
      }
      return
    }

    if (msg.method) {
      this.emit('event', {
        method: msg.method,
        params: (msg.params ?? {}) as Record<string, unknown>,
        ...(msg.sessionId ? { sessionId: msg.sessionId } : {})
      } satisfies CdpEvent)
    }
  }

  private rejectAll(err: Error): void {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer)
      call.reject(err)
    }
    this.pending.clear()
  }
}