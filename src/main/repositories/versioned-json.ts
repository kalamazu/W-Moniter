import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

interface Envelope<T> { repositoryVersion: 1; revision: number; updatedAt: number; data: T }
export interface RepositoryDiagnostics { path: string; revision: number; migratedLegacy: boolean; corruptBackup?: string }

/** Small local repository with explicit envelope, legacy migration backup and compare-and-swap writes. */
export class VersionedJsonRepository<T> {
  private migratedLegacy = false
  private corruptBackup?: string
  constructor(private readonly path: string, private readonly empty: () => T, private readonly validate: (value: T) => void) {}

  read(): { value: T; revision: number } {
    if (!existsSync(this.path)) return { value: this.empty(), revision: 0 }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Envelope<T> | T
      if (isEnvelope(parsed)) { this.validate(parsed.data); return { value: parsed.data, revision: parsed.revision } }
      this.validate(parsed as T); this.migrate(parsed as T); return this.read()
    } catch (error) {
      const backup = `${this.path}.corrupt.${Date.now()}`; renameSync(this.path, backup); this.corruptBackup = backup
      throw new Error(`仓库损坏，已隔离到 ${backup}：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  write(value: T, expectedRevision?: number): number {
    this.validate(value); const current = this.read().revision
    if (expectedRevision !== undefined && current !== expectedRevision) throw new Error(`仓库并发冲突：期望 revision ${expectedRevision}，实际 ${current}`)
    const next = current + 1; this.atomic({ repositoryVersion: 1, revision: next, updatedAt: Date.now(), data: value }); return next
  }

  update(change: (value: T) => T): T { const current = this.read(); const next = change(structuredClone(current.value)); this.write(next, current.revision); return next }
  diagnostics(): RepositoryDiagnostics { return { path: this.path, revision: this.read().revision, migratedLegacy: this.migratedLegacy, ...(this.corruptBackup ? { corruptBackup: this.corruptBackup } : {}) } }

  private migrate(value: T): void { const backup = `${this.path}.legacy.${Date.now()}`; copyFileSync(this.path, backup); this.atomic({ repositoryVersion: 1, revision: 1, updatedAt: Date.now(), data: value }); this.migratedLegacy = true }
  private atomic(value: Envelope<T>): void { mkdirSync(dirname(this.path), { recursive: true }); const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`; writeFileSync(temporary, JSON.stringify(value) + '\n'); renameSync(temporary, this.path) }
}
function isEnvelope<T>(value: unknown): value is Envelope<T> { const row = value as Partial<Envelope<T>> | null; return row?.repositoryVersion === 1 && Number.isSafeInteger(row.revision) && row.revision! >= 0 && 'data' in row }
