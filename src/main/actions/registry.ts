import { ActionError, type ActionCatalog, type ActionDescriptor, type ActionRequest, type ActionResult, type TargetRef } from '../../shared/contracts/action'
import type { WorkspaceCreateInput, WorkspaceOverview, WorkspaceSummary } from '../../shared/contracts/workspace'
import type { WorkspaceService } from '../workspace/service'
import { TaskService } from './task-service'

type WorkspaceAction = 'workspaces.list' | 'workspace.create' | 'workspace.open' | 'workspace.suspend'

export interface WorkspaceActionRuntime {
  create(input: WorkspaceCreateInput): WorkspaceSummary
  open(id: string): Promise<WorkspaceOverview>
  suspend(id: string): Promise<WorkspaceOverview>
}

const DESCRIPTORS: Record<WorkspaceAction, ActionDescriptor> = {
  'workspaces.list': { name: 'workspaces.list', kind: 'query', target: 'optional', description: '列出工作区及活动焦点' },
  'workspace.create': { name: 'workspace.create', kind: 'mutation', target: 'required', description: '创建持久工作区' },
  'workspace.open': { name: 'workspace.open', kind: 'mutation', target: 'required', description: '打开或聚焦工作区' },
  'workspace.suspend': { name: 'workspace.suspend', kind: 'mutation', target: 'required', description: '休眠指定工作区' }
}

/** 统一注册表的第一个垂直切片；其它领域服务以后按同样方式注册。 */
export class WorkspaceActionRegistry {
  private readonly tasks = new TaskService()

  constructor(
    private readonly workspaces: WorkspaceService,
    private readonly runtime: WorkspaceActionRuntime
  ) {}

  catalog(): ActionCatalog {
    return { actions: Object.values(DESCRIPTORS).map((item) => ({ ...item })) }
  }

  cancel(taskId: string) {
    return this.tasks.cancel(taskId)
  }

  async execute(request: ActionRequest): Promise<ActionResult> {
    const descriptor = DESCRIPTORS[request.action as WorkspaceAction]
    if (!descriptor) throw new ActionError(`未注册的动作：${request.action}`, 'invalid_action')
    this.resolveTarget(descriptor, request.target)
    return this.tasks.execute(request, async (input, context) => {
      if (context.signal.aborted) throw new ActionError('任务已取消', 'task_canceled')
      switch (request.action as WorkspaceAction) {
        case 'workspaces.list':
          return this.workspaces.overview()
        case 'workspace.create':
          return this.runtime.create(input as WorkspaceCreateInput)
        case 'workspace.open':
          return this.runtime.open((request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId)
        case 'workspace.suspend':
          return this.runtime.suspend((request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId)
      }
    })
  }

  private resolveTarget(descriptor: ActionDescriptor, target: TargetRef | undefined): void {
    if (descriptor.target === 'required' && !target) throw new ActionError(`动作 ${descriptor.name} 必须提供 TargetRef`, 'target_required')
    if (!target) return
    if (descriptor.name === 'workspace.create') {
      if (target.kind !== 'workspace-collection') throw new ActionError('创建工作区的目标必须是 workspace-collection', 'target_invalid')
      return
    }
    if (descriptor.name === 'workspaces.list') {
      if (target.kind !== 'workspace-collection' && target.kind !== 'workspace') throw new ActionError('查询工作区只接受工作区范围目标', 'target_invalid')
      return
    }
    if (target.kind !== 'workspace') throw new ActionError(`动作 ${descriptor.name} 必须指定 workspace 目标`, 'target_invalid')
    const workspace = this.workspaces.get(target.workspaceId)
    if (target.expectedVersion !== undefined && target.expectedVersion !== workspace.version) {
      throw new ActionError(`工作区目标已过期：期望版本 ${target.expectedVersion}，当前为 ${workspace.version}`, 'target_stale')
    }
  }
}
