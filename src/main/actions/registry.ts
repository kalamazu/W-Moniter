import { ActionError, type ActionCatalog, type ActionDescriptor, type ActionRequest, type ActionResult, type TargetRef } from '../../shared/contracts/action'
import type { WorkspaceCreateInput, WorkspaceOverview, WorkspaceSummary } from '../../shared/contracts/workspace'
import type { WorkspaceService } from '../workspace/service'
import type { RuleSet, SiteStateBundle } from '../../shared/types'
import { ContentStore } from '../content/store'
import { CaptureEvidenceLedger } from '../content/evidence'
import { ContentGovernance } from '../content/governance'
import { EnvironmentRepository, type EnvironmentConfig } from '../environment/repository'
import { dirname, join } from 'node:path'
import { ActionPolicy } from './policy'
import { TaskService, type TaskJournalDiagnostics } from './task-service'
import { WorkspaceTargetResolver } from './target-resolver'

type WorkspaceAction = 'workspaces.list' | 'workspace.create' | 'workspace.open' | 'workspace.suspend' | 'workspace.history' | 'workspace.cockpit' | 'workspace.checkpointCreate' | 'workspace.checkpointList' | 'workspace.checkpointRestore' | 'tasks.diagnostics' | 'rules.get' | 'rules.save' | 'content.verify' | 'content.readRange' | 'content.inspect' | 'content.pin' | 'content.unpin' | 'content.policySet' | 'content.gc' | 'content.revoke' | 'capture.evidence' | 'capture.summary' | 'workspaces.contentStats' | 'environment.get' | 'environment.save' | 'environment.apply' | 'environment.rollback' | 'environment.diagnose' | 'site.stateExport' | 'site.stateRestore' | 'auth.summary' | 'auth.verifyFixture' | 'extensions.summary' | 'extensions.setDesired'

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
  exportSiteState(id: string, origins?: string[]): Promise<unknown>
  restoreSiteState(id: string, bundle: SiteStateBundle, options: { areas?: Array<'cookies' | 'localStorage' | 'sessionStorage'>; replace?: boolean }): Promise<unknown>
}

const DESCRIPTORS: Record<WorkspaceAction, ActionDescriptor> = {
  'workspaces.list': { name: 'workspaces.list', kind: 'query', target: 'optional', description: '列出工作区及活动焦点' },
  'workspace.create': { name: 'workspace.create', kind: 'mutation', target: 'required', description: '创建持久工作区' },
  'workspace.open': { name: 'workspace.open', kind: 'mutation', target: 'required', description: '打开或聚焦工作区' },
  'workspace.suspend': { name: 'workspace.suspend', kind: 'mutation', target: 'required', description: '休眠指定工作区' },
  'workspace.history': { name: 'workspace.history', kind: 'query', target: 'required', description: '读取工作区状态时间线' },
  'workspace.cockpit': { name: 'workspace.cockpit', kind: 'query', target: 'required', description: '聚合工作区身份、扩展、正文、检查点和历史' },
  'workspace.checkpointCreate': { name: 'workspace.checkpointCreate', kind: 'mutation', target: 'required', description: '为 suspended 工作区创建可校验检查点' },
  'workspace.checkpointList': { name: 'workspace.checkpointList', kind: 'query', target: 'required', description: '列出工作区检查点' },
  'workspace.checkpointRestore': { name: 'workspace.checkpointRestore', kind: 'mutation', target: 'required', description: '冷恢复检查点并保留恢复前备份' },
  'tasks.diagnostics': { name: 'tasks.diagnostics', kind: 'query', target: 'none', description: '任务日志恢复与损坏诊断' },
  'rules.get': { name: 'rules.get', kind: 'query', target: 'required', description: '读取指定工作区规则' },
  'rules.save': { name: 'rules.save', kind: 'mutation', target: 'required', description: '保存指定工作区规则' },
  'content.verify': { name: 'content.verify', kind: 'query', target: 'required', description: '校验内容 hash 与所有块' },
  'content.readRange': { name: 'content.readRange', kind: 'query', target: 'required', description: '按字节范围读取内容' },
  'content.inspect': { name: 'content.inspect', kind: 'query', target: 'required', description: '枚举正文、固定、配额与删除审计' },
  'content.pin': { name: 'content.pin', kind: 'mutation', target: 'required', description: '固定正文，阻止保留策略删除' },
  'content.unpin': { name: 'content.unpin', kind: 'mutation', target: 'required', description: '取消正文固定' },
  'content.policySet': { name: 'content.policySet', kind: 'mutation', target: 'required', description: '更新正文配额、宽限期与敏感预览策略' },
  'content.gc': { name: 'content.gc', kind: 'mutation', target: 'required', description: '按配额、宽限期和固定状态执行保守 GC' },
  'content.revoke': { name: 'content.revoke', kind: 'mutation', target: 'required', description: '删除正文并记录保留策略证据' },
  'capture.evidence': { name: 'capture.evidence', kind: 'query', target: 'required', description: '读取请求正文采集证据' },
  'capture.summary': { name: 'capture.summary', kind: 'query', target: 'required', description: '统计工作区采集缺口' },
  'workspaces.contentStats': { name: 'workspaces.contentStats', kind: 'query', target: 'optional', description: '全部工作区的内容与缺口摘要' },
  'environment.get': { name: 'environment.get', kind: 'query', target: 'required', description: '读取工作区版本化网络环境' },
  'environment.save': { name: 'environment.save', kind: 'mutation', target: 'required', description: '保存网络环境新版本，仅接受 SecretRef' },
  'environment.apply': { name: 'environment.apply', kind: 'mutation', target: 'required', description: '应用网络环境版本并标记待重启' },
  'environment.rollback': { name: 'environment.rollback', kind: 'mutation', target: 'required', description: '回滚到指定网络环境版本' },
  'environment.diagnose': { name: 'environment.diagnose', kind: 'query', target: 'required', description: '执行 DNS 与上游 TCP 诊断' },
  'site.stateExport': { name: 'site.stateExport', kind: 'query', target: 'required', description: '导出 Cookie、DOM Storage 与 IDB/Cache/SW 清单' },
  'site.stateRestore': { name: 'site.stateRestore', kind: 'mutation', target: 'required', description: '选择性恢复站点状态并进行浏览器读回验证' },
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
        case 'workspace.history':
          return this.workspaces.history((request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId, Number((input as { limit?: number }).limit ?? 100))
        case 'workspace.cockpit': {
          const id = (request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId
          const contentDir = this.workspaces.pathsFor(id).contentDir
          const settled = await Promise.allSettled([this.runtime.getAuth(id), this.runtime.getExtensions(id)])
          return {
            workspace: this.workspaces.get(id),
            history: this.workspaces.history(id, 50),
            checkpoints: this.workspaces.listCheckpoints(id),
            content: await new ContentStore(contentDir).stats(),
            capture: await new CaptureEvidenceLedger(contentDir).summary(),
            auth: settled[0].status === 'fulfilled' ? settled[0].value : { unavailable: settled[0].reason instanceof Error ? settled[0].reason.message : String(settled[0].reason) },
            extensions: settled[1].status === 'fulfilled' ? settled[1].value : { unavailable: settled[1].reason instanceof Error ? settled[1].reason.message : String(settled[1].reason) }
          }
        }
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
        case 'content.inspect': {
          const id = (request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId
          return new ContentGovernance(this.workspaces.pathsFor(id).contentDir).inspect()
        }
        case 'content.pin': {
          const id = (request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId
          const { hash, reason } = input as { hash: string; reason?: string }
          const exists = await new ContentStore(this.workspaces.pathsFor(id).contentDir).verify(hash)
          if (!exists.valid) throw new ActionError('只能固定存在且完整的正文', 'invalid_action')
          return new ContentGovernance(this.workspaces.pathsFor(id).contentDir).pin(hash, reason ?? 'manual')
        }
        case 'content.unpin': {
          const id = (request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId
          return new ContentGovernance(this.workspaces.pathsFor(id).contentDir).unpin(String((input as { hash?: string }).hash ?? ''))
        }
        case 'content.policySet': {
          const id = (request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId
          return new ContentGovernance(this.workspaces.pathsFor(id).contentDir).setPolicy(input as never)
        }
        case 'content.gc': {
          const id = (request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId
          const path = this.workspaces.pathsFor(id).contentDir
          const governance = new ContentGovernance(path)
          const snapshot = await governance.inspect()
          let bytes = snapshot.usage.bytes
          const deleted: string[] = []
          const skipped: Array<{ hash: string; reason: string }> = []
          if (bytes <= snapshot.policy.quotaBytes) return { beforeBytes: bytes, afterBytes: bytes, deleted, skipped }
          for (const object of [...snapshot.objects].sort((a, b) => a.modifiedAt - b.modifiedAt)) {
            if (bytes <= snapshot.policy.quotaBytes) break
            if (governance.isPinned(object.hash)) { skipped.push({ hash: object.hash, reason: 'pinned' }); continue }
            if (Date.now() - object.modifiedAt < snapshot.policy.graceMs) { skipped.push({ hash: object.hash, reason: 'grace' }); continue }
            try {
              await this.runtime.revokeContent(id, object.hash, 'quota_gc')
              governance.recordDeletion(object.hash, 'quota_gc')
              deleted.push(object.hash); bytes -= object.size
            } catch (error) { skipped.push({ hash: object.hash, reason: error instanceof Error ? error.message : String(error) }) }
          }
          return { beforeBytes: snapshot.usage.bytes, afterBytes: bytes, deleted, skipped, quotaSatisfied: bytes <= snapshot.policy.quotaBytes }
        }
        case 'content.revoke': {
          const id = (request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId
          const { hash, reason } = input as { hash: string; reason: string }
          const governance = new ContentGovernance(this.workspaces.pathsFor(id).contentDir)
          if (governance.isPinned(hash)) throw new ActionError('正文已固定；先显式取消固定', 'invalid_action')
          const result = await this.runtime.revokeContent(id, hash, reason)
          governance.recordDeletion(hash, reason || 'manual revoke')
          return result
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
        case 'environment.get': {
          const id = (request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId
          return this.environment(id).get()
        }
        case 'environment.save': {
          const id = (request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId
          return this.environment(id).save(input as Omit<EnvironmentConfig, 'version' | 'createdAt'>)
        }
        case 'environment.apply': {
          const id = (request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId
          const version = (input as { version?: number }).version
          return version === undefined ? this.environment(id).apply() : this.environment(id).apply(Number(version))
        }
        case 'environment.rollback': {
          const id = (request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId
          return this.environment(id).rollback(Number((input as { version: number }).version))
        }
        case 'environment.diagnose': {
          const id = (request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId
          const version = (input as { version?: number }).version
          return version === undefined ? this.environment(id).diagnose() : this.environment(id).diagnose(Number(version))
        }
        case 'site.stateExport': {
          const id = (request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId
          return this.runtime.exportSiteState(id, (input as { origins?: string[] }).origins)
        }
        case 'site.stateRestore': {
          const id = (request.target as Extract<TargetRef, { kind: 'workspace' }>).workspaceId
          const payload = input as { bundle: SiteStateBundle; areas?: Array<'cookies' | 'localStorage' | 'sessionStorage'>; replace?: boolean }
          return this.runtime.restoreSiteState(id, payload.bundle, { areas: payload.areas, replace: payload.replace })
        }
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

  private environment(id: string): EnvironmentRepository {
    const paths = this.workspaces.pathsFor(id)
    return new EnvironmentRepository(join(dirname(paths.uiSettingsPath), 'environment.json'))
  }

}
