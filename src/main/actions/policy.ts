import { ActionError, type ActionDescriptor, type TargetRef } from '../../shared/contracts/action'

/**
 * 最小策略门：这里不依赖当前 UI 焦点，也不做隐式目标补全。
 * 授权、危险动作确认和版本守卫会在后续任务继续叠加到同一边界。
 */
export class ActionPolicy {
  assertAllowed(descriptor: ActionDescriptor, target: TargetRef | undefined): void {
    if (descriptor.target === 'required' && !target) {
      throw new ActionError(`动作 ${descriptor.name} 必须提供 TargetRef`, 'target_required')
    }
    if (descriptor.target === 'none' && target) {
      throw new ActionError(`动作 ${descriptor.name} 不接受 TargetRef`, 'target_invalid')
    }
  }
}
