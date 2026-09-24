import { ActionError, type ActionCatalog, type ActionDescriptor, type ActionRequest, type ActionResult, type TargetRef } from '../../shared/contracts/action'
import type { WorkspaceCreateInput, WorkspaceOverview, WorkspaceSummary } from '../../shared/contracts/workspace'
import type { WorkspaceService } from '../workspace/service'
import type { RuleSet } from '../../shared/types'
import { ContentStore } from '../content/store'
import { CaptureEvidenceLedger } from '../content/evidence'
import { ActionPolicy } from './policy'
import { TaskService, type TaskJournalDiagnostics } from './task-service'
import { WorkspaceTargetResolver } from './target-resolver'

type WorkspaceAction = 'workspaces.list' | 'workspace.create' | 'workspace.open' | 'workspace.suspend' | 'workspace.checkpointCreate' | 'workspace.checkpointList' | 'workspace.checkpointRestore' | 'tasks.diagnostics' | 'rules.get' | 'rules.save' | 'content.verify' | 'content.readRange' | 'content.revoke' | 'capture.evidence' | 'capture.summary' | 'workspaces.contentStats' | 'auth.summary' | 'auth.verifyFixture' | 'extensions.summary' | 'extensions.setDesired'

export interface WorkspaceActionRuntime {
  create(input: WorkspaceCreateInput): WorkspaceSummary
  open(id: string): Promise<WorkspaceOverview>
  suspend(id: string): Promise<WorkspaceOverview>
  getRules(id: string): RuleSet
  saveRules(id: string, set: RuleSet): { ok: boolean; invalid: unknown[] }
  getEvidence(id: string, seq: number): Promise<unknown>
  revokeContent(id: string, hash: string, reason: string): Promise<unknown>
  getAuth(id: string): Promise<unknown>
  verifyAuth(id: string, origin: string): Promise<unknown>
  getExtensions(id: string): Promise<unknown>
  setExtensionDesired(id: string, input: { extensionId: string; version?: string; permissions?: string[] }): Promise<unknown>
}

const DESCRIPTORS: Record<WorkspaceAction, ActionDescriptor> = {
  'workspaces.list': { name: 'workspaces.list', kind: 'query', target: 'optional', description: '列出工作区及活动焦点' },
  'workspace.create': { name: 'workspace.create', kind: 'mutation', target: 'required', description: '创建持久工作区' },
  'workspace.open': { name: 'workspace.open', kind: 'mutation', target: 'required', description: '打开或聚焦工作区' },
  'workspace.suspend': { name: 'workspace.suspend', kind: 'mutation', target: 'required', description: '休眠指定工作区' },
  'workspace.checkpointCreate': { name: 'workspace.checkpointCreate', kind: 'mutation', target: 'required', description: '为 suspended 工作区创建可校验检查点' },
  'workspace.checkpointList': { name: 'workspace.checkpointList', kind: 'query', target: 'required', description: '列出工作区检查点' },
  'workspace.checkpointRestore': { name: 'workspace.checkpointRestore', kind: 'mutation', target: 'required', description: '冷恢复检查点并保留恢复前备份' },
  'tasks.diagnostics': { name: 'tasks.diagnostics', kind: 'query', target: 'none', description: '任务日志恢复与损坏诊断' },
  'rules.get': { name: 'rules.get', kind: 'query', target: 'required', description: '读取指定工作区规则' },
  'rules.save': { name: 'rules.save', kind: 'mutation', target: 'required', description: '保存指定工作区规则' },
  'content.verify': { name: 'content.verify', kind: 'query', target: 'required', description: '校验内容 hash 与所有块' },
  'content.readRange': { name: 'content.readRange', kind: 'query', target: 'required', description: '按字节范围读取内容' },
  'content.revoke': { name: 'content.revoke', kind: 'mutation', target: 'required', description: '删除正文并记录保留策略证据' },
  'capture.evidence': { name: 'capture.evidence', kind: 'query', target: 'required', description: '读取请求正文采集证据' },
  'capture.summary': { name: 'capture.summary', kind: 'query', target: 'required', description: '统计工作区采集缺口' },
  'workspaces.contentStats': { name: 'workspaces.contentStats', kind: 'query', target: 'optional', description: '全部工作区的内容与缺口摘要' },
  'auth.summary': { name: 'auth.summary', kind: 'query', target: 'required', description: '读取指定工作区的登录证据摘要，不包含 Cookie 值' },
  'auth.verifyFixture': { name: 'auth.verifyFixture', kind: 'mutation', target: 'required', description: '在明确工作区对受控本地 fixture 主动验证身份' }
  ,'extensions.summary': { name: 'extensions.summary', kind: 'query', target: 'required', description: '读取工作区扩展观察与期望对账；Profile 快照不是完整枚举' }
  ,'extensions.setDesired': { name: 'extensions.setDesired', kind: 'mutation', target: 'required', description: '记录工作区扩展期望版本和权限，不安装或启停扩展' }
}

/** 统一注册表的第一个垂直切片；其它领域服务以后按同样方式注册。 */
export class WorkspaceActionRegistry {
  private readonly tasks: TaskService
  private readonly policy = new ActionPolicy()
  private readonly targets: WorkspaceTargetResolver

  constructor(
    private readonly workspaces: WorkspaceService,
    private readonly runtime: WorkspaceActionRuntime,
    options: { journalPath?: string } = {}
  ) {
    this.tasks = new TaskService(options)
    this.targets = new WorkspaceTargetResolver(workspaces)
  }

  catalog(): ActionCatalog {
    return { actions: Object.values(DESCRIPTORS).map((item) => ({ ...item })) }
  }

  cancel(taskId: string) {
    return this.tasks.cancel(taskId)
  }

  diagnostics(): TaskJournalDiagnostics { return this.tasks.diagnostics() }

  async execute(request: ActionRequest): Promise<ActionResult> {
    const descriptor = DESCRIPTORS[request.action as WorkspaceAction]
    if (!descriptor) throw new ActionError(`未注册的动作：${request.action}`, 'invalid_action')
    this.policy.assertAllowed(descriptor, request.target)
    this.targets.resolve(descriptor, request.target)
    return this.tasks.execute(request, async (input, context) => {
      if (context.signal.aborted) throw new ActionError('任务已取消', 'task_canceled')
      switch (request.action as WorkspaceAction) {
        case 'workspaces.list':
          return this.workspaces.overview()
        case 'tasks.diagnostics':
          return this.tasks.diagnostics()
        case 'workspace.create':
          return this.runtime.create(input as WorkspaceCreateInput)
        case 'workspace.open':
          return this.runtime.open((request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId)
        case 'workspace.suspend':
          return this.runtime.suspend((request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId)
        case 'workspace.checkpointCreate': {
          const id = (request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId
          return this.workspaces.createCheckpoint(id, (input as { label?: string }).label)
        }
        case 'workspace.checkpointList':
          return this.workspaces.listCheckpoints((request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId)
        case 'workspace.checkpointRestore': {
          const id = (request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId
          return this.workspaces.restoreCheckpoint(id, String((input as { checkpointId?: string }).checkpointId ?? ''))
        }
        case 'rules.get':
          return this.runtime.getRules((request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId)
        case 'rules.save':
          return this.runtime.saveRules((request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId, (input as { set: RuleSet }).set)
        case 'content.verify': {
          const id = (request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId
          return new ContentStore(this.workspaces.pathsFor(id).contentDir).verify((input as { hash: string }).hash)
        }
        case 'content.readRange': {
          const id = (request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId
          const { hash, start, end } = input as { hash: string; start: number; end: number }
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start > 1024 * 1024) {
            throw new ActionError('读取范围必须是至多 1MiB 的有效字节区间', 'invalid_action')
          }
          const bytes = await new ContentStore(this.workspaces.pathsFor(id).contentDir).get(hash, start, end)
          return bytes ? { hash, start, end, size: bytes.length, b64: Buffer.from(bytes).toString('base64') } : null
        }
        case 'content.revoke': {
          const id = (request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId
          const { hash, reason } = input as { hash: string; reason: string }
          return this.runtime.revokeContent(id, hash, reason)
        }
        case 'capture.evidence': {
          const id = (request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId
          return this.runtime.getEvidence(id, Number((input as { seq: number }).seq))
        }
        case 'capture.summary': {
          const id = (request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId
          return new CaptureEvidenceLedger(this.workspaces.pathsFor(id).contentDir).summary()
        }
        case 'workspaces.contentStats':
          return Promise.all(this.workspaces.overview().workspaces.map(async (workspace) => {
            const path = this.workspaces.pathsFor(workspace.id).contentDir
            const [content, capture] = await Promise.all([new ContentStore(path).stats(), new CaptureEvidenceLedger(path).summary()])
            return { workspaceId: workspace.id, name: workspace.name, content, capture }
          }))
        case 'auth.summary':
          return this.runtime.getAuth((request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId)
        case 'auth.verifyFixture':
          return this.runtime.verifyAuth((request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId,
            String((input as { origin?: string }).origin ?? ''))
        case 'extensions.summary':
          return this.runtime.getExtensions((request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId)
        case 'extensions.setDesired':
          return this.runtime.setExtensionDesired((request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId,
            input as { extensionId: string; version?: string; permissions?: string[] })
      }
    })
  }

}
