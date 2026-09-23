import { useState } from 'react'
import type { WorkspaceOverview } from '../../../shared/contracts/workspace'

interface Props {
  overview: WorkspaceOverview | null
  onChange: (next: WorkspaceOverview) => void
}

const STATE_LABEL: Record<string, string> = {
  closed: '已关闭',
  opening: '打开中',
  running: '运行中',
  suspended: '已休眠',
  error: '异常',
  archived: '已归档',
  creating: '创建中',
  checkpointing: '检查点中',
  recovering: '恢复中'
}

/**
 * 工作区入口只做切换和创建。登录、扩展与检查点各自会成为独立工作台，不能把
 * 它们的状态塞进这个窄条里伪装成已经实现。
 */
export function WorkspaceBar({ overview, onChange }: Props): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [profile, setProfile] = useState<'L' | 'H'>('L')

  if (!overview) return null
  const active = overview.workspaces.find((workspace) => workspace.id === overview.activeWorkspaceId) ?? null

  const open = async (id: string): Promise<void> => {
    if (busy || id === overview.activeWorkspaceId && active?.state === 'running') return
    setBusy(true)
    setError(null)
    try {
      onChange(await window.monitor.openWorkspace(id))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const create = async (): Promise<void> => {
    const name = window.prompt('新工作区名称')?.trim()
    if (!name) return
    setBusy(true)
    setError(null)
    try {
      const workspace = await window.monitor.createWorkspace({ name, profile })
      onChange(await window.monitor.openWorkspace(workspace.id))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const suspend = async (): Promise<void> => {
    if (!active || busy || active.state !== 'running') return
    setBusy(true)
    setError(null)
    try {
      onChange(await window.monitor.suspendWorkspace(active.id))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="workspace-bar" aria-label="工作区">
      <span className="workspace-label">工作区</span>
      <div className="workspace-list">
        {overview.workspaces.map((workspace) => (
          <button
            key={workspace.id}
            type="button"
            className={`workspace-item${workspace.id === overview.activeWorkspaceId ? ' is-active' : ''}`}
            disabled={busy || workspace.state === 'archived'}
            title={workspace.error ?? `${workspace.name} · ${STATE_LABEL[workspace.state] ?? workspace.state}`}
            onClick={() => void open(workspace.id)}
          >
            <span>{workspace.name}</span>
            <small>{workspace.profile} · {STATE_LABEL[workspace.state] ?? workspace.state}</small>
          </button>
        ))}
      </div>
      <select
        className="workspace-profile"
        aria-label="新工作区采集 Profile"
        value={profile}
        disabled={busy}
        onChange={(event) => setProfile(event.target.value === 'H' ? 'H' : 'L')}
      >
        <option value="L">Profile L</option>
        <option value="H">Profile H</option>
      </select>
      <button type="button" className="workspace-new" disabled={busy} onClick={() => void create()}>
        + 新建
      </button>
      {active?.state === 'running' && (
        <button type="button" className="workspace-suspend" disabled={busy} onClick={() => void suspend()}>
          休眠
        </button>
      )}
      {error && <span className="workspace-error" role="alert">{error}</span>}
    </section>
  )
}

