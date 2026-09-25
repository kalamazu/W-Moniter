import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ActionRequest, ActionResult, TargetRef } from '../../shared/contracts/action'
import type { WorkflowDefinition, WorkflowEvent, WorkflowNode, WorkflowRun } from '../../shared/contracts/workflow'
import { VersionedJsonRepository } from '../repositories/versioned-json'

interface WorkflowState { schemaVersion: 1; definitions: WorkflowDefinition[]; runs: WorkflowRun[] }
type Execute = (request: ActionRequest) => Promise<ActionResult>
type WaitRequest = (query: Record<string, unknown>) => Promise<unknown | null>

export class WorkflowService {
  private readonly path: string
  private readonly repository: VersionedJsonRepository<WorkflowState>
  private readonly signals = new Map<string, AbortController>()
  constructor(root: string) { this.path = join(root, 'workflows.json'); this.repository = new VersionedJsonRepository<WorkflowState>(this.path, () => ({ schemaVersion: 1, definitions: [], runs: [] }), validateState); this.recover() }
  list(): WorkflowState { const state = this.read(); return { ...state, runs: state.runs.slice(-200).reverse() } }
  save(input: { id?: string; name: string; nodes: WorkflowNode[] }): WorkflowDefinition { validate(input); const state = this.read(); const old = input.id ? state.definitions.filter((item) => item.id === input.id).sort((a, b) => b.version - a.version)[0] : undefined; const now = Date.now(); const value: WorkflowDefinition = { id: input.id ?? `wf_${randomUUID()}`, version: (old?.version ?? 0) + 1, name: input.name, nodes: structuredClone(input.nodes), createdAt: old?.createdAt ?? now, updatedAt: now }; state.definitions.push(value); this.write(state); return value }
  get(id: string, version?: number): WorkflowDefinition { const item = this.read().definitions.filter((row) => row.id === id && (version === undefined || row.version === version)).sort((a, b) => b.version - a.version)[0]; if (!item) throw new Error(`工作流不存在：${id}`); return item }
  getRun(id: string): WorkflowRun { const run = this.read().runs.find((item) => item.id === id); if (!run) throw new Error(`运行不存在：${id}`); return run }

  async start(definition: WorkflowDefinition, workspaceId: string, variables: Record<string, unknown>, execute: Execute, waitRequest: WaitRequest, signal?: AbortSignal): Promise<WorkflowRun> {
    const now = Date.now(); const run: WorkflowRun = { id: `wr_${randomUUID()}`, workflowId: definition.id, workflowVersion: definition.version, workspaceId, state: 'running', lease: 1, leaseToken: randomUUID(), owner: 'agent', variables: structuredClone(variables), nodes: definition.nodes.map((node) => ({ nodeId: node.id, state: 'pending', attempts: 0 })), timeline: [], createdAt: now, updatedAt: now }
    event(run, 'run.started'); this.update(run, true); return this.drive(run, definition, run.leaseToken, execute, waitRequest, signal)
  }

  async resume(runId: string, leaseToken: string, execute: Execute, waitRequest: WaitRequest, signal?: AbortSignal, acknowledgeUnknown = false): Promise<WorkflowRun> {
    const run = this.getRun(runId); this.assertLease(run, leaseToken)
    if (run.state === 'succeeded' || run.state === 'canceled') throw new Error(`终态运行不能恢复：${run.state}`)
    if (run.nodes.some((node) => node.state === 'unknown') && !acknowledgeUnknown) throw new Error('存在 unknown 节点，必须人工确认后才能继续')
    if (acknowledgeUnknown) for (const node of run.nodes) if (node.state === 'unknown') { node.state = 'pending'; node.error = undefined; node.startedAt = undefined; node.finishedAt = undefined }
    run.state = 'running'; event(run, 'run.resumed'); this.update(run); return this.drive(run, this.get(run.workflowId, run.workflowVersion), leaseToken, execute, waitRequest, signal)
  }

  command(runId: string, command: 'pause' | 'cancel' | 'takeover', leaseToken?: string): WorkflowRun {
    const run = this.getRun(runId)
    if (run.state === 'succeeded' || run.state === 'canceled') throw new Error(`终态运行不能执行 ${command}：${run.state}`)
    if (command !== 'takeover') this.assertLease(run, leaseToken ?? '')
    run.lease += 1; run.leaseToken = randomUUID(); if (command === 'takeover') run.owner = 'human'; run.state = command === 'cancel' ? 'canceled' : 'paused'
    for (const node of run.nodes) if (node.state === 'running') { node.state = 'unknown'; node.error = `${command} 发生时节点仍在执行，远端效果未知` }
    this.signals.get(run.id)?.abort(); event(run, command === 'takeover' ? 'lease.takeover' : `run.${command}`, undefined, '旧执行者已失效；在飞节点标记 unknown'); this.update(run); return run
  }

  private async drive(run: WorkflowRun, definition: WorkflowDefinition, leaseToken: string, execute: Execute, waitRequest: WaitRequest, outerSignal?: AbortSignal): Promise<WorkflowRun> {
    const local = new AbortController(); this.signals.set(run.id, local); const abort = () => local.abort(); outerSignal?.addEventListener('abort', abort, { once: true })
    try {
      for (;;) {
        const fresh = this.getRun(run.id); this.assertLease(fresh, leaseToken); Object.assign(run, fresh)
        if (run.state !== 'running' || local.signal.aborted || outerSignal?.aborted) break
        const ready = definition.nodes.find((node) => { const state = run.nodes.find((item) => item.nodeId === node.id)!; return state.state === 'pending' && (node.dependsOn ?? []).every((id) => ['succeeded', 'skipped'].includes(run.nodes.find((item) => item.nodeId === id)?.state ?? '')) })
        if (!ready) break
        await this.executeNode(run, ready, execute, waitRequest, local.signal)
        const current = this.getRun(run.id); if (current.leaseToken !== leaseToken) return current
        this.update(run)
        const nodeState = run.nodes.find((item) => item.nodeId === ready.id)?.state
        if (nodeState === 'failed') { run.state = 'failed'; event(run, 'run.failed', ready.id); break }
        if (nodeState === 'unknown') { run.state = 'needsReview'; event(run, 'run.needsReview', ready.id); break }
        if (nodeState === 'canceled') { run.state = 'canceled'; event(run, 'run.canceled', ready.id); break }
      }
      if ((local.signal.aborted || outerSignal?.aborted) && run.state === 'running') run.state = 'canceled'
      else if (run.state === 'running') { const pending = run.nodes.some((item) => item.state === 'pending' || item.state === 'running'); run.state = pending ? 'failed' : 'succeeded'; event(run, pending ? 'run.deadlock' : 'run.succeeded') }
      this.update(run); return run
    } finally { outerSignal?.removeEventListener('abort', abort); if (this.signals.get(run.id) === local) this.signals.delete(run.id) }
  }

  private async executeNode(run: WorkflowRun, node: WorkflowNode, execute: Execute, waitRequest: WaitRequest, signal: AbortSignal): Promise<void> {
    const state = run.nodes.find((item) => item.nodeId === node.id)!; if (node.kind === 'action' && node.when && getPath(run.variables, node.when.variable) !== node.when.equals) { state.state = 'skipped'; state.finishedAt = Date.now(); event(run, 'node.skipped', node.id); return }
    state.state = 'running'; state.startedAt = Date.now(); event(run, 'node.started', node.id); this.update(run)
    try {
      let output: unknown
      if (node.kind === 'wait') output = await wait(node, waitRequest, signal)
      else {
        if (node.action.startsWith('workflow.')) throw new Error('工作流节点不能递归调用 workflow.*')
        const target = normalizeTarget(node.target, run.workspaceId); const max = Math.max(1, Math.min(6, (node.retries ?? 0) + 1)); let result: ActionResult | null = null
        for (let attempt = 0; attempt < max; attempt += 1) { state.attempts += 1; result = await execute({ action: node.action, input: interpolate(node.input, run.variables), target, idempotencyKey: `${run.id}:${node.id}:${attempt}` }); if (result.task.state === 'succeeded') break; if (result.task.state === 'unknown') { state.state = 'unknown'; state.error = result.task.error?.message; state.finishedAt = Date.now(); event(run, 'node.unknown', node.id, state.error); return } }
        if (!result || result.task.state !== 'succeeded') throw new Error(result?.task.error?.message ?? '节点动作失败')
        output = result.output
      }
      state.output = output; for (const [name, path] of Object.entries(node.extract ?? {})) run.variables[name] = getPath(output, path)
      state.state = 'succeeded'; state.finishedAt = Date.now(); event(run, 'node.succeeded', node.id)
    } catch (error) { state.state = signal.aborted ? 'canceled' : 'failed'; state.error = error instanceof Error ? error.message : String(error); state.finishedAt = Date.now(); event(run, `node.${state.state}`, node.id, state.error) }
  }

  private assertLease(run: WorkflowRun, token: string): void { if (run.leaseToken !== token) throw new Error(`执行租约已失效（当前 fencing=${run.lease}）`) }
  private update(run: WorkflowRun, append = false): void { run.updatedAt = Date.now(); const state = this.read(); const index = state.runs.findIndex((item) => item.id === run.id); if (index >= 0) state.runs[index] = structuredClone(run); else if (append) state.runs.push(structuredClone(run)); else throw new Error('运行记录不存在'); this.write(state) }
  private recover(): void { if (!existsSync(this.path)) return; const state = this.read(); let changed = false; for (const run of state.runs) if (run.state === 'running') { run.state = 'needsReview'; run.lease += 1; run.leaseToken = randomUUID(); for (const node of run.nodes) if (node.state === 'running') node.state = 'unknown'; event(run, 'run.recovered', undefined, '进程中断：在飞节点效果未知，未自动重发'); changed = true } if (changed) this.write(state) }
  private read(): WorkflowState { return this.repository.read().value }
  private write(value: WorkflowState): void { this.repository.write(value) }
}
function validateState(value: WorkflowState): void { if (value.schemaVersion !== 1 || !Array.isArray(value.definitions) || !Array.isArray(value.runs)) throw new Error('工作流仓库版本不兼容') }

async function wait(node: Extract<WorkflowNode, { kind: 'wait' }>, provider: WaitRequest, signal: AbortSignal): Promise<unknown> { if (node.wait.type === 'delay') { await delay(node.wait.ms, signal); return { waitedMs: node.wait.ms } } const end = Date.now() + node.wait.timeoutMs; while (Date.now() < end) { if (signal.aborted) throw new Error('等待已取消'); const found = await provider(node.wait.query); if (found) return found; await delay(Math.min(node.wait.pollMs ?? 100, Math.max(1, end - Date.now())), signal) } throw new Error('等待请求超时') }
function delay(ms: number, signal: AbortSignal): Promise<void> { return new Promise((resolve, reject) => { const timer = setTimeout(resolve, Math.max(0, Math.min(ms, 120_000))); signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('等待已取消')) }, { once: true }) }) }
function validate(input: { name: string; nodes: WorkflowNode[] }): void { if (!input.name.trim() || !input.nodes.length) throw new Error('工作流名称和节点不能为空'); const ids = new Set(input.nodes.map((node) => node.id)); if (ids.size !== input.nodes.length || [...ids].some((id) => !id)) throw new Error('节点 ID 必须唯一且非空'); for (const node of input.nodes) for (const dependency of node.dependsOn ?? []) if (!ids.has(dependency) || dependency === node.id) throw new Error(`无效依赖：${node.id} -> ${dependency}`); const visiting = new Set<string>(); const done = new Set<string>(); const visit = (id: string): void => { if (visiting.has(id)) throw new Error('工作流包含环'); if (done.has(id)) return; visiting.add(id); const node = input.nodes.find((item) => item.id === id)!; for (const dependency of node.dependsOn ?? []) visit(dependency); visiting.delete(id); done.add(id) }; for (const id of ids) visit(id) }
function normalizeTarget(target: TargetRef | undefined, workspaceId: string): TargetRef { if (!target) return { kind: 'workspace', workspaceId }; if (target.kind === 'workspace-collection' || target.workspaceId !== workspaceId) throw new Error('工作流节点不能扩大或跨越工作区目标'); return structuredClone(target) }
function interpolate(value: unknown, variables: Record<string, unknown>): unknown { if (typeof value === 'string') return value.replace(/\$\{([A-Za-z0-9_.-]+)\}/g, (_, key) => String(getPath(variables, key) ?? '')); if (Array.isArray(value)) return value.map((item) => interpolate(item, variables)); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, interpolate(item, variables)])); return value }
function getPath(value: unknown, path: string): unknown { let current = value; for (const key of path.split('.').filter(Boolean)) current = (current as Record<string, unknown> | null)?.[key]; return current }
function event(run: WorkflowRun, type: string, nodeId?: string, detail?: string): void { const value: WorkflowEvent = { at: Date.now(), type, lease: run.lease, ...(nodeId ? { nodeId } : {}), ...(detail ? { detail } : {}) }; run.timeline.push(value); run.timeline = run.timeline.slice(-2000) }
