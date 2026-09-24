import type { PanelId } from '../../../shared/types'
import { PANELS, panelLabel } from './PaneGrid'

export type WorkbenchArea = 'observe' | 'analyze' | 'inspect' | 'execute' | 'configure'

interface Props {
  area: WorkbenchArea
  open: boolean
  activePanel: PanelId
  onArea: (area: WorkbenchArea) => void
  onToggle: () => void
  onOpenPanel: (panel: PanelId) => void
  onOpenRuntime: () => void
  onOpenSettings: () => void
}

const AREAS: Array<{ id: WorkbenchArea; icon: string; label: string; panels: PanelId[] }> = [
  { id: 'observe', icon: '◉', label: '观测', panels: ['list', 'waterfall', 'detail'] },
  { id: 'analyze', icon: '◇', label: '分析', panels: ['stats', 'endpoints', 'graph', 'events', 'ws'] },
  { id: 'inspect', icon: '⌘', label: '检查', panels: ['console', 'dom', 'sessions', 'sites', 'scripts'] },
  { id: 'execute', icon: '▶', label: '执行', panels: ['browser', 'replay'] },
  { id: 'configure', icon: '⚙', label: '配置', panels: ['rules', 'env'] }
]

export const areaForPanel = (panel: PanelId): WorkbenchArea =>
  AREAS.find((area) => area.panels.includes(panel))?.id ?? 'observe'

/** VS Code 式的一级能力栏；图形极简，文字留在 title 与侧栏，避免占主区。 */
export function WorkbenchNav({ area, open, activePanel, onArea, onToggle, onOpenPanel, onOpenRuntime, onOpenSettings }: Props): React.JSX.Element {
  const selected = AREAS.find((item) => item.id === area) ?? AREAS[0]
  return (
    <aside className="activity-bar" aria-label="工作台功能区">
      <div className="activity-main" role="toolbar" aria-label="主功能">
        {AREAS.map((item) => (
          <button key={item.id} type="button" className={`activity-item${area === item.id ? ' is-active' : ''}`} title={item.label}
            aria-label={item.label} aria-pressed={area === item.id} onClick={() => { onArea(item.id); if (!open) onToggle() }}>
            <span aria-hidden="true">{item.icon}</span>
          </button>
        ))}
      </div>
      <div className="activity-bottom">
        <button type="button" className="activity-item" title="运行时上下文" aria-label="运行时上下文" onClick={onOpenRuntime}>◎</button>
        <button type="button" className="activity-item" title="设置" aria-label="设置" onClick={onOpenSettings}>⚙</button>
      </div>
      <aside className={`view-sidebar${open ? ' is-open' : ''}`} aria-label={`${selected.label}视图`}>
        <header className="view-sidebar-head">
          <strong>{selected.label}</strong>
          <button type="button" className="icon-button" onClick={onToggle} title="收起侧栏" aria-label="收起侧栏">‹</button>
        </header>
        <div className="view-list" role="list">
          {selected.panels.map((panel) => (
            <button type="button" role="listitem" key={panel} className={`view-item${activePanel === panel ? ' is-active' : ''}`}
              onClick={() => onOpenPanel(panel)}>
              {panelLabel(panel)}
            </button>
          ))}
        </div>
        <footer className="view-sidebar-foot">所有 {PANELS.length} 个视图均可通过命令面板打开</footer>
      </aside>
    </aside>
  )
}
