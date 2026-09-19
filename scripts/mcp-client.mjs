#!/usr/bin/env node
/**
 * MCP stdio 客户端（验收用）。
 *
 * 真 agent 接的就是这套协议，所以这里只实现 JSON-RPC 的收发 + 一层薄薄的 tools/call 糖，
 * 不做任何「知道本项目内部结构」的事 —— 验收脚本一旦开始 import 主进程的模块，
 * 验的就不是「agent 能不能用」了。
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export class McpClient {
  constructor(child, options = {}) {
    this.child = child
    this.timeoutMs = options.timeoutMs ?? 180000
    this.nextId = 1
    this.pending = new Map()
    this.serverInfo = null
    this.stderr = ''
    child.stderr?.on('data', (chunk) => {
      this.stderr += String(chunk)
    })
    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      const text = line.trim()
      if (!text) return
      let msg
      try {
        msg = JSON.parse(text)
      } catch {
        return
      }
      if (msg.id === undefined) return
      const slot = this.pending.get(msg.id)
      if (!slot) return
      this.pending.delete(msg.id)
      clearTimeout(slot.timer)
      if (msg.error) slot.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
      else slot.resolve(msg.result)
    })
  }

  static spawn(command, args, options) {
    return new McpClient(spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] }))
  }

  send(method, params) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP 超时（${this.timeoutMs}ms）：${method}`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  /** 握手。返回 serverInfo，方便断言「连上的确实是这个 server」 */
  async initialize(clientName = 'acceptance') {
    const init = await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: clientName, version: '1' }
    })
    this.notify('notifications/initialized', {})
    this.serverInfo = init?.serverInfo ?? null
    return init
  }

  /** 原始 tools/call（要断言 isError 时用这个） */
  call(name, args) {
    return this.send('tools/call', { name, arguments: args ?? {} })
  }

  /** tools/call 的常见形态：取第一个文本块并按 JSON 解析，isError 直接抛 */
  async callJson(name, args) {
    const res = await this.call(name, args)
    const text = (res?.content ?? []).find((block) => block.type === 'text')?.text
    if (res?.isError) throw new Error(`${name} 失败：${text ?? '（没有说明）'}`)
    if (text === undefined) return null
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  close() {
    try {
      this.child.kill()
    } catch {
      /* 已经退了 */
    }
  }
}