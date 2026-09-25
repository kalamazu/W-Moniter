import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import {
  ActionError,
  RemoteEffectUnknownError,
  type ActionRequest,
  type ActionResult,
  type TaskSnapshot, type TaskEvent
} from '../../shared/contracts/action'

export interface TaskExecutionContext {
  task: TaskSnapshot
  signal: AbortSignal
}

export type ActionHandler<I, O> = (input: I, context: TaskExecutionContext) => Promise<O> | O

export interface TaskJournalDiagnostics {
  journalExists: boolean
  corrupt: boolean
  corruptBackup?: string
  recoveredUnknown: number
  taskCount: number
  lastWrittenAt?: number
  error?: string
}

interface StoredTask {
  snapshot: TaskSnapshot
  inputHash: string
  controller: AbortController
  output: unknown | null
  completed: boolean
}

/**
 * 最小任务账本：先在单主进程内保证幂等、取消和不确定效果语义。
 * 持久任务事件表会在后续 scoped schema 任务中替换这里的内存实现。
 */
export class TaskService {
  private readonly tasks = new Map<string, StoredTask>()
  private readonly idempotency = new Map<string, string>()
  private readonly journalPath?: string
  private readonly events: TaskEvent[] = []
  private nextCursor = 1
  private readonly health: TaskJournalDiagnostics = { journalExists: false, corrupt: false, recoveredUnknown: 0, taskCount: 0 }

  constructor(options: { journalPath?: string } = {}) {
    this.journalPath = options.journalPath
    this.restore()
  }

  async execute<I, O>(request: ActionRequest<I>, handler: ActionHandler<I, O>): Promise<ActionResult<O>> {
    const inputHash = hash({ input: request.input, target: request.target })
    const idempotencyKey = request.idempotencyKey?.trim() || undefined
    if (idempotencyKey) {
      const lookup = `${request.action}:${idempotencyKey}`
      const previousId = this.idempotency.get(lookup)
      if (previousId) {
        const previous = this.tasks.get(previousId)!
        if (previous.inputHash !== inputHash) {
          throw new ActionError('相同幂等键不能用于不同输入或目标', 'idempotency_conflict')
        }
        return { task: copy(previous.snapshot), output: previous.output as O | null }
      }
    }

    const now = Date.now()
    const snapshot: TaskSnapshot = {
      id: `task_${randomUUID()}`,
      action: request.action,
      state: 'queued',
      ...(request.target ? { target: request.target } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      inputHash,
      createdAt: now
    }
    const stored: StoredTask = { snapshot, inputHash, controller: new AbortController(), output: null, completed: false }
    this.tasks.set(snapshot.id, stored)
    if (idempotencyKey) this.idempotency.set(`${request.action}:${idempotencyKey}`, snapshot.id)
    this.persist()
    this.event(snapshot.id, 'queued')

    if (stored.controller.signal.aborted) return this.finishCanceled<O>(stored)
    snapshot.state = 'running'
    snapshot.startedAt = Date.now()
    this.persist()
    this.event(snapshot.id, 'running')
    try {
      const output = await handler(request.input, { task: copy(snapshot), signal: stored.controller.signal })
      if (stored.controller.signal.aborted) return this.finishCanceled<O>(stored)
      stored.output = output
      snapshot.state = 'succeeded'
      snapshot.finishedAt = Date.now()
      stored.completed = true
      this.persist()
      this.event(snapshot.id, 'succeeded')
      return { task: copy(snapshot), output }
    } catch (error) {
      snapshot.finishedAt = Date.now()
      stored.completed = true
      if (stored.controller.signal.aborted) return this.finishCanceled<O>(stored)
      if (error instanceof RemoteEffectUnknownError) {
        snapshot.state = 'unknown'
        snapshot.error = { code: error.code, message: error.message }
      } else {
        snapshot.state = 'failed'
        snapshot.error = {
          code: error instanceof ActionError ? error.code : 'invalid_action',
          message: error instanceof Error ? error.message : String(error)
        }
      }
      this.persist()
      this.event(snapshot.id, snapshot.state)
      return { task: copy(snapshot), output: null }
    }
  }

  cancel(taskId: string): TaskSnapshot {
    const stored = this.tasks.get(taskId)
    if (!stored) throw new ActionError(`找不到任务：${taskId}`, 'invalid_action')
    if (!stored.completed && stored.snapshot.state !== 'canceled') stored.controller.abort()
    if (!stored.completed) {
      stored.snapshot.state = 'canceled'
      stored.snapshot.finishedAt = Date.now()
      stored.snapshot.error = { code: 'task_canceled', message: '任务已取消' }
      stored.completed = true
    }
    this.persist()
    this.event(stored.snapshot.id, stored.snapshot.state === 'canceled' ? 'canceled' : stored.snapshot.state as TaskEvent['type'])
    return copy(stored.snapshot)
  }

  get(taskId: string): TaskSnapshot | null {
    const stored = this.tasks.get(taskId)
    return stored ? copy(stored.snapshot) : null
  }
  result(taskId: string): ActionResult | null { const stored = this.tasks.get(taskId); return stored ? { task: copy(stored.snapshot), output: stored.output } : null }
  readEvents(after = 0, limit = 200): { rows: TaskEvent[]; nextCursor: number } { const rows = this.events.filter((item) => item.cursor > after).slice(0, Math.max(1, Math.min(1000, limit))); return { rows: rows.map((item) => ({ ...item })), nextCursor: rows.at(-1)?.cursor ?? after } }
  progress(taskId: string, detail: unknown): void { if (!this.tasks.has(taskId)) throw new ActionError(`找不到任务：${taskId}`, 'invalid_action'); this.event(taskId, 'progress', detail) }

  diagnostics(): TaskJournalDiagnostics {
    return { ...this.health, taskCount: this.tasks.size }
  }

  private finishCanceled<O>(stored: StoredTask): ActionResult<O> {
    stored.snapshot.state = 'canceled'
    stored.snapshot.finishedAt = Date.now()
    stored.snapshot.error = { code: 'task_canceled', message: '任务已取消' }
    stored.completed = true
    this.persist()
    this.event(stored.snapshot.id, 'canceled')
    return { task: copy(stored.snapshot), output: null }
  }

  private restore(): void {
    this.restoreEvents()
    if (!this.journalPath || !existsSync(this.journalPath)) return
    this.health.journalExists = true
    try {
      const stored = JSON.parse(readFileSync(this.journalPath, 'utf8')) as Array<{ snapshot: TaskSnapshot; output: unknown | null }>
      if (!Array.isArray(stored) || stored.some((entry) => !entry?.snapshot?.id || !entry.snapshot.action || !entry.snapshot.inputHash)) {
        throw new Error('任务日志结构无效')
      }
      for (const entry of stored) {
        const snapshot = copy(entry.snapshot)
        if (snapshot.state === 'queued' || snapshot.state === 'running') {
          snapshot.state = 'unknown'
          snapshot.finishedAt = Date.now()
          snapshot.error = { code: 'effect_unknown', message: '应用重启时任务尚未完成；远端效果未知' }
          this.health.recoveredUnknown += 1
        }
        const task: StoredTask = { snapshot, inputHash: snapshot.inputHash, controller: new AbortController(), output: entry.output ?? null, completed: true }
        this.tasks.set(snapshot.id, task)
        if (snapshot.idempotencyKey) this.idempotency.set(`${snapshot.action}:${snapshot.idempotencyKey}`, snapshot.id)
      }
      this.persist()
    } catch (error) {
      this.health.corrupt = true
      this.health.error = error instanceof Error ? error.message : String(error)
      const backup = `${this.journalPath}.corrupt.${Date.now()}`
      try {
        renameSync(this.journalPath, backup)
        this.health.corruptBackup = basename(backup)
      } catch (backupError) {
        this.health.error += `；备份失败：${String(backupError)}`
      }
    }
  }

  private event(taskId: string, type: TaskEvent['type'], detail?: unknown): void { const item: TaskEvent = { cursor: this.nextCursor++, taskId, at: Date.now(), type, ...(detail === undefined ? {} : { detail }) }; this.events.push(item); if (this.events.length > 10_000) this.events.splice(0, this.events.length - 10_000); if (this.journalPath) { mkdirSync(dirname(this.journalPath), { recursive: true }); appendFileSync(`${this.journalPath}.events.jsonl`, JSON.stringify(item) + '\n') } }
  private restoreEvents(): void { if (!this.journalPath || !existsSync(`${this.journalPath}.events.jsonl`)) return; try { for (const line of readFileSync(`${this.journalPath}.events.jsonl`, 'utf8').split(/\r?\n/).filter(Boolean).slice(-10_000)) { const item = JSON.parse(line) as TaskEvent; if (item.cursor > 0 && item.taskId) this.events.push(item) } this.nextCursor = (this.events.at(-1)?.cursor ?? 0) + 1 } catch { /* task journal remains authoritative */ } }

  private persist(): void {
    if (!this.journalPath) return
    mkdirSync(dirname(this.journalPath), { recursive: true })
    const rows = [...this.tasks.values()].map((item) => ({ snapshot: item.snapshot, output: item.output }))
    const temporary = `${this.journalPath}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(rows) + '\n', 'utf8')
    renameSync(temporary, this.journalPath)
    this.health.journalExists = true
    this.health.taskCount = rows.length
    this.health.lastWrittenAt = statSync(this.journalPath).mtimeMs
  }
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(sort(value))).digest('hex')
}

function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, sort(entry)]))
}

function copy(snapshot: TaskSnapshot): TaskSnapshot {
  return { ...snapshot, ...(snapshot.target ? { target: { ...snapshot.target } } : {}), ...(snapshot.error ? { error: { ...snapshot.error } } : {}) }
}
