import { useEffect, useState } from 'react'
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
  const [statsTick, setStatsTick] = useState(0)
  const [contentStats, setContentStats] = useState<Record<string, { objects: number; bytes: number; gaps: number; lastError?: string; recovered: number; recoveryFailed: number }>>({})
  const [authRows, setAuthRows] = useState<Array<{ origin: string; state: string; account_label: string | null; observed_at: number; source: string }>>([])
  const [extensions, setExtensions] = useState<{ scan: { observed_at: number; reason: string } | null; items: Array<{ extensionId: string; state: string; reasons: string[]; observed: { name: string; version: string | null } | null }> } | null>(null)

  useEffect(() => {
    const id = overview?.activeWorkspaceId
    if (!id) { setExtensions(null); return }
    setExtensions(null)
    let alive = true
    const refresh = (): void => { void window.monitor.executeAction({ action: 'extensions.summary', input: {}, target: { kind: 'workspace', workspaceId: id } })
      .then(result => { if (alive && result.output) setExtensions(result.output as typeof extensions) })
      .catch(() => undefined) }
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => { alive = false; clearInterval(timer) }
  }, [overview?.activeWorkspaceId, statsTick])

  useEffect(() => {
    const id = overview?.activeWorkspaceId
    if (!id) { setAuthRows([]); return }
    let alive = true
    const refresh = (): void => { void window.monitor.executeAction({ action: 'auth.summary', input: {}, target: { kind: 'workspace', workspaceId: id } })
      .then(result => { if (alive) setAuthRows(Array.isArray(result.output) ? result.output as typeof authRows : []) })
      .catch(() => { if (alive) setAuthRows([]) }) }
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => { alive = false; clearInterval(timer) }
  }, [overview?.activeWorkspaceId, statsTick])

  useEffect(() => {
    if (!overview) return
    let alive = true
    const refresh = (): void => { void window.monitor.executeAction({ action: 'workspaces.contentStats', input: {}, target: { kind: 'workspace-collection' } }).then((result) => {
      if (!alive || !Array.isArray(result.output)) return
      const next: Record<string, { objects: number; bytes: number; gaps: number; lastError?: string; recovered: number; recoveryFailed: number }> = {}
      for (const entry of result.output as Array<{ workspaceId: string; content: { objects: number; bytes: number }; capture: { gaps: number; lastError?: string; recovery?: { committed: number; cancelled: number; failed: number } } }>) {
        next[entry.workspaceId] = { objects: entry.content.objects, bytes: entry.content.bytes, gaps: entry.capture.gaps, lastError: entry.capture.lastError,
          recovered: (entry.capture.recovery?.committed ?? 0) + (entry.capture.recovery?.cancelled ?? 0), recoveryFailed: entry.capture.recovery?.failed ?? 0 }
      }
      setContentStats(next)
    }).catch(() => undefined) }
    refresh()
    return () => { alive = false }
  }, [overview?.activeWorkspaceId, overview?.workspaces.length, statsTick])

  if (!overview) return null
  const active = overview.workspaces.find((workspace) => workspace.id === overview.activeWorkspaceId) ?? null

  const open = async (id: string): Promise<void> => {
    if (busy || id === overview.activeWorkspaceId && active?.state === 'running') return
    setBusy(true)
    setError(null)
    try {
      const result = await window.monitor.openWorkspace(id)
      if (!result.output) throw new Error(result.task.error?.message ?? '打开工作区没有返回结果')
      onChange(result.output)
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
      const created = await window.monitor.createWorkspace({ name, profile })
      if (!created.output) throw new Error(created.task.error?.message ?? '创建工作区没有返回结果')
      const opened = await window.monitor.openWorkspace(created.output.id)
      if (!opened.output) throw new Error(opened.task.error?.message ?? '打开工作区没有返回结果')
      onChange(opened.output)
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
      const result = await window.monitor.suspendWorkspace(active.id)
      if (!result.output) throw new Error(result.task.error?.message ?? '休眠工作区没有返回结果')
      onChange(result.output)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const verifyFixture = async (): Promise<void> => {
    if (!active) return
    const origin = window.prompt('受控本地站点 origin（例如 http://127.0.0.1:8841/）')?.trim()
    if (!origin) return
    setBusy(true); setError(null)
    try {
      const result = await window.monitor.executeAction({ action: 'auth.verifyFixture', input: { origin }, target: { kind: 'workspace', workspaceId: active.id } })
      if (result.task.error) throw new Error(result.task.error.message)
      setStatsTick(value => value + 1)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
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
      <button type="button" className="workspace-suspend" title="刷新各工作区正文与缺口统计" onClick={() => setStatsTick((value) => value + 1)}>刷新统计</button>
      {active?.state === 'running' && <details className="workspace-evidence">
        <summary title="登录、扩展和正文采集证据">证据</summary>
        <div className="workspace-evidence-popover">
          <div className="workspace-auth" aria-label="正文采集摘要">
            <span>正文：</span>
            <small>{contentStats[active.id] ? `${contentStats[active.id].objects} 对象 · ${Math.round(contentStats[active.id].bytes / 1024)} KiB · 缺口 ${contentStats[active.id].gaps} · 恢复 ${contentStats[active.id].recovered}${contentStats[active.id].recoveryFailed ? ` · 恢复失败 ${contentStats[active.id].recoveryFailed}` : ''}` : '正在读取统计'}</small>
          </div>
          <div className="workspace-auth" aria-label="登录证据台账">
            <span>登录：</span>
            {authRows.length ? authRows.slice(0, 3).map(row => <small key={row.origin} title={`${row.origin} · ${row.source} · ${new Date(row.observed_at).toLocaleString()}`}>
              {new URL(row.origin).host} · {row.state === 'verified' ? `已验证 ${row.account_label ?? ''}` : row.state === 'suspected' ? '有线索，未验证' : row.state === 'stale' ? '待复核' : row.state === 'logged_out' ? '已登出' : '未知'}
            </small>) : <small>未验证</small>}
            <button type="button" disabled={busy} onClick={() => void verifyFixture()}>验证受控站点</button>
          </div>
          <div className="workspace-auth" aria-label="扩展状态">
            <span>扩展：</span>
            {extensions?.items.length ? extensions.items.slice(0, 3).map(item => <small key={item.extensionId}
              title={`${item.extensionId} · ${item.reasons.join(', ') || '已观察'} · ${extensions.scan ? new Date(extensions.scan.observed_at).toLocaleString() : '未核对'}`}>
              {item.observed?.name ?? item.extensionId.slice(0, 8)} {item.observed?.version ?? ''} · {item.state === 'drift' ? '漂移' : item.state === 'unknown' ? '未知' : item.state === 'aligned' ? '一致' : '仅观察'}
            </small>) : <small title={extensions?.scan?.reason ?? '尚未扫描'}>未知（Profile 部分观察）</small>}
          </div>
        </div>
      </details>}
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
