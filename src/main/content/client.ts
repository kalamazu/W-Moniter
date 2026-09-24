import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import { createReadStream, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { locateNode } from '../storage/locate-node'
import { resolveRuntimeFile } from '../paths'
import type { ContentRef } from './store'

export interface ContentEndpoint { host: string; port: number; token: string }

export class ContentClient {
  private child: ChildProcess | null = null
  private endpoint: ContentEndpoint | null = null
  constructor(private readonly root: string) {}

  get connection(): ContentEndpoint | null { return this.endpoint }

  async start(): Promise<ContentEndpoint> {
    if (this.endpoint) return this.endpoint
    const node = await locateNode()
    if (!node.candidate) throw new Error('内容服务需要 Node >= 22')
    const override = process.env['MONITOR_CONTENT_SERVER']
    const server = override ? (existsSync(override) ? override : null) : resolveRuntimeFile('content', 'server.mjs')
    if (!server) throw new Error('找不到 content/server.mjs')
    const child = spawn(node.candidate.path, ['--no-warnings', server, this.root], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    })
    this.child = child
    try {
      const endpoint = await new Promise<ContentEndpoint>((resolve, reject) => {
        let carry = ''
        const timer = setTimeout(() => reject(new Error('内容服务启动超时')), 10000)
        const cleanup = (): void => { clearTimeout(timer); child.stdout?.off('data', onData); child.off('exit', onExit) }
        const onExit = (): void => { cleanup(); reject(new Error('内容服务提前退出')) }
        const onData = (part: Buffer): void => {
          carry += part.toString('utf8')
          const line = carry.indexOf('\n')
          if (line < 0) return
          try {
            const value = JSON.parse(carry.slice(0, line)) as ContentEndpoint
            if (value.host !== '127.0.0.1' || !Number.isInteger(value.port) || !/^[a-f0-9]{64}$/.test(value.token)) throw new Error('内容服务握手无效')
            cleanup(); resolve(value)
          } catch (error) { cleanup(); reject(error) }
        }
        child.stdout?.on('data', onData)
        child.once('exit', onExit)
      })
      this.endpoint = endpoint
      child.once('exit', () => { this.child = null; this.endpoint = null })
      return endpoint
    } catch (error) { child.kill(); this.child = null; throw error }
  }

  async put(bytes: Uint8Array): Promise<ContentRef> {
    if (process.env['MONITOR_TEST_CONTENT_PUT_FAIL'] === '1') throw new Error('受控内容落盘失败')
    const endpoint = this.endpoint
    if (!endpoint) throw new Error('内容服务未启动')
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: endpoint.host, port: endpoint.port, method: 'PUT', path: '/object',
        headers: { authorization: `Bearer ${endpoint.token}`, 'x-expected-bytes': String(bytes.byteLength) } }, res => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ContentRef & { error?: string }
            if (res.statusCode !== 200 || !payload.hash) throw new Error(payload.error ?? `content service HTTP ${res.statusCode}`)
            resolve(payload)
          } catch (error) { reject(error) }
        })
      })
      req.on('error', reject)
      req.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    })
  }

  /** Stream an already-downloaded artifact without copying it through Electron memory. */
  async putFile(path: string): Promise<ContentRef> {
    const endpoint = this.endpoint
    if (!endpoint) throw new Error('内容服务未启动')
    const info = await stat(path)
    if (!info.isFile()) throw new Error('下载产物不是普通文件')
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: endpoint.host, port: endpoint.port, method: 'PUT', path: '/object',
        headers: { authorization: `Bearer ${endpoint.token}`, 'x-expected-bytes': String(info.size) } }, res => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ContentRef & { error?: string }
            if (res.statusCode !== 200 || !payload.hash) throw new Error(payload.error ?? `content service HTTP ${res.statusCode}`)
            resolve(payload)
          } catch (error) { reject(error) }
        })
      })
      req.on('error', reject)
      const input = createReadStream(path)
      input.on('error', reject)
      input.pipe(req)
    })
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    child.stdin?.end()
    await Promise.race([
      new Promise<void>(resolve => child.once('exit', () => resolve())),
      new Promise<void>(resolve => setTimeout(() => { child.kill(); resolve() }, 3000))
    ])
    this.child = null
    this.endpoint = null
  }
}
