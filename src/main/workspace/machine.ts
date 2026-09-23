import type { WorkspaceLifecycleState } from '../../shared/contracts/workspace'

/**
 * 工作区主状态机。登录、插件和任务将在后续以正交子状态接入，不能靠扩大这里
 * 的枚举来表达它们的排列组合。
 */
const TRANSITIONS: Record<WorkspaceLifecycleState, readonly WorkspaceLifecycleState[]> = {
  creating: ['closed', 'error'],
  closed: ['opening', 'archived'],
  opening: ['running', 'error', 'closed'],
  running: ['checkpointing', 'suspended', 'error'],
  checkpointing: ['running', 'error'],
  suspended: ['opening', 'archived', 'closed'],
  recovering: ['running', 'error', 'closed'],
  error: ['opening', 'suspended', 'closed', 'archived'],
  archived: []
}

export function canTransition(
  from: WorkspaceLifecycleState,
  to: WorkspaceLifecycleState
): boolean {
  return from === to || TRANSITIONS[from].includes(to)
}

export function assertTransition(
  from: WorkspaceLifecycleState,
  to: WorkspaceLifecycleState
): void {
  if (!canTransition(from, to)) {
    throw new Error(`工作区状态不能从 ${from} 转为 ${to}`)
  }
}

