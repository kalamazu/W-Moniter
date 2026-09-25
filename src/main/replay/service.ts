import { randomUUID, createHash } from 'node:crypto'
import { join } from 'node:path'
import { ContentStore } from '../content/store'
import type { ReplayRun, ReplayTemplate } from '../../shared/contracts/replay'
import { VersionedJsonRepository } from '../repositories/versioned-json'
import type { WorkerReplayOutput } from '../workers/client'

interface ReplayState { schemaVersion: 1; templates: ReplayTemplate[]; runs: ReplayRun[] }
export interface RawRequest { seq?: number; method: string; url: string; headers?: Record<string, string | string[]>; body?: string | null; status?: number | null }
export type IndependentReplayExecutor = (input: { method: string; url: string; headers: Array<{ name: string; value: string }>; cookiePolicy: ReplayTemplate['cookiePolicy']; bodyBase64: string; timeoutMs: number }, signal?: AbortSignal) => Promise<WorkerReplayOutput>

export class ReplayService {
  private readonly repository: VersionedJsonRepository<ReplayState>
  constructor(private readonly root: string, private readonly content: ContentStore, private readonly executeIndependent: IndependentReplayExecutor) { this.repository = new VersionedJsonRepository<ReplayState>(join(root, 'replay.json'), () => ({ schemaVersion: 1, templates: [], runs: [] }), validateState) }

  list(): { templates: ReplayTemplate[]; runs: ReplayRun[] } { const state = this.read(); return { templates: state.templates, runs: state.runs.slice(-200).reverse() } }

  import(format: 'curl' | 'har', source: string): ReplayTemplate[] {
    if (Buffer.byteLength(source) > 8 * 1024 * 1024) throw new Error('导入内容超过 8 MiB 上限')
    const candidates = format === 'curl' ? [parseCurl(source)] : parseHar(source)
    if (candidates.length > 1000) throw new Error('HAR 最多导入 1000 条请求')
    return candidates.map((candidate) => this.save(candidate))
  }

  createFromRequest(request: RawRequest, name?: string): ReplayTemplate {
    const headers = Object.entries(request.headers ?? {}).flatMap(([header, value]) =>
      isManagedHeader(header) ? [] : (Array.isArray(value) ? value : [value]).map((item) => ({ name: header, value: String(item) })))
    return this.save({ name: name?.trim() || `${request.method} ${new URL(request.url).pathname}`, sourceSeq: request.seq, method: request.method, url: request.url, headers,
      ...(request.body != null ? { body: { kind: 'text' as const, value: request.body } } : {}), cookiePolicy: 'browser' })
  }

  save(input: Omit<ReplayTemplate, 'id' | 'version' | 'createdAt' | 'updatedAt'> & { id?: string; version?: number }): ReplayTemplate {
    validate(input)
    let template!: ReplayTemplate
    this.repository.update((state) => {
      const now = Date.now()
      const previous = input.id ? state.templates.filter((item) => item.id === input.id).sort((a, b) => b.version - a.version)[0] : undefined
      template = { ...input, id: input.id ?? `rt_${randomUUID()}`, version: (previous?.version ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now }
      state.templates.push(template)
      return state
    })
    return template
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
      const response = await this.executeIndependent({ method: template.method, url: template.url, headers: template.headers, cookiePolicy: template.cookiePolicy, bodyBase64: requestBody.toString('base64'), timeoutMs }, signal)
      const responseBody = Buffer.from(response.bodyBase64, 'base64')
      const ref = await this.content.put(responseBody)
      const run: ReplayRun = { id, templateId: template.id, templateVersion: template.version, mode: 'independent', startedAt, finishedAt: Date.now(), state: 'succeeded',
        request: { method: template.method, url: template.url, headers: template.headers, ...(requestBody.length ? { bodyHash: hash(requestBody) } : {}) },
        response: { status: response.status, url: response.url, headers: response.headers, bodyHash: ref.hash, size: responseBody.length, durationMs: Date.now() - startedAt },
        diff: { ...(sourceStatus !== undefined && sourceStatus !== null && sourceStatus !== response.status ? { statusChanged: [sourceStatus, response.status] as [number, number] } : {}) } }
      this.record(run); return run
    } catch (error) {
      const canceled = signal?.aborted === true
      const run: ReplayRun = { id, templateId: template.id, templateVersion: template.version, mode: 'independent', startedAt, finishedAt: Date.now(), state: canceled ? 'canceled' : 'failed', request: { method: template.method, url: template.url, headers: template.headers }, error: error instanceof Error ? error.message : String(error) }
      this.record(run); return run
    }
  }

  record(run: ReplayRun): void { this.repository.update((state) => { state.runs.push(run); state.runs = state.runs.slice(-2000); return state }) }

  private read(): ReplayState { return this.repository.read().value }
}
function validateState(value: ReplayState): void { if (value.schemaVersion !== 1 || !Array.isArray(value.templates) || !Array.isArray(value.runs)) throw new Error('重放仓库版本不兼容') }

function validate(input: { method: string; url: string; headers: Array<{ name: string; value: string }>; body?: { kind: string; value: string }; cookiePolicy: string }): void {
  const url = new URL(input.url); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('模板 URL 只允许 HTTP(S)')
  if (!/^[A-Z]+$/.test(input.method.toUpperCase())) throw new Error('HTTP 方法无效')
  if (!Array.isArray(input.headers) || input.headers.some((item) => !item.name || /[\r\n]/.test(item.name + item.value))) throw new Error('请求头无效')
  if (input.headers.some((item) => /^(host|content-length|proxy-authorization)$/i.test(item.name))) throw new Error('Host/Content-Length/Proxy-Authorization 由执行器管理')
  if (!['browser', 'omit', 'explicit'].includes(input.cookiePolicy)) throw new Error('Cookie 策略无效')
}

type ReplayDraft = Omit<ReplayTemplate, 'id' | 'version' | 'createdAt' | 'updatedAt'>

function parseCurl(source: string): ReplayDraft {
  const tokens = shellLikeTokens(source.trim())
  if (tokens.shift()?.toLowerCase() !== 'curl') throw new Error('cURL 导入必须以 curl 开头')
  let method = 'GET'; let url = ''; let body: ReplayTemplate['body']; const headers: Array<{ name: string; value: string }> = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    const value = (): string => { const next = tokens[++index]; if (next === undefined) throw new Error(`cURL 参数 ${token} 缺少值`); return next }
    if (token === '-X' || token === '--request') method = value().toUpperCase()
    else if (token === '-H' || token === '--header') { const line = value(); const split = line.indexOf(':'); if (split <= 0) throw new Error(`无效请求头：${line}`); const name = line.slice(0, split).trim(); if (!isManagedHeader(name)) headers.push({ name, value: line.slice(split + 1).trim() }) }
    else if (['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode'].includes(token)) { const valueText = value(); if (valueText.startsWith('@')) throw new Error('安全导入不读取 @file，请使用受管内容引用'); body = { kind: 'text', value: valueText }; if (method === 'GET') method = 'POST' }
    else if (token === '-b' || token === '--cookie') headers.push({ name: 'Cookie', value: value() })
    else if (token === '--url') url = value()
    else if (token.startsWith('-')) { if (!['--compressed', '-L', '--location', '-k', '--insecure', '-s', '--silent'].includes(token)) throw new Error(`暂不接受 cURL 参数：${token}`) }
    else if (!url) url = token
    else throw new Error(`无法解释 cURL 片段：${token}`)
  }
  if (!url) throw new Error('cURL 缺少 URL')
  return { name: `cURL ${new URL(url).pathname}`, method, url, headers, ...(body ? { body } : {}), cookiePolicy: headers.some((item) => item.name.toLowerCase() === 'cookie') ? 'explicit' : 'omit' }
}

function shellLikeTokens(source: string): string[] {
  const out: string[] = []; let current = ''; let quote = ''; let escaped = false
  for (const character of source) {
    if (escaped) { current += character; escaped = false; continue }
    if (character === '\\' && quote !== "'") { escaped = true; continue }
    if (quote) { if (character === quote) quote = ''; else current += character; continue }
    if (character === '"' || character === "'") { quote = character; continue }
    if (/\s/.test(character)) { if (current) { out.push(current); current = '' } } else current += character
  }
  if (escaped || quote) throw new Error('cURL 引号或转义未闭合')
  if (current) out.push(current)
  return out
}

function parseHar(source: string): ReplayDraft[] {
  const value = JSON.parse(source) as { log?: { entries?: Array<{ request?: { method?: string; url?: string; headers?: Array<{ name?: string; value?: string }>; postData?: { text?: string; encoding?: string; mimeType?: string } } }> } }
  const entries = value.log?.entries
  if (!Array.isArray(entries)) throw new Error('HAR 缺少 log.entries')
  return entries.map((entry, index) => {
    const request = entry.request; if (!request?.method || !request.url) throw new Error(`HAR entry ${index + 1} 缺少 method/url`)
    const headers = (request.headers ?? []).flatMap((item) => item.name && item.value !== undefined && !isManagedHeader(item.name) ? [{ name: item.name, value: item.value }] : [])
    const text = request.postData?.text; const body = text === undefined ? undefined : { kind: request.postData?.encoding === 'base64' ? 'base64' as const : 'text' as const, value: text, ...(request.postData?.mimeType ? { contentType: request.postData.mimeType } : {}) }
    return { name: `HAR ${new URL(request.url).pathname}`, method: request.method.toUpperCase(), url: request.url, headers, ...(body ? { body } : {}), cookiePolicy: 'omit' as const }
  })
}

function bodyBytes(template: ReplayTemplate): Buffer { if (!template.body) return Buffer.alloc(0); return template.body.kind === 'base64' ? Buffer.from(template.body.value, 'base64') : Buffer.from(template.body.value) }
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

function isManagedHeader(name: string): boolean {
  return /^(host|content-length|proxy-authorization|connection|accept-encoding|origin|referer|user-agent|sec-|cookie$)/i.test(name)
}
