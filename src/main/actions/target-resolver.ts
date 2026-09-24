import { ActionError, type ActionDescriptor, type TargetRef } from '../../shared/contracts/action'
import type { WorkspaceService } from '../workspace/service'

/** 把声明式 TargetRef 校验为当前真实实体；不会回退到活动工作区。 */
export class WorkspaceTargetResolver {
  constructor(private readonly workspaces: WorkspaceService) {}

  resolve(descriptor: ActionDescriptor, target: TargetRef | undefined): void {
    if (!target) return
    if (descriptor.name === 'workspace.create') {
      if (target.kind !== 'workspace-collection') throw new ActionError('创建工作区的目标必须是 workspace-collection', 'target_invalid')
      return
    }
    if (descriptor.name === 'workspaces.list' || descriptor.name === 'workspaces.contentStats') {
      if (target.kind !== 'workspace-collection' && target.kind !== 'workspace') throw new ActionError('查询工作区只接受工作区范围目标', 'target_invalid')
      return
    }
    const isBrowserObject = descriptor.name.startsWith('browser.') || descriptor.name.startsWith('tab.')
    if (target.kind === 'workspace-collection') throw new ActionError(`动作 ${descriptor.name} 不能以工作区集合为目标`, 'target_invalid')
    if (isBrowserObject && target.kind !== 'workspace' && target.kind !== 'tab' && target.kind !== 'browser') {
      throw new ActionError(`动作 ${descriptor.name} 必须指定 browser/tab 目标`, 'target_invalid')
    }
    if (!isBrowserObject && target.kind !== 'workspace') throw new ActionError(`动作 ${descriptor.name} 必须指定 workspace 目标`, 'target_invalid')
    const workspace = this.workspaces.get(target.workspaceId)
    if (target.kind === 'workspace' && target.expectedVersion !== undefined && target.expectedVersion !== workspace.version) {
      throw new ActionError(`工作区目标已过期：期望版本 ${target.expectedVersion}，当前为 ${workspace.version}`, 'target_stale')
    }
  }
}
