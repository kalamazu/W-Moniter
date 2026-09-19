import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DomInspectResult, DomTreeRow } from '../../../shared/types'
import { formatCount, formatSize } from '../format'

/** 树每深一层缩进的像素。深树缩进太大会把标签挤没 */
const INDENT = 12

/** 计算样式一屏最多画多少行 —— 真实页面有 300+ 条，全画出来没必要 */
const COMPUTED_LIMIT = 400

export function DomPanel({ liveTick }: { liveTick: number }): React.JSX.Element {
  const [rows, setRows] = useState<DomTreeRow[]>([])
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [selected, setSelected] = useState<number | null>(null)
  const [detail, setDetail] = useState<DomInspectResult | null>(null)
  const [selector, setSelector] = useState('#app')
  const [domains, setDomains] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [computedFilter, setComputedFilter] = useState('')
  const [highlight, setHighlight] = useState(false)
  const [highlightNode, setHighlightNode] = useState<number | null>(null)

  const loadRoot = useCallback(async () => {
    setBusy(true)
    const result = await window.monitor.domGetTree(undefined, 2)
    setBusy(false)
    if (!result.ok) {
      setError(result.error ?? '取 DOM 树失败')
      return
    }
    setError(null)
    setRows(result.rows)
    setDomains(result.enabledDomains)
    setExpanded(new Set(result.rows.filter((row) => row.expanded).map((row) => row.nodeId)))
  }, [])

  // 开局取一次；还没页面时靠实时流量敲一敲重试（DOM 树是快照，不跟着流量刷新，
  // 否则用户刚展开的节点会被整棵树重取冲掉）
  useEffect(() => {
    if (rows.length > 0 || busy) return
    void loadRoot()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTick, rows.length])

  const inspect = useCallback(
    async (target: { selector?: string; nodeId?: number }) => {
      setBusy(true)
      const result = await window.monitor.domInspect(target)
      setBusy(false)
      setDetail(result)
      setDomains(result.enabledDomains)
      if (result.node) {
        setSelected(result.node.nodeId)
        setHighlightNode(result.node.nodeId)
      }
      setError(result.ok ? null : (result.error ?? '检查失败'))
    },
    []
  )

  // 高亮跟着选中项走；关掉开关或换选中项时把上一个灭掉
  useEffect(() => {
    if (!highlight || highlightNode === null) return
    void window.monitor
      .domHighlight(highlightNode, true)
      .then((result) => setDomains(result.enabledDomains))
    return () => {
      void window.monitor.domHighlight(highlightNode, false)
    }
  }, [highlight, highlightNode])

  const toggle = useCallback(
    async (row: DomTreeRow) => {
      if (expanded.has(row.nodeId)) {
        setRows((prev) => removeSubtree(prev, row))
        setExpanded((prev) => {
          const next = new Set(prev)
          next.delete(row.nodeId)
          return next
        })
        return
      }
      setBusy(true)
      const result = await window.monitor.domGetTree(row.nodeId, 1)
      setBusy(false)
      if (!result.ok) {
        setError(result.error ?? '展开失败')
        return
      }
      setDomains(result.enabledDomains)
      // 取回来的第一行是节点自己（depth=0），丢掉；子节点深度按它的深度平移
      const kids = result.rows.slice(1).map((child) => ({ ...child, depth: row.depth + child.depth }))
      setRows((prev) => insertAfter(prev, row, kids))
      setExpanded((prev) => new Set(prev).add(row.nodeId))
    },
    [expanded]
  )

  const computedRows = useMemo(() => {
    const list = detail?.computed ?? []
    const needle = computedFilter.trim().toLowerCase()
    const filtered = needle
      ? list.filter(([name, value]) => name.includes(needle) || value.toLowerCase().includes(needle))
      : list
    return filtered.slice(0, COMPUTED_LIMIT)
  }, [detail, computedFilter])

  return (
    <div className="dom-panel">
      <div className="dom-bar">
        <input
          className="search"
          placeholder="#id / .class / 任意 CSS 选择器"
          value={selector}
          onChange={(event) => setSelector(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void inspect({ selector })
          }}
        />
        <button type="button" className="btn btn-primary" onClick={() => void inspect({ selector })}>
          检查元素
        </button>
        <button type="button" className="ghost" onClick={() => void loadRoot()}>
          重取 DOM 树
        </button>
        <label className="check">
          <input
            type="checkbox"
            checked={highlight}
            onChange={(event) => setHighlight(event.target.checked)}
          />
          页面高亮
        </label>
        <span className="spacer" />
        <span className="dom-domains" title="§3.4：DOM / CSS 在 Profile H 下是「按需」，这里就是启用的那一刻">
          按需启用：{domains.length ? domains.join(' / ') : '（还没启用）'}
        </span>
        {busy && <span className="dim small">忙…</span>}
      </div>

      {error && <div className="banner banner-err">{error}</div>}

      <div className="dom-split">
        <div className="dom-tree">
          {rows.map((row) => (
            <div
              key={row.nodeId}
              className={`dom-row${selected === row.nodeId ? ' dom-row-active' : ''}`}
              style={{ paddingLeft: 6 + row.depth * INDENT }}
              onClick={() => void inspect({ nodeId: row.nodeId })}
            >
              <span
                className={`dom-arrow${row.expandable ? '' : ' dom-arrow-none'}`}
                onClick={(event) => {
                  event.stopPropagation()
                  if (row.expandable) void toggle(row)
                }}
              >
                {row.expandable ? (expanded.has(row.nodeId) ? '▾' : '▸') : '·'}
              </span>
              <span className={`dom-label dom-node-${row.nodeType}`}>{row.label}</span>
              {row.preview && <span className="dom-preview">“{row.preview}”</span>}
            </div>
          ))}
          {rows.length === 0 && (
            <div className="dim small pad">还没有 DOM。页面起来后点「重取 DOM 树」。</div>
          )}
        </div>

        <div className="dom-detail">
          {!detail && <div className="dim small pad">左边点一个节点，或上面按选择器查一个元素。</div>}
          {detail?.ok && detail.node && (
            <>
              <div className="detail-head">
                <h3>{detail.node.label}</h3>
                <span className="dim small mono">{detail.durationMs}ms</span>
              </div>
              <div className="mono small dim break">{detail.node.path}</div>

              {/* CDP 那两路失败以前是静默的，页面里就只看到空列表 —— 摆出来 */}
              {detail.styleError && <div className="banner banner-err">{detail.styleError}</div>}
              {detail.listenerError && (
                <div className="banner banner-err">事件监听器取不到：{detail.listenerError}</div>
              )}

              {detail.node.attributes && detail.node.attributes.length > 0 && (
                <>
                  <h4>属性</h4>
                  <table className="kv">
                    <tbody>
                      {detail.node.attributes.map(([name, value]) => (
                        <tr key={name}>
                          <td className="mono dim">{name}</td>
                          <td className="mono break">{value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              {detail.box && (
                <>
                  <h4>盒模型</h4>
                  <div className="dom-box">
                    <span>
                      margin <b>{boxSize(detail.box.margin)}</b>
                    </span>
                    <span>
                      border <b>{boxSize(detail.box.border)}</b>
                    </span>
                    <span>
                      padding <b>{boxSize(detail.box.padding)}</b>
                    </span>
                    <span>
                      content <b>{boxSize(detail.box.content)}</b>
                    </span>
                  </div>
                </>
              )}

              <h4>命中样式（{detail.matched?.length ?? 0} 条）</h4>
              {(detail.matched ?? []).length === 0 && <div className="dim small">没有命中任何规则</div>}
              {(detail.matched ?? []).map((rule, index) => (
                <div key={rule.origin + '|' + rule.selector + '|' + index} className="dom-rule">
                  <div className="dom-rule-head">
                    <span className="dom-selector">{rule.selector}</span>
                    <span className={`chip chip-xs${rule.origin === 'inline' ? ' chip-hot' : ' chip-dim'}`}>
                      {rule.origin}
                    </span>
                    {rule.overridden.length > 0 && (
                      <span className="dim small">{rule.overridden.length} 项被覆盖</span>
                    )}
                  </div>
                  <div className="dom-props">
                    {rule.properties.map(([name, value]) => (
                      <span
                        key={name}
                        className={`dom-prop${rule.overridden.includes(name) ? ' dom-over' : ''}`}
                      >
                        {name}: {value}
                      </span>
                    ))}
                  </div>
                </div>
              ))}

              <h4>
                事件监听器（{detail.listeners?.length ?? 0}
                {detail.listenerTotal !== undefined && detail.listenerTotal !== detail.listeners?.length
                  ? ` / 页面共 ${detail.listenerTotal}`
                  : ''}
                ）
              </h4>
              {(detail.listeners ?? []).length === 0 && (
                <div className="dim small">这个节点上没有事件监听器</div>
              )}
              {(detail.listeners ?? []).map((item, index) => (
                <div key={item.type + '|' + index} className="dom-listener">
                  <span className="dom-evtype">{item.type}</span>
                  {item.useCapture && <span className="chip chip-xs chip-dim">capture</span>}
                  {item.passive && <span className="chip chip-xs chip-dim">passive</span>}
                  {item.once && <span className="chip chip-xs chip-dim">once</span>}
                  {item.handler && <span className="dom-handler mono small">{item.handler}</span>}
                  {item.location && <span className="dim small mono">{item.location}</span>}
                </div>
              ))}

              <h4>元素内容</h4>
              <pre className="body-pre dom-html">
                {detail.outerHTML}
                {detail.outerTruncated ? '\n…（已截断）' : ''}
              </pre>

              <h4>
                计算样式（{(detail.computed ?? []).length}
                {computedRows.length < (detail.computed?.length ?? 0) ? ` 命中 ${computedRows.length}` : ''}）
              </h4>
              <input
                className="search"
                placeholder="过滤属性名 / 值"
                value={computedFilter}
                onChange={(event) => setComputedFilter(event.target.value)}
              />
              <div className="dom-computed">
                {computedRows.map(([name, value]) => (
                  <div key={name} className="dom-computed-row">
                    <span className="dom-cname">{name}</span>
                    <span className="dom-cvalue mono">{value}</span>
                  </div>
                ))}
              </div>
            </>
          )}
          {detail && !detail.ok && (
            <div className="dim small pad">{detail.error ?? '检查失败'}</div>
          )}
        </div>
      </div>
    </div>
  )
}

/** '▸ 展开' 时把子节点插到父节点后面；重复展开也不会插两遍 */
function insertAfter(rows: DomTreeRow[], parent: DomTreeRow, kids: DomTreeRow[]): DomTreeRow[] {
  const index = rows.findIndex((row) => row.nodeId === parent.nodeId)
  if (index < 0) return rows
  const next = [...rows.slice(0, index + 1), ...kids]
  for (let i = index + 1; i < rows.length; i += 1) {
    if (rows[i].depth <= parent.depth) next.push(rows[i])
  }
  return next
}

/** '▾ 收起' 把该节点的整棵子树去掉 */
function removeSubtree(rows: DomTreeRow[], parent: DomTreeRow): DomTreeRow[] {
  const index = rows.findIndex((row) => row.nodeId === parent.nodeId)
  if (index < 0) return rows
  return rows.filter((row, i) => i <= index || row.depth <= parent.depth)
}

/** 盒模型四边形 [x1,y1,x2,y2,x3,y3,x4,y4] → '宽×高' */
function boxSize(quad: number[]): string {
  if (!quad || quad.length < 8) return '-'
  const xs = [quad[0], quad[2], quad[4], quad[6]]
  const ys = [quad[1], quad[3], quad[5], quad[7]]
  const width = Math.round(Math.max(...xs) - Math.min(...xs))
  const height = Math.round(Math.max(...ys) - Math.min(...ys))
  return width + '×' + height
}