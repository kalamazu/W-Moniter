import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ContentStore } from './store'

export interface ContentPolicy {
  quotaBytes: number
  graceMs: number
  maskSensitivePreview: boolean
}

export interface ContentPin { hash: string; reason: string; createdAt: number }
export interface ContentAudit { id: string; at: number; action: string; hash?: string; detail?: string }
interface GovernanceState { schemaVersion: 1; policy: ContentPolicy; pins: ContentPin[]; audit: ContentAudit[] }

const DEFAULT_POLICY: ContentPolicy = {
  quotaBytes: 20 * 1024 * 1024 * 1024,
  graceMs: 24 * 60 * 60 * 1000,
  maskSensitivePreview: true
}

/** 工作区内正文的策略、固定与删除审计。原始字节仍只存在 ContentStore。 */
export class ContentGovernance {
  private readonly path: string
  constructor(private readonly contentDir: string) { this.path = join(contentDir, 'governance.json') }

  summary(): GovernanceState & { usage: Awaited<ReturnType<ContentStore['stats']>> } {
    return { ...this.read(), usage: { objects: 0, bytes: 0, chunks: 0 } }
  }

  async inspect() {
    const state = this.read()
    const store = new ContentStore(this.contentDir)
    return { ...state, usage: await store.stats(), objects: await store.catalog() }
  }

  pin(hash: string, reason: string): ContentPin {
    assertHash(hash)
    const state = this.read()
    const existing = state.pins.find((item) => item.hash === hash)
    if (existing) return existing
    const pin = { hash, reason: reason.trim().slice(0, 240) || 'manual', createdAt: Date.now() }
    state.pins.push(pin)
    this.audit(state, 'pin', hash, pin.reason)
    this.write(state)
    return pin
  }

  unpin(hash: string): { removed: boolean } {
    assertHash(hash)
    const state = this.read()
    const before = state.pins.length
    state.pins = state.pins.filter((item) => item.hash !== hash)
    const removed = state.pins.length !== before
    if (removed) { this.audit(state, 'unpin', hash); this.write(state) }
    return { removed }
  }

  setPolicy(patch: Partial<ContentPolicy>): ContentPolicy {
    const state = this.read()
    const quotaBytes = patch.quotaBytes ?? state.policy.quotaBytes
    const graceMs = patch.graceMs ?? state.policy.graceMs
    if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 16 * 1024 * 1024) throw new Error('正文配额不能低于 16 MiB')
    if (!Number.isSafeInteger(graceMs) || graceMs < 0) throw new Error('宽限期必须是非负整数')
    state.policy = { quotaBytes, graceMs, maskSensitivePreview: patch.maskSensitivePreview ?? state.policy.maskSensitivePreview }
    this.audit(state, 'policy.update', undefined, JSON.stringify(state.policy))
    this.write(state)
    return state.policy
  }

  recordDeletion(hash: string, detail: string): void {
    const state = this.read()
    this.audit(state, 'content.delete', hash, detail.slice(0, 500))
    this.write(state)
  }

  isPinned(hash: string): boolean { return this.read().pins.some((item) => item.hash === hash) }

  private audit(state: GovernanceState, action: string, hash?: string, detail?: string): void {
    state.audit.push({ id: randomUUID(), at: Date.now(), action, ...(hash ? { hash } : {}), ...(detail ? { detail } : {}) })
    state.audit = state.audit.slice(-1000)
  }

  private read(): GovernanceState {
    if (!existsSync(this.path)) return { schemaVersion: 1, policy: { ...DEFAULT_POLICY }, pins: [], audit: [] }
    const value = JSON.parse(readFileSync(this.path, 'utf8')) as GovernanceState
    if (value.schemaVersion !== 1 || !Array.isArray(value.pins) || !Array.isArray(value.audit)) throw new Error('正文治理账本损坏')
    return value
  }

  private write(state: GovernanceState): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', 'utf8')
    renameSync(temporary, this.path)
  }
}

function assertHash(hash: string): void {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('无效的内容 hash')
}
