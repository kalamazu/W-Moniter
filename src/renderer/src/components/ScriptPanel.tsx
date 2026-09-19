import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ScriptRow, ScriptStats } from '../../../shared/types'
import { formatCount, formatSize, formatTime } from '../format'
import { looksMinified, prettyPrint } from '../pretty'

const ROW_HEIGHT = 26
const OVERSCAN = 10
const PAGE = 500

export interface ScriptPanelProps {
  /** 与请求列表同一个心跳：有新数据时重新查一次 */
  liveTick: number
}

/**
 * 脚本管理。
 *
 * 数据来自 Debugger.scriptParsed，所以内联 <script>、eval、Worker 里的代码
 * 都在里面 —— 光看网络请求是看不到这些的。
 *
 * 列表刻意不带源码（一页脚本可能几十 MB），点开哪条才去取哪条的源码。
 */
export function ScriptPanel({ liveTick }: ScriptPanelProps): React.JSX.Element {
  const [search, setSearch] = useState('')
  const [onlySource, setOnlySource] = useState(false)
  const [onlyInline, setOnlyInline] = useState(false)
  const [rows, setRows] = useState<ScriptRow[]>([])
  const [total, setTotal] = useState(0)
  const [stats, setStats] = useState<ScriptStats | null>(null)
  const [selected, setSelected] = useState<ScriptRow | null>(null)
  const [source, setSource] = useState<string | null>(null)
  const [sourceError, setSourceError] = useState<string | null>(null)
  const [loadingSource, setLoadingSource] = useState(false)
  const [formatted, setFormatted] = useState(true)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(600)
  const searchRef = useRef(search)
  searchRef.current = search

  const reload = useCallback(async (): Promise<void> => {
    const query = {
      ...(searchRef.current ? { search: searchRef.current } : {}),
      ...(onlySource ? { hasSource: true } : {}),
      ...(onlyInline ? { inline: true } : {})
    }
    const [page, nextStats] = await Promise.all([
      window.monitor.queryScripts(query, PAGE, 0, 'time_desc'),
      window.monitor.getScriptStats()
    ])
    setRows(page?.rows ?? [])
    setTotal(page?.total ?? 0)
    setStats(nextStats)
  }, [onlySource, onlyInline])

  // 搜索防抖：每敲一个字都查一遍数据库没必要
  useEffect(() => {
    const timer = setTimeout(() => void reload(), 180)
    return () => clearTimeout(timer)
  }, [reload, search, liveTick])

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const measure = (): void => setViewport(element.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    setLoadingSource(true)
    setSourceError(null)
    void window.monitor.getScriptSource(selected.hash).then((result) => {
      if (cancelled) return
      setLoadingSource(false)
      if (!result) {
        setSource(null)
        setSourceError('取源码失败（脚本可能已被 V8 回收）')
        return
      }
      setSource(result.source)
      if (result.source === null) setSourceError('这条脚本没有存源码（超限或拉取失败）')
    })
    return () => {
      cancelled = true
    }
  }, [selected])

  const display = useMemo(() => {
    if (source === null) return null
    const minified = looksMinified(source)
    return { minified, text: formatted && minified ? prettyPrint(source) : source }
  }, [source, formatted])

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const visibleCount = Math.ceil(viewport / ROW_HEIGHT) + OVERSCAN * 2
  const slice = rows.slice(first, first + visibleCount)

  return (
    <div className="split">
      <div className="rtable">
        <div className="toolbar">
          <input
            className="search"
            placeholder="搜索脚本 URL（内联脚本的 url 是空的）"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <label className="check">
            <input
              type="checkbox"
              checked={onlySource}
              onChange={(event) => setOnlySource(event.target.checked)}
            />
            有源码
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={onlyInline}
              onChange={(event) => setOnlyInline(event.target.checked)}
            />
            只看内联
          </label>
          <span className="spacer" />
          <span className="dim small">
            {stats
              ? `${formatCount(stats.total)} 条 · 有源码 ${formatCount(stats.withSource)} · 内联 ${formatCount(stats.inline)} · ${formatSize(stats.sourceBytes)}`
              : '统计加载中…'}
          </span>
        </div>

        <div className="rtable-head">
          <div className="rtable-row">
            <div className="c-time">时间</div>
            <div className="c-url">脚本 URL</div>
            <div className="c-body">源码</div>
            <div className="c-size">大小</div>
            <div className="c-method">次数</div>
          </div>
        </div>

        <div
          className="rtable-body"
          ref={scrollRef}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          <div className="rtable-spacer" style={{ height: rows.length * ROW_HEIGHT }} />
          <div className="rtable-window" style={{ transform: `translateY(${first * ROW_HEIGHT}px)` }}>
            {slice.map((row) => (
              <div
                key={row.hash}
                className={`rtable-row rtable-item${selected?.hash === row.hash ? ' row-selected' : ''}`}
                style={{ height: ROW_HEIGHT }}
                onClick={() => setSelected(row)}
                title={row.url ?? '内联脚本'}
              >
                <div className="c-time dim">{formatTime(row.first_seen)}</div>
                <div className="c-url">
                  {row.is_inline ? (
                    <>
                      <span className="chip chip-xs chip-hot">内联</span>
                      <span className="path dim">
                        {row.url ? row.url.replace(/^https?:\/\/[^/]+/, '') : ''} @行 {row.start_line}
                      </span>
                    </>
                  ) : row.url ? (
                    <>
                      <span className="host">{hostOf(row.url)}</span>
                      <span className="path">{pathOf(row.url)}</span>
                    </>
                  ) : (
                    <span className="dim">-</span>
                  )}
                </div>
                <div className={`c-body ${row.has_source ? 'st-ok' : 'dim'}`}>
                  {row.has_source ? formatSize(row.source_len) : '未存'}
                </div>
                <div className="c-size dim">{formatSize(row.size)}</div>
                <div className="c-method dim">{row.seen_count}</div>
              </div>
            ))}
          </div>
          {rows.length === 0 && <div className="empty">没有匹配的脚本</div>}
        </div>

        <div className="rtable-foot">
          <span className="dim small">
            已加载 {rows.length} / {total} 条
          </span>
        </div>
      </div>

      <div className="detail">
        <div className="detail-head">
          <strong>脚本源码</strong>
          <span className="spacer" />
          <button type="button" className="ghost small-btn" onClick={() => setSelected(null)}>
            关闭
          </button>
        </div>

        {!selected && <div className="empty">从左侧选一个脚本</div>}

        {selected && (
          <div>
            <dl>
              <dt>URL</dt>
              <dd className="mono break">{selected.url || '(无 url)'}</dd>
              {selected.is_inline ? (
                <>
                  <dt>内联位置</dt>
                  <dd className="mono">宿主资源第 {selected.start_line} 行</dd>
                </>
              ) : null}
              <dt>大小</dt>
              <dd className="mono">
                {formatSize(selected.size)}
                {selected.has_source ? '' : ' · 未存源码'}
              </dd>
              <dt>加载次数</dt>
              <dd className="mono">{selected.seen_count}</dd>
              <dt>hash</dt>
              <dd className="mono break dim">{selected.hash}</dd>
            </dl>

            {display && display.minified && (
              <div className="toolbar">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={formatted}
                    onChange={(event) => setFormatted(event.target.checked)}
                  />
                  美化（源码是压缩过的）
                </label>
              </div>
            )}

            {loadingSource && <div className="dim small">读取源码…</div>}
            {sourceError && <div className="banner banner-err">{sourceError}</div>}
            {display && <pre className="body-pre">{display.text}</pre>}
          </div>
        )}
      </div>
    </div>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.pathname + parsed.search
  } catch {
    return url
  }
}
