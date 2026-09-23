import type { ControllerStatus, ControllerState } from '../../../shared/types'
import type { WorkspaceOverview } from '../../../shared/contracts/workspace'

interface Props { mode: 'runtime' | 'settings' | null; status: ControllerStatus | null; state: ControllerState; workspaces: WorkspaceOverview | null; onClose: () => void }

export function ContextDrawer({ mode, status, state, workspaces, onClose }: Props): React.JSX.Element | null {
  if (!mode) return null
  const active = workspaces?.workspaces.find((item) => item.id === workspaces.activeWorkspaceId)
  return <div className="drawer-scrim" role="presentation" onMouseDown={onClose}>
    <aside className="context-drawer" role="dialog" aria-modal="true" aria-label={mode === 'runtime' ? '运行时上下文' : '设置'} onMouseDown={(event) => event.stopPropagation()}>
      <header className="drawer-head"><div><strong>{mode === 'runtime' ? '运行时上下文' : '设置'}</strong><small>{mode === 'runtime' ? '当前浏览器连接和采集边界' : '当前可配置的界面与运行状态'}</small></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭">✕</button></header>
      {mode === 'runtime' ? <div className="drawer-content">
        <section className="drawer-section"><h3>连接</h3><dl><dt>状态</dt><dd>{state}</dd><dt>Profile</dt><dd>{status?.profile ?? '—'}</dd><dt>浏览器</dt><dd>{status?.browserVersion ?? '—'}</dd><dt>正文模式</dt><dd>{status?.bodyMode ?? '—'}</dd></dl></section>
        <section className="drawer-section"><h3>Targets <span>{status?.targets.filter((item) => item.attached).length ?? 0}/{status?.targets.length ?? 0} 已附着</span></h3>{status?.targets.length ? <ul className="target-list">{status.targets.map((target) => <li key={target.targetId}><span className={`target-dot${target.attached ? ' is-on' : ''}`} /><div><b>{target.type}</b><small title={target.url}>{target.url || '无 URL'}</small></div></li>)}</ul> : <p className="empty-note">尚未发现页面或 Worker target。</p>}</section>
        <section className="drawer-section"><h3>工作区</h3><dl><dt>当前</dt><dd>{active?.name ?? '未打开'}</dd><dt>状态</dt><dd>{active?.state ?? '—'}</dd><dt>数量</dt><dd>{workspaces?.workspaces.length ?? 0}</dd></dl></section>
      </div> : <div className="drawer-content">
        <section className="drawer-section"><h3>界面</h3><p>布局会按工作区保存。使用活动栏打开能力域，在侧栏选择视图；“＋分栏 / 排列 / 复位”用于安排主工作区。</p></section>
        <section className="drawer-section"><h3>快捷键</h3><dl><dt>命令面板</dt><dd><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd></dd><dt>关闭弹层</dt><dd><kbd>Esc</kbd></dd></dl></section>
        <section className="drawer-section"><h3>数据与权限</h3><p>本页只展示已实现能力的状态。Cookie 编辑、请求重放、扩展安装与启停仍需对应的受控后端动作与审计，当前不在设置页伪造开关。</p></section>
      </div>}
    </aside>
  </div>
}
