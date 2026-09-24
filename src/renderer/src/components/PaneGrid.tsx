import { Fragment, useCallback, useEffect, useRef } from 'react'
import type { PanelId, PanelLayout } from '../../../shared/types'

/**
 * 自由工作区：几栏并排（或上下），每栏自己选面板，栏与栏之间是可拖的分隔条。
 *
 * 为什么要imperative地改 flex-grow：拖动时每秒几十次 move，走 state 会把
 * 每一栏里的面板（列表、瀑布图那种几千行）整棵重渲染，拖起来就卡了。
 * 拖动过程只改 DOM 上的 flex-grow，松手才提交给上层落盘。
 */

export interface PanelDef {
  id: PanelId
  label: string
}

export const PANELS: ReadonlyArray<PanelDef> = [
  { id: 'list', label: '请求列表' },
  { id: 'waterfall', label: '瀑布图' },
  { id: 'detail', label: '请求详情' },
  { id: 'scripts', label: '脚本' },
  { id: 'stats', label: '统计' },
  { id: 'rules', label: '规则' },
  { id: 'console', label: '控制台' },
  { id: 'env', label: '环境' },
  { id: 'dom', label: 'DOM' },
  { id: 'sessions', label: '会话' },
  { id: 'events', label: '事件流' },
  { id: 'ws', label: 'WebSocket' },
  { id: 'endpoints', label: '接口画像' },
  { id: 'graph', label: '调用图' },
  { id: 'sites', label: '站点资源' },
  { id: 'browser', label: '浏览器控制' },
  { id: 'replay', label: '重放与测试' }
]

export function panelLabel(id: PanelId): string {
  return PANELS.find((panel) => panel.id === id)?.label ?? id
}

/** 一栏最窄留这么多像素，拖到头就顶住 */
const MIN_PANE_PX = 160

interface Props {
  layout: PanelLayout
  onLayout: (next: PanelLayout) => void
  renderPanel: (id: PanelId) => React.ReactNode
  onPick: (index: number, id: PanelId) => void
  activeIndex: number
  onActivate: (index: number) => void
  onClose: (index: number) => void
}

export function PaneGrid({ layout, onLayout, renderPanel, onPick, activeIndex, onActivate, onClose }: Props): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const paneRefs = useRef<Array<HTMLElement | null>>([])
  const drag = useRef<{ index: number; startPos: number; start: number[]; totalPx: number } | null>(null)

  const apply = useCallback((sizes: number[]): void => {
    paneRefs.current.forEach((el, index) => {
      if (el && sizes[index] !== undefined) el.style.flexGrow = String(sizes[index])
    })
  }, [])

  useEffect(() => {
    apply(layout.sizes)
  }, [apply, layout.sizes])

  useEffect(() => {
    const onMove = (event: MouseEvent): void => {
      const state = drag.current
      if (!state) return
      const pos = layout.dir === 'column' ? event.clientY : event.clientX
      const delta = (pos - state.startPos) / state.totalPx
      const min = Math.min(0.34, MIN_PANE_PX / state.totalPx)
      let left = state.start[state.index] + delta
      let right = state.start[state.index + 1] - delta
      // 两边都顶住下限，且总占比不变（另一栏补回来）
      if (left < min) {
        right -= min - left
        left = min
      }
      if (right < min) {
        left -= min - right
        right = min
      }
      const next = [...state.start]
      next[state.index] = left
      next[state.index + 1] = right
      apply(next)
    }

    const onUp = (): void => {
      const state = drag.current
      if (!state) return
      drag.current = null
      document.body.classList.remove('is-col-resize', 'is-row-resize')
      // 从 DOM 读回拖完的结果：拖动过程没走 state，这里才是真值
      const sizes = paneRefs.current.slice(0, layout.panes.length).map((el) => Number(el?.style.flexGrow ?? 0))
      if (sizes.length === layout.panes.length && sizes.every((size) => size > 0)) {
        onLayout({ ...layout, sizes })
      }
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [apply, layout, onLayout])

  const startDrag = (index: number, event: React.MouseEvent): void => {
    const box = boxRef.current
    if (!box) return
    event.preventDefault()
    const rect = box.getBoundingClientRect()
    drag.current = {
      index,
      startPos: layout.dir === 'column' ? event.clientY : event.clientX,
      start: [...layout.sizes],
      totalPx: (layout.dir === 'column' ? rect.height : rect.width) || 1
    }
    document.body.classList.add(layout.dir === 'column' ? 'is-row-resize' : 'is-col-resize')
  }

  /** 双击分隔条 = 均分。拖歪了不用手抠，双击回到整齐的状态 */
  const evenOut = (): void => {
    const count = layout.panes.length
    onLayout({ ...layout, sizes: layout.panes.map(() => Number((1 / count).toFixed(4))) })
  }

  return (
    <div className={`panes panes-${layout.dir}`} ref={boxRef}>
      {layout.panes.map((id, index) => (
        <Fragment key={`${id}-${index}`}>
          {index > 0 && (
            <div
              className="pane-split"
              onMouseDown={(event) => startDrag(index - 1, event)}
              onDoubleClick={evenOut}
              title="拖动调整大小，双击均分"
            />
          )}
          <section
            className={`pane${activeIndex === index ? ' is-active' : ''}`}
            ref={(el) => {
              paneRefs.current[index] = el
            }}
            style={{ flexGrow: layout.sizes[index] ?? 1, flexBasis: 0 }}
            onMouseDown={() => onActivate(index)}
          >
            <header className="pane-head">
              <span className="pane-pick-wrap">
                <select
                  className="pane-pick"
                  value={id}
                  title="换这一栏显示的面板"
                  onChange={(event) => onPick(index, event.target.value as PanelId)}
                >
                  {PANELS.map((panel) => (
                    <option key={panel.id} value={panel.id}>
                      {panel.label}
                    </option>
                  ))}
                </select>
              </span>
              <span className="spacer" />
              {layout.panes.length > 1 && (
                <button
                  type="button"
                  className="pane-act"
                  title="关掉这一栏"
                  onClick={() => onClose(index)}
                >
                  ✕
                </button>
              )}
            </header>
            <div className="pane-body">{renderPanel(id)}</div>
          </section>
        </Fragment>
      ))}
    </div>
  )
}
