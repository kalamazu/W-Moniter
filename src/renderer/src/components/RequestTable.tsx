import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { StoredRequest } from '../../../shared/types'
import { bodyStateLabel, formatMs, formatSize, formatTime, rowKey, splitUrl, statusClass } from '../format'

const ROW_HEIGHT = 26
const OVERSCAN = 10

const COLUMNS = [
  { key: 'time', label: '时间', className: 'c-time' },
  { key: 'method', label: '方法', className: 'c-method' },
  { key: 'status', label: '状态', className: 'c-status' },
  { key: 'type', label: '类型', className: 'c-type' },
  { key: 'target', label: '来源', className: 'c-target' },
  { key: 'url', label: 'URL', className: 'c-url' },
  { key: 'body', label: 'BODY', className: 'c-body' },
  { key: 'size', label: '大小', className: 'c-size' },
  { key: 'duration', label: '耗时', className: 'c-duration' }
]

export interface RequestTableProps {
  rows: StoredRequest[]
  total: number
  hasMore: boolean
  loading: boolean
  pendingNew: number
  selectedSeq: number | null
  onSelect(seq: number): void
  onLoadMore(): void
  onRefresh(): void
  onScrollTop(atTop: boolean): void
}

/**
 * 虚拟滚动表格。只渲染视口内那几十行 —— DOM 行数和数据量无关，
 * 所以「库里十万条，滚起来还是 60fps」这件事不依赖第三方库。
 */
export function RequestTable(props: RequestTableProps): React.JSX.Element {
  const { rows, total, hasMore, loading, selectedSeq, onSelect, onLoadMore, onScrollTop } = props

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(600)
  const atTopRef = useRef(true)
  const loadMoreRef = useRef(onLoadMore)
  loadMoreRef.current = onLoadMore

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const measure = (): void => setViewport(element.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // 选中行如果在视口外，滚过去
  useEffect(() => {
    if (selectedSeq === null) return
    const index = rows.findIndex((row) => row.seq === selectedSeq)
    if (index < 0) return
    const element = scrollRef.current
    if (!element) return
    const top = index * ROW_HEIGHT
    const bottom = top + ROW_HEIGHT
    if (top < element.scrollTop) element.scrollTop = top
    else if (bottom > element.scrollTop + element.clientHeight) {
      element.scrollTop = bottom - element.clientHeight
    }
  }, [selectedSeq, rows])

  function handleScroll(event: React.UIEvent<HTMLDivElement>): void {
    const element = event.currentTarget
    setScrollTop(element.scrollTop)

    const top = element.scrollTop <= 1
    if (top !== atTopRef.current) {
      atTopRef.current = top
      onScrollTop(top)
    }

    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight
    if (remaining < ROW_HEIGHT * 20) loadMoreRef.current()
  }

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const visibleCount = Math.ceil(viewport / ROW_HEIGHT) + OVERSCAN * 2
  const slice = rows.slice(first, first + visibleCount)

  return (
    <div className="rtable">
      <div className="rtable-head">
        <div className="rtable-row">
          {COLUMNS.map((column) => (
            <div key={column.key} className={column.className}>
              {column.label}
            </div>
          ))}
        </div>
      </div>

      <div className="rtable-body" ref={scrollRef} onScroll={handleScroll}>
        <div className="rtable-spacer" style={{ height: rows.length * ROW_HEIGHT }} />
        <div className="rtable-window" style={{ transform: `translateY(${first * ROW_HEIGHT}px)` }}>
          {slice.map((row) => (
            <RequestRow
              key={rowKey(row)}
              row={row}
              selected={row.seq === selectedSeq}
              onClick={() => onSelect(row.seq)}
            />
          ))}
        </div>

        {rows.length === 0 && !loading && <div className="empty">没有匹配的请求</div>}
      </div>

      <div className="rtable-foot">
        <span className="dim small">
          已加载 {rows.length} / {total} 条
        </span>
        {props.pendingNew > 0 && (
          <button type="button" className="pill" onClick={props.onRefresh}>
            {props.pendingNew} 批新请求 · 回到顶部
          </button>
        )}
        {hasMore && (
          <button type="button" className="ghost small-btn" onClick={onLoadMore} disabled={loading}>
            {loading ? '加载中…' : '加载更多'}
          </button>
        )}
        {loading && <span className="dim small">查询中…</span>}
      </div>
    </div>
  )
}

function RequestRow(props: {
  row: StoredRequest
  selected: boolean
  onClick(): void
}): React.JSX.Element {
  const { row, selected, onClick } = props
  const { host, path } = splitUrl(row.url)
  const hasBody = row.body_state === 'stored'

  return (
    <div
      className={`rtable-row rtable-item${selected ? ' row-selected' : ''}`}
      style={{ height: ROW_HEIGHT }}
      onClick={onClick}
      title={row.url}
    >
      <div className="c-time dim">{formatTime(row.start_ts)}</div>
      <div className="c-method">{row.method}</div>
      <div className={`c-status ${statusClass(row.status, row.failed)}`}>
        {row.failed ? '失败' : (row.status ?? '—')}
      </div>
      <div className="c-type dim">{row.resource_type ?? '-'}</div>
      <div className="c-target">
        <span className={`chip chip-xs ${row.target_type === 'page' ? 'chip-dim' : 'chip-hot'}`}>
          {row.target_type}
        </span>
      </div>
      <div className="c-url">
        {host && <span className="host">{host}</span>}
        <span className="path">{path}</span>
      </div>
      <div className={`c-body ${hasBody ? 'st-ok' : 'dim'}`} title={bodyStateLabel(row.body_state)}>
        {hasBody ? formatSize(row.body_size) : bodyStateLabel(row.body_state)}
      </div>
      <div className="c-size dim">{formatSize(row.encoded_len)}</div>
      <div className="c-duration dim">{formatMs(row.duration_ms)}</div>
    </div>
  )
}
