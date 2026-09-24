import { randomUUID, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { ContentStore } from '../content/store'
import type { ReplayRun, ReplayTemplate } from '../../shared/contracts/replay'

interface ReplayState { schemaVersion: 1; templates: ReplayTemplate[]; runs: ReplayRun[] }
export interface RawRequest { seq?: number; method: string; url: string; headers?: Record<string, string | string[]>; body?: string | null; status?: number | null }

export class ReplayService {
  private readonly path: string
  constructor(private readonly root: string, private readonly content: ContentStore) { this.path = join(root, 'replay.json') }

  list(): { templates: ReplayTemplate[]; runs: ReplayRun[] } { const state = this.read(); return { templates: state.templates, runs: state.runs.slice(-200).reverse() } }

  createFromRequest(request: RawRequest, name?: string): ReplayTemplate {
    const headers = Object.entries(request.headers ?? {}).flatMap(([header, value]) =>
      isManagedHeader(header) ? [] : (Array.isArray(value) ? value : [value]).map((item) => ({ name: header, value: String(item) })))
    return this.save({ name: name?.trim() || `${request.method} ${new URL(request.url).pathname}`, sourceSeq: request.seq, method: request.method, url: request.url, headers,
      ...(request.body != null ? { body: { kind: 'text' as const, value: request.body } } : {}), cookiePolicy: 'browser' })
  }

  save(input: Omit<ReplayTemplate, 'id' | 'version' | 'createdAt' | 'updatedAt'> & { id?: string; version?: number }): ReplayTemplate {
    validate(input)
    const state = this.read(); const now = Date.now()
    const previous = input.id ? state.templates.filter((item) => item.id === input.id).sort((a, b) => b.version - a.version)[0] : undefined
    const template: ReplayTemplate = { ...input, id: input.id ?? `rt_${randomUUID()}`, version: (previous?.version ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now }
    state.templates.push(template); this.write(state); return template
  }

  get(id: string, version?: number): ReplayTemplate {
    const rows = this.read().templates.filter((item) => item.id === id && (version === undefined || item.version === version)).sort((a, b) => b.version - a.version)
    if (!rows[0]) throw new Error(`找不到请求模板：${id}${version ? ` v${version}` : ''}`)
    return rows[0]
  }

  async runIndependent(template: ReplayTemplate, timeoutMs: number, signal?: AbortSignal, sourceStatus?: number | null): Promise<ReplayRun> {
    const startedAt = Date.now(); const id = `rr_${randomUUID()}`
    const requestBody = bodyBytes(template)
    try {
      const response = await requestOnce(template, requestBody, timeoutMs, signal)
      const ref = await this.content.put(response.body)
      const run: ReplayRun = { id, templateId: template.id, templateVersion: template.version, mode: 'independent', startedAt, finishedAt: Date.now(), state: 'succeeded',
        request: { method: template.method, url: template.url, headers: template.headers, ...(requestBody.length ? { bodyHash: hash(requestBody) } : {}) },
        response: { status: response.status, url: response.url, headers: response.headers, bodyHash: ref.hash, size: response.body.length, durationMs: Date.now() - startedAt },
        diff: { ...(sourceStatus !== undefined && sourceStatus !== null && sourceStatus !== response.status ? { statusChanged: [sourceStatus, response.status] as [number, number] } : {}) } }
      this.record(run); return run
    } catch (error) {
      const canceled = signal?.aborted === true
      const run: ReplayRun = { id, templateId: template.id, templateVersion: template.version, mode: 'independent', startedAt, finishedAt: Date.now(), state: canceled ? 'canceled' : 'failed', request: { method: template.method, url: template.url, headers: template.headers }, error: error instanceof Error ? error.message : String(error) }
      this.record(run); return run
    }
  }

  record(run: ReplayRun): void { const state = this.read(); state.runs.push(run); state.runs = state.runs.slice(-2000); this.write(state) }

  private read(): ReplayState { if (!existsSync(this.path)) return { schemaVersion: 1, templates: [], runs: [] }; const value = JSON.parse(readFileSync(this.path, 'utf8')) as ReplayState; if (value.schemaVersion !== 1) throw new Error('重放仓库版本不兼容'); return value }
  private write(value: ReplayState): void { mkdirSync(dirname(this.path), { recursive: true }); const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`; writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n'); renameSync(temporary, this.path) }
}

function validate(input: { method: string; url: string; headers: Array<{ name: string; value: string }>; body?: { kind: string; value: string }; cookiePolicy: string }): void {
  const url = new URL(input.url); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('模板 URL 只允许 HTTP(S)')
  if (!/^[A-Z]+$/.test(input.method.toUpperCase())) throw new Error('HTTP 方法无效')
  if (!Array.isArray(input.headers) || input.headers.some((item) => !item.name || /[\r\n]/.test(item.name + item.value))) throw new Error('请求头无效')
  if (input.headers.some((item) => /^(host|content-length|proxy-authorization)$/i.test(item.name))) throw new Error('Host/Content-Length/Proxy-Authorization 由执行器管理')
  if (!['browser', 'omit', 'explicit'].includes(input.cookiePolicy)) throw new Error('Cookie 策略无效')
}
function bodyBytes(template: ReplayTemplate): Buffer { if (!template.body) return Buffer.alloc(0); return template.body.kind === 'base64' ? Buffer.from(template.body.value, 'base64') : Buffer.from(template.body.value) }
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

async function requestOnce(template: ReplayTemplate, body: Buffer, timeoutMs: number, signal?: AbortSignal, redirects = 0): Promise<{ status: number; url: string; headers: Array<{ name: string; value: string }>; body: Buffer }> {
  if (redirects > 10) throw new Error('重定向超过 10 次')
  const url = new URL(template.url); const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | string[]> = {}
    for (const item of template.headers) {
      if (template.cookiePolicy === 'omit' && item.name.toLowerCase() === 'cookie') continue
      const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === item.name.toLowerCase()) ?? item.name
      const current = headers[key]
      headers[key] = current === undefined ? item.value : Array.isArray(current) ? [...current, item.value] : [current, item.value]
    }
    if (body.length) headers['Content-Length'] = String(body.length)
    const req = requestFn(url, { method: template.method, headers, signal }, (res) => {
      const chunks: Buffer[] = []; let size = 0
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 64 * 1024 * 1024) req.destroy(new Error('响应超过 64 MiB 重放上限')); else chunks.push(chunk) })
      res.on('error', reject)
      res.on('end', async () => {
        const status = res.statusCode ?? 0; const location = res.headers.location
        if (location && [301, 302, 303, 307, 308].includes(status)) {
          try { resolve(await requestOnce({ ...template, url: new URL(location, url).toString(), ...(status === 303 ? { method: 'GET', body: undefined } : {}) }, status === 303 ? Buffer.alloc(0) : body, timeoutMs, signal, redirects + 1)) } catch (error) { reject(error) }
          return
        }
        resolve({ status, url: url.toString(), headers: Object.entries(res.headers).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).filter(Boolean).map((item) => ({ name, value: String(item) }))), body: Buffer.concat(chunks) })
      })
    })
    req.setTimeout(Math.max(100, Math.min(120_000, timeoutMs)), () => req.destroy(new Error('重放超时')))
    req.on('error', reject); if (body.length) req.write(body); req.end()
  })
}

function isManagedHeader(name: string): boolean {
  return /^(host|content-length|proxy-authorization|connection|accept-encoding|origin|referer|user-agent|sec-|cookie$)/i.test(name)
}
