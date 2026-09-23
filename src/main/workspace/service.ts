import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  WorkspaceCreateInput,
  WorkspaceLifecycleState,
  WorkspaceOverview,
  WorkspaceSummary
} from '../../shared/contracts/workspace'
import { assertTransition } from './machine'

interface WorkspaceStore {
  schemaVersion: 1
  activeWorkspaceId: string
  workspaces: WorkspaceSummary[]
}

export interface WorkspaceRuntimePaths {
  profileDir: string
  dbPath: string
  downloadDir: string
  rulesPath: string
  uiSettingsPath: string
}

interface WorkspaceServiceOptions {
  dataDir: string
  legacy: WorkspaceRuntimePaths
  defaultProfile: 'L' | 'H'
}

/**
 * M0 的工作区目录账本。
 *
 * 先把“谁拥有哪份浏览器资料”从单例 Controller 中抽出来。正文、任务和登录
 * 台账迁入 SQLite 是后续迁移；在那之前，新工作区使用各自的 SQLite 文件，避免
 * 继续往全局 cookies/site_origins 主键里混入多身份数据。
 */
export class WorkspaceService {
  private readonly rootDir: string
  private readonly indexPath: string
  private readonly legacy: WorkspaceRuntimePaths
  private readonly defaultProfile: 'L' | 'H'
  private store: WorkspaceStore | null = null

  constructor(options: WorkspaceServiceOptions) {
    this.rootDir = join(options.dataDir, 'workspaces')
    this.indexPath = join(this.rootDir, 'index.json')
    this.legacy = options.legacy
    this.defaultProfile = options.defaultProfile
  }

  initialize(): WorkspaceOverview {
    if (this.store) return this.overview()
    mkdirSync(this.rootDir, { recursive: true })

    if (existsSync(this.indexPath)) {
      this.store = this.readStore()
      this.recoverInterruptedStates()
      return this.overview()
    }

    const now = Date.now()
    const initial: WorkspaceSummary = {
      id: 'default',
      name: '默认工作区',
      profile: this.defaultProfile,
      state: 'closed',
      version: 1,
      createdAt: now,
      updatedAt: now,
      legacy: true
    }
    this.store = { schemaVersion: 1, activeWorkspaceId: initial.id, workspaces: [initial] }
    this.persist()
    return this.overview()
  }

  overview(): WorkspaceOverview {
    const store = this.requireStore()
    return {
      activeWorkspaceId: store.activeWorkspaceId,
      workspaces: [...store.workspaces]
        .sort((a, b) => (b.lastOpenedAt ?? b.updatedAt) - (a.lastOpenedAt ?? a.updatedAt))
        .map((workspace) => ({ ...workspace }))
    }
  }

  active(): WorkspaceSummary {
    const store = this.requireStore()
    return this.get(store.activeWorkspaceId)
  }

  get(id: string): WorkspaceSummary {
    const workspace = this.requireStore().workspaces.find((item) => item.id === id)
    if (!workspace) throw new Error(`找不到工作区：${id}`)
    return { ...workspace }
  }

  create(input: WorkspaceCreateInput): WorkspaceSummary {
    const name = input.name.trim()
    if (!name || name.length > 80) throw new Error('工作区名称需要是 1–80 个字符')
    const store = this.requireStore()
    if (store.workspaces.some((item) => item.name === name && item.state !== 'archived')) {
      throw new Error(`已存在名为“${name}”的工作区`)
    }

    const now = Date.now()
    const workspace: WorkspaceSummary = {
      id: `ws_${randomUUID()}`,
      name,
      profile: input.profile ?? this.defaultProfile,
      state: 'closed',
      version: 1,
      createdAt: now,
      updatedAt: now
    }
    mkdirSync(join(this.rootDir, workspace.id), { recursive: true })
    store.workspaces.push(workspace)
    this.persist()
    return { ...workspace }
  }

  /** 记录新的活动对象，并在启动浏览器之前进入 opening。 */
  beginOpen(id: string): WorkspaceSummary {
    const store = this.requireStore()
    const workspace = this.findMutable(id)
    if (workspace.state === 'archived') throw new Error('已归档工作区不能直接打开')
    this.transition(workspace, 'opening')
    workspace.lastOpenedAt = Date.now()
    store.activeWorkspaceId = workspace.id
    this.persist()
    return { ...workspace }
  }

  /** 仅改变控制台焦点；已运行的浏览器不因 UI 切换而停止。 */
  select(id: string): WorkspaceSummary {
    const store = this.requireStore()
    const workspace = this.findMutable(id)
    if (workspace.state === 'archived') throw new Error('已归档工作区不能作为活动工作区')
    if (store.activeWorkspaceId !== id) {
      store.activeWorkspaceId = id
      this.persist()
    }
    return { ...workspace }
  }

  markRunning(id: string): WorkspaceSummary {
    return this.updateState(id, 'running')
  }

  markSuspended(id: string): WorkspaceSummary {
    const workspace = this.findMutable(id)
    if (workspace.state === 'closed' || workspace.state === 'suspended') return { ...workspace }
    if (workspace.state === 'opening' || workspace.state === 'recovering') return this.updateState(id, 'closed')
    return this.updateState(id, 'suspended')
  }

  markError(id: string, error: string): WorkspaceSummary {
    const workspace = this.findMutable(id)
    const nextError = error.slice(0, 1000)
    if (workspace.state === 'error' && workspace.error === nextError) return { ...workspace }
    if (workspace.state !== 'error') this.transition(workspace, 'error')
    workspace.error = nextError
    workspace.updatedAt = Date.now()
    workspace.version += 1
    this.persist()
    return { ...workspace }
  }

  /** Profile 是工作区期望状态的一部分；旧的切换入口成功后也必须同步它。 */
  setProfile(id: string, profile: 'L' | 'H'): WorkspaceSummary {
    const workspace = this.findMutable(id)
    if (workspace.profile === profile) return { ...workspace }
    workspace.profile = profile
    workspace.updatedAt = Date.now()
    workspace.version += 1
    this.persist()
    return { ...workspace }
  }

  pathsFor(id: string): WorkspaceRuntimePaths {
    const workspace = this.get(id)
    if (workspace.legacy) return { ...this.legacy }
    const workspaceDir = join(this.rootDir, workspace.id)
    return {
      profileDir: join(workspaceDir, 'browser-profile'),
      dbPath: join(workspaceDir, 'monitor.db'),
      downloadDir: join(workspaceDir, 'downloads'),
      rulesPath: join(workspaceDir, 'rules.json'),
      uiSettingsPath: join(workspaceDir, 'ui-settings.json')
    }
  }

  private updateState(id: string, next: WorkspaceLifecycleState): WorkspaceSummary {
    const workspace = this.findMutable(id)
    this.transition(workspace, next)
    if (next !== 'error') delete workspace.error
    this.persist()
    return { ...workspace }
  }

  private transition(workspace: WorkspaceSummary, next: WorkspaceLifecycleState): void {
    assertTransition(workspace.state, next)
    if (workspace.state === next) return
    workspace.state = next
    workspace.updatedAt = Date.now()
    workspace.version += 1
  }

  private findMutable(id: string): WorkspaceSummary {
    const workspace = this.requireStore().workspaces.find((item) => item.id === id)
    if (!workspace) throw new Error(`找不到工作区：${id}`)
    return workspace
  }

  private readStore(): WorkspaceStore {
    let value: unknown
    try {
      value = JSON.parse(readFileSync(this.indexPath, 'utf8'))
    } catch (error) {
      throw new Error(`无法读取工作区索引 ${this.indexPath}：${(error as Error).message}`)
    }
    if (!value || typeof value !== 'object') throw new Error('工作区索引格式错误')
    const store = value as Partial<WorkspaceStore>
    if (store.schemaVersion !== 1 || !Array.isArray(store.workspaces) || typeof store.activeWorkspaceId !== 'string') {
      throw new Error('工作区索引版本或字段不兼容')
    }
    if (!store.workspaces.some((workspace) => workspace?.id === store.activeWorkspaceId)) {
      throw new Error('工作区索引没有有效的活动工作区')
    }
    return store as WorkspaceStore
  }

  /** 崩溃时的 running/opening 不是“仍然被接管”，重启后如实降为 suspended。 */
  private recoverInterruptedStates(): void {
    const store = this.requireStore()
    let changed = false
    for (const workspace of store.workspaces) {
      if (workspace.state !== 'running' && workspace.state !== 'opening' && workspace.state !== 'checkpointing') continue
      workspace.state = 'suspended'
      workspace.updatedAt = Date.now()
      workspace.version += 1
      workspace.error = '上次运行未正常结束；需要重新打开浏览器。'
      changed = true
    }
    if (changed) this.persist()
  }

  private persist(): void {
    const store = this.requireStore()
    mkdirSync(dirname(this.indexPath), { recursive: true })
    const temporary = `${this.indexPath}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(store, null, 2) + '\n', 'utf8')
    renameSync(temporary, this.indexPath)
  }

  private requireStore(): WorkspaceStore {
    if (!this.store) throw new Error('WorkspaceService 尚未初始化')
    return this.store
  }
}
