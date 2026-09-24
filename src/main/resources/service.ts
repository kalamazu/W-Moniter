import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Page, StoredRequest } from '../../shared/types'
import type { EndpointOverride, ResourceIndexCoverage, ResourceNote, ResourceSearchHit, ResourceVersion, SiteDossier } from '../../shared/contracts/resources'
import type { ContentStore } from '../content/store'

interface SearchDocument { resourceId: string; text: string }
interface ResourceState { schemaVersion: 1; resources: ResourceVersion[]; documents: SearchDocument[]; coverage: ResourceIndexCoverage | null; notes: ResourceNote[]; overrides: EndpointOverride[] }
type PageProvider = (limit: number, offset: number) => Promise<Page<StoredRequest> | null>

export class ResourceKnowledgeService {
  private readonly path: string
  constructor(root: string, private readonly content: ContentStore) { this.path = join(root, 'knowledge.json') }

  summary(): { coverage: ResourceIndexCoverage | null; dossiers: SiteDossier[]; notes: ResourceNote[]; overrides: EndpointOverride[] } {
    const state = this.read(); return { coverage: state.coverage, dossiers: dossiers(state.resources), notes: state.notes, overrides: state.overrides }
  }

  async rebuild(provider: PageProvider, signal?: AbortSignal): Promise<ResourceIndexCoverage> {
    const byIdentity = new Map<string, ResourceVersion>(); const versionCounts = new Map<string, number>(); let scanned = 0; let truncated = 0; let offset = 0; const pageSize = 1000
    while (offset < 100_000) {
      if (signal?.aborted) break
      const page = await provider(pageSize, offset); if (!page) throw new Error('请求存储不可用')
      for (const row of page.rows) {
        scanned += 1; if (row.body_trunc) truncated += 1
        const identity = row.body_hash ?? digest(`${row.status}|${row.mime_type}|${row.decoded_len}|${row.end_ts}`)
        const key = `${row.url}\n${identity}`; let resource = byIdentity.get(key)
        if (!resource) {
          const version = (versionCounts.get(row.url) ?? 0) + 1; versionCounts.set(row.url, version)
          const parsed = new URL(row.url)
          resource = { id: `res_${digest(key).slice(0, 24)}`, url: row.url, origin: parsed.origin, path: parsed.pathname + parsed.search, version, ...(row.resource_type ? { resourceType: row.resource_type } : {}), ...(row.mime_type ? { mimeType: row.mime_type } : {}), ...(row.body_hash ? { bodyHash: row.body_hash } : {}), size: row.body_size ?? row.decoded_len ?? 0, firstSeenAt: row.start_ts, lastSeenAt: row.start_ts, evidence: [] }
          byIdentity.set(key, resource)
        }
        resource.firstSeenAt = Math.min(resource.firstSeenAt, row.start_ts); resource.lastSeenAt = Math.max(resource.lastSeenAt, row.start_ts)
        if (resource.evidence.length < 100) resource.evidence.push({ seq: row.seq, observedAt: row.start_ts, status: row.status })
      }
      offset += page.rows.length
      if (!page.rows.length || offset >= page.total) break
    }
    const resources = [...byIdentity.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt); const documents: SearchDocument[] = []; let binary = 0; let missingBody = 0
    for (const resource of resources) {
      if (signal?.aborted) break
      if (!isText(resource.mimeType, resource.resourceType)) { binary += 1; continue }
      if (!resource.bodyHash) { missingBody += 1; continue }
      const bytes = await this.content.get(resource.bodyHash, 0, Math.min(resource.size, 1024 * 1024)).catch(() => null)
      if (!bytes) { missingBody += 1; continue }
      documents.push({ resourceId: resource.id, text: new TextDecoder().decode(bytes) })
    }
    const coverage: ResourceIndexCoverage = { scanned, versions: resources.length, indexed: documents.length, binary, missingBody, truncated, canceled: signal?.aborted === true, builtAt: Date.now() }
    const previous = this.read(); this.write({ ...previous, resources, documents, coverage }); return coverage
  }

  list(input: { origin?: string; limit?: number; offset?: number } = {}): Page<ResourceVersion> {
    const state = this.read(); const rows = input.origin ? state.resources.filter((item) => item.origin === input.origin) : state.resources
    const offset = clamp(input.offset ?? 0, 0, 100_000); const limit = clamp(input.limit ?? 100, 1, 1000); return { total: rows.length, rows: rows.slice(offset, offset + limit) }
  }

  search(query: string, input: { origin?: string; limit?: number; offset?: number } = {}): { coverage: ResourceIndexCoverage | null; total: number; rows: ResourceSearchHit[] } {
    const needle = query.trim().toLocaleLowerCase(); if (!needle) return { coverage: this.read().coverage, total: 0, rows: [] }
    const state = this.read(); const docs = new Map(state.documents.map((item) => [item.resourceId, item.text])); const hits: ResourceSearchHit[] = []
    for (const resource of state.resources) {
      if (input.origin && resource.origin !== input.origin) continue
      const urlAt = resource.url.toLocaleLowerCase().indexOf(needle); const text = docs.get(resource.id) ?? ''; const textAt = text.toLocaleLowerCase().indexOf(needle)
      if (urlAt < 0 && textAt < 0) continue
      const at = textAt >= 0 ? textAt : urlAt; const source = textAt >= 0 ? text : resource.url
      hits.push({ resource, score: (textAt >= 0 ? 100 : 10) + Math.max(0, 20 - at / 100), snippet: source.slice(Math.max(0, at - 80), at + needle.length + 160), matchedIn: textAt >= 0 ? 'text' : 'url', evidenceSeq: resource.evidence[0]?.seq ?? 0 })
    }
    hits.sort((a, b) => b.score - a.score || b.resource.lastSeenAt - a.resource.lastSeenAt); const offset = clamp(input.offset ?? 0, 0, 100_000); const limit = clamp(input.limit ?? 50, 1, 500)
    return { coverage: state.coverage, total: hits.length, rows: hits.slice(offset, offset + limit) }
  }

  async diff(leftId: string, rightId: string): Promise<{ left: ResourceVersion; right: ResourceVersion; changed: boolean; lines: Array<{ line: number; left?: string; right?: string }> }> {
    const state = this.read(); const left = required(state.resources.find((item) => item.id === leftId), leftId); const right = required(state.resources.find((item) => item.id === rightId), rightId)
    const [a, b] = await Promise.all([readText(this.content, left), readText(this.content, right)]); const aa = a.split(/\r?\n/); const bb = b.split(/\r?\n/); const lines: Array<{ line: number; left?: string; right?: string }> = []
    for (let index = 0; index < Math.max(aa.length, bb.length) && lines.length < 500; index += 1) if (aa[index] !== bb[index]) lines.push({ line: index + 1, ...(aa[index] !== undefined ? { left: aa[index] } : {}), ...(bb[index] !== undefined ? { right: bb[index] } : {}) })
    return { left, right, changed: left.bodyHash !== right.bodyHash || lines.length > 0, lines }
  }

  saveNote(input: { id?: string; resourceId?: string; origin?: string; text: string }): ResourceNote { if (!input.text.trim()) throw new Error('笔记不能为空'); const state = this.read(); const old = input.id ? state.notes.filter((item) => item.id === input.id).sort((a, b) => b.version - a.version)[0] : undefined; const now = Date.now(); const note: ResourceNote = { id: input.id ?? `note_${randomUUID()}`, ...(input.resourceId ? { resourceId: input.resourceId } : {}), ...(input.origin ? { origin: input.origin } : {}), text: input.text, version: (old?.version ?? 0) + 1, createdAt: old?.createdAt ?? now, updatedAt: now }; state.notes.push(note); this.write(state); return note }
  saveOverride(input: { id?: string; kind: 'merge' | 'split'; keys: string[]; label?: string }): EndpointOverride { if (!input.keys.length) throw new Error('人工纠正至少包含一个 endpoint key'); const state = this.read(); const old = input.id ? state.overrides.filter((item) => item.id === input.id).sort((a, b) => b.version - a.version)[0] : undefined; const value: EndpointOverride = { id: input.id ?? `eo_${randomUUID()}`, kind: input.kind, keys: [...input.keys], ...(input.label ? { label: input.label } : {}), version: (old?.version ?? 0) + 1, createdAt: Date.now() }; state.overrides.push(value); this.write(state); return value }

  private read(): ResourceState { if (!existsSync(this.path)) return { schemaVersion: 1, resources: [], documents: [], coverage: null, notes: [], overrides: [] }; const value = JSON.parse(readFileSync(this.path, 'utf8')) as ResourceState; if (value.schemaVersion !== 1) throw new Error('知识库版本不兼容'); return value }
  private write(value: ResourceState): void { mkdirSync(dirname(this.path), { recursive: true }); const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`; writeFileSync(temporary, JSON.stringify(value) + '\n'); renameSync(temporary, this.path) }
}

function dossiers(resources: ResourceVersion[]): SiteDossier[] { const map = new Map<string, { row: SiteDossier; urls: Set<string> }>(); for (const item of resources) { const entry = map.get(item.origin) ?? { row: { origin: item.origin, visits: 0, resources: 0, versions: 0, bytes: 0, firstSeenAt: item.firstSeenAt, lastSeenAt: item.lastSeenAt, types: {} }, urls: new Set<string>() }; const row = entry.row; row.visits += item.evidence.length; entry.urls.add(item.url); row.resources = entry.urls.size; row.versions += 1; row.bytes += item.size; row.firstSeenAt = Math.min(row.firstSeenAt, item.firstSeenAt); row.lastSeenAt = Math.max(row.lastSeenAt, item.lastSeenAt); const type = item.resourceType ?? 'Other'; row.types[type] = (row.types[type] ?? 0) + 1; map.set(item.origin, entry) } return [...map.values()].map((item) => item.row).sort((a, b) => b.lastSeenAt - a.lastSeenAt) }
function isText(mime?: string, type?: string): boolean { return Boolean(mime?.startsWith('text/') || /json|javascript|xml|svg|html|css|form/i.test(mime ?? '') || /Document|Script|Stylesheet|XHR|Fetch/i.test(type ?? '')) }
async function readText(content: ContentStore, resource: ResourceVersion): Promise<string> { if (!resource.bodyHash) return ''; const bytes = await content.get(resource.bodyHash, 0, Math.min(resource.size, 2 * 1024 * 1024)); return bytes ? new TextDecoder().decode(bytes) : '' }
function required<T>(value: T | undefined, id: string): T { if (!value) throw new Error(`资源不存在：${id}`); return value }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, Math.floor(value))) }
