import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface CaptureEvidence {
  inst: number
  seq: number
  phase: 'fetch' | 'content' | 'retention'
  state: string
  size: number
  hash?: string
  reason?: string
  at: number
  previous: string
  digest: string
}

export interface CaptureEvidenceSummary {
  captured: number
  gaps: number
  deleted: number
  byReason: Record<string, number>
  lastError?: string
  lastCaptureAt?: number
  chainValid: boolean
}

/** 逐条哈希链：本机文件所有者仍可替换整份账本，但意外损坏和单条篡改可检测。 */
export class CaptureEvidenceLedger {
  private readonly path: string
  private tail: Promise<void> = Promise.resolve()
  private cachedRows: CaptureEvidence[] | null = null

  constructor(contentDir: string) { this.path = join(contentDir, 'capture-evidence.jsonl') }

  async record(input: Omit<CaptureEvidence, 'at' | 'previous' | 'digest'>): Promise<CaptureEvidence> {
    let written!: CaptureEvidence
    const work = this.tail.then(async () => {
      if (!this.cachedRows) {
        const loaded = await this.readRows()
        if (!loaded.valid) throw new Error('采集证据链校验失败，拒绝追加')
        this.cachedRows = loaded.rows
      }
      const rows = this.cachedRows
      const previous = rows.at(-1)?.digest ?? 'genesis'
      const entry = { ...input, at: Date.now(), previous }
      written = { ...entry, digest: digest(JSON.stringify(entry)) }
      await mkdir(dirname(this.path), { recursive: true })
      await appendFile(this.path, JSON.stringify(written) + '\n', 'utf8')
      rows.push(written)
    })
    this.tail = work.catch(() => undefined)
    await work
    return written
  }

  async entries(inst: number, seq: number): Promise<CaptureEvidence[]> {
    await this.tail
    const { rows, valid } = await this.readRows()
    if (!valid) throw new Error('采集证据链校验失败')
    return rows.filter((item) => item.inst === inst && item.seq === seq)
  }

  async entriesBySeq(seq: number): Promise<CaptureEvidence[]> {
    await this.tail
    const { rows, valid } = await this.readRows()
    if (!valid) throw new Error('采集证据链校验失败')
    return rows.filter((item) => item.seq === seq && item.inst !== 0)
  }

  async summary(): Promise<CaptureEvidenceSummary> {
    await this.tail
    const { rows, valid } = await this.readRows()
    const latest = new Map<string, CaptureEvidence>()
    for (const item of rows) latest.set(`${item.inst}:${item.seq}`, item)
    const result: CaptureEvidenceSummary = { captured: 0, gaps: 0, deleted: 0, byReason: {}, chainValid: valid }
    for (const item of latest.values()) {
      if (item.state === 'retention_intent') continue
      result.lastCaptureAt = Math.max(result.lastCaptureAt ?? 0, item.at)
      if (item.state === 'stored') result.captured += 1
      else if (item.state === 'empty') continue
      else {
        result.gaps += 1
        result.byReason[item.state] = (result.byReason[item.state] ?? 0) + 1
        result.lastError = item.state
        if (item.state === 'retained_deleted') result.deleted += 1
      }
    }
    if (!valid) result.lastError = 'evidence_chain_invalid'
    return result
  }

  private async readRows(): Promise<{ rows: CaptureEvidence[]; valid: boolean }> {
    if (!existsSync(this.path)) return { rows: [], valid: true }
    const text = await readFile(this.path, 'utf8')
    const rows: CaptureEvidence[] = []
    let previous = 'genesis'
    for (const line of text.split('\n').filter(Boolean)) {
      let item: CaptureEvidence
      try { item = JSON.parse(line) as CaptureEvidence } catch { return { rows, valid: false } }
      const { digest: stored, ...entry } = item
      if (item.previous !== previous || digest(JSON.stringify(entry)) !== stored) return { rows, valid: false }
      rows.push(item)
      previous = item.digest
    }
    return { rows, valid: true }
  }
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
