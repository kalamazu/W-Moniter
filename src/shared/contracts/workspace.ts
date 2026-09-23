/**
 * 工作区是浏览器状态、采集历史和自动化任务的归属边界。
 *
 * 这里刻意不包含本地绝对路径、Cookie 值或浏览器进程句柄：这些是运行期秘密，
 * 不能随着 IPC / HTTP 摘要泄露给 UI 或 Agent。
 */
export type WorkspaceLifecycleState =
  | 'creating'
  | 'closed'
  | 'opening'
  | 'running'
  | 'checkpointing'
  | 'suspended'
  | 'recovering'
  | 'error'
  | 'archived'

export interface WorkspaceSummary {
  id: string
  name: string
  /** 浏览器采集能力配置；不是 Chromium user-data-dir。 */
  profile: 'L' | 'H'
  state: WorkspaceLifecycleState
  /** 乐观并发和状态转换使用的领域版本。 */
  version: number
  createdAt: number
  updatedAt: number
  lastOpenedAt?: number
  error?: string
  /** 首次升级前已经存在的数据目录，只读迁入，不移动用户数据。 */
  legacy?: boolean
}

export interface WorkspaceOverview {
  activeWorkspaceId: string
  workspaces: WorkspaceSummary[]
}

export interface WorkspaceCreateInput {
  name: string
  profile?: 'L' | 'H'
}

