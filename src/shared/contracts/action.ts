/**
 * 跨 UI / IPC / HTTP / MCP 的动作协议。
 *
 * `TargetRef` 是执行目标，不是“当前面板正在显示什么”。任何会改变浏览器或工作区
 * 状态的动作都必须携带它；这样 Agent 和人类操作都不会意外落到 UI 焦点上。
 */
export type IdentityRef =
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'profile'; workspaceId: string; profileId: string }
  | { kind: 'browser'; workspaceId: string; browserId: string }
  | { kind: 'tab'; workspaceId: string; browserId: string; tabId: string }

export type TargetRef =
  | { kind: 'workspace'; workspaceId: string; expectedVersion?: number }
  | { kind: 'workspace-collection' }
  | { kind: 'profile'; workspaceId: string; profileId: string }
  | { kind: 'browser'; workspaceId: string; browserId: string }
  | { kind: 'tab'; workspaceId: string; browserId: string; tabId: string }

export type ActionKind = 'query' | 'mutation'
export type TaskState = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'unknown'

export interface ActionDescriptor {
  name: string
  kind: ActionKind
  /** mutation 必须 required；query 可以 optional / none。 */
  target: 'required' | 'optional' | 'none'
  description: string
}

export interface ActionRequest<I = unknown> {
  action: string
  input: I
  target?: TargetRef
  /** 调用方生成；同一个 action + key 只能对应同一份输入。 */
  idempotencyKey?: string
}

export interface TaskSnapshot {
  id: string
  action: string
  state: TaskState
  target?: TargetRef
  idempotencyKey?: string
  inputHash: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
  error?: { code: string; message: string }
}

/** 每个入口返回相同外壳；output 才是领域结果。 */
export interface ActionResult<O = unknown> {
  task: TaskSnapshot
  output: O | null
}

export interface ActionCatalog {
  actions: ActionDescriptor[]
}

export class ActionError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_action' | 'target_required' | 'target_invalid' | 'target_stale' | 'idempotency_conflict' | 'task_canceled' | 'effect_unknown'
  ) {
    super(message)
    this.name = 'ActionError'
  }
}

/** 远端可能已经产生效果、但本机没拿到确定回执时必须如实标成 unknown。 */
export class RemoteEffectUnknownError extends ActionError {
  constructor(message: string) {
    super(message, 'effect_unknown')
    this.name = 'RemoteEffectUnknownError'
  }
}
