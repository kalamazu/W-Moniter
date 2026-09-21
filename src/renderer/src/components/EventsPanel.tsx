import { useEffect, useMemo, useRef, useState } from 'react'
import type { EventQuery, EventStats, MonitoredEvent, MonitorEventKind } from '../../../shared/types'
import { formatCount, formatTime } from '../format'

/**
 * 事件流面板。
 *
 * 和请求列表同一个套路：面板不自己攒数据，只按 `since`（自增 id）向库里要增量。
 * 滤波器下发到服务端 —— events 表是按 kind/level 建了索引的，拉到渲染进程再筛
 * 会把整表搬过 IPC。
 */

const KINDS: Array<{ id: MonitorEventKind; label: string }> = [
  { id: 'navigation', label: '导航' },
  { id: 'console', label: '控制台' },
  { id: 'exception', label: '异常' },
  { id: 'websocket', label: 'WebSocket' },
  { id: 'download', label: '下载' },
  { id: 'dialog', label: '对话框' },
  { id: 'target', label: 'target' },
  { id: 'rule', label: '规则' },
  { id: 'overflow', label: '溢出' }
]

const KIND_LABEL: Record<string, string> = Object.fromEntries(KINDS.map((item) => [item.id, item.label]))

const KIND_CLASS: Record<string, string> = {
  navigation: 'st-ok',
  console: 'st-warn',
  exception: 'st-err',
  websocket: 'st-info',
  download: 'st-info',
  dialog: 'st-warn',
  target: 'st-dim',
  rule: 'st-info',
  overflow: 'st-err'
}

/** 轮询间隔。事件是「发生即记录」，没有推送通道，只能问 —— 700ms 是观感与开销的折中 */
const POLL_MS = 700
/** 屏上最多留这么多行，再多就没人看，还拖慢渲染 */
const MAX_ROWS = 2000
/** 每次增量最多要多少行 */
const PAGE = 1000

function pick(detail: unknown, key: string): unknown {
  return detail && typeof detail === 'object' ? (detail as Record<string, unknown>)[key] : undefined
}

function text(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function pretty(detail: unknown): string {
  if (detail === undefined) return '(无 detail)'
  try {
    return JSON.stringify(detail, null, 2)
  } catch {
    return String(detail)
  }
}

/** 一行摘要。detail 的形状随 kind 而变，这里挑「人真正要看的那句」 */
function describe(event: MonitoredEvent): string {
  const detail = event.detail
  switch (event.kind) {
    case 'console':
      return text(pick(detail, 'text')) || '(空输出)'
    case 'exception': {
      const line = pick(detail, 'line')
      return `${text(pick(detail, 'text'))}${line === undefined ? '' : ' @' + text(line)}`
    }
    case 'navigation':
      return `${pick(detail, 'mainFrame') ? '主框架' : '子框架'} ${text(pick(detail, 'frameId')).slice(0, 12)}`
    case 'websocket': {
      const status = pick(detail, 'status')
      const message = pick(detail, 'message')
      return [
        text(pick(detail, 'event')),
        status === undefined ? '' : `HTTP ${text(status)}`,
        message === undefined ? '' : text(message)
      ]
        .filter(Boolean)
        .join(' · ')
    }
    case 'download': {
      const received = pick(detail, 'receivedBytes')
      const total = pick(detail, 'totalBytes')
      return [
        text(pick(detail, 'event')),
        text(pick(detail, 'filename')),
        received === undefined ? '' : `${text(received)}${total === undefined ? '' : '/' + text(total)} B`
      ]
        .filter(Boolean)
        .join(' · ')
    }
    case 'dialog':
      return [
        text(pick(detail, 'event')),
        text(pick(detail, 'type')),
        text(pick(detail, 'message'))
      ]
        .filter(Boolean)
        .join(' · ')
    case 'overflow':
      return text(pick(detail, 'note'))
    default:
      return text(detail)
  }
}

export function EventsPanel({ liveTick }: { liveTick: number }): React.JSX.Element {
  const [kind, setKind] = useState('all')
  const [level, setLevel] = useState('all')
  const [search, setSearch] = useState('')
  const [applied, setApplied] = useState('')
  const [paused, setPaused] = useState(false)
  const [follow, setFollow] = useState(true)
  const [rows, setRows] = useState<MonitoredEvent[]>([])
  const [stats, setStats] = useState<EventStats | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const listRef = useRef<HTMLDivElement | null>(null)
  const pausedRef = useRef(false)

  // 轮询循环不该因为「暂停/继续」重建（重建会把已累积的行清掉），所以走 ref
  useEffect(() => {
    pausedRef.current = paused
  }, [paused])

  // 搜索框每敲一下都重查太吵，攒 300ms 再下发
  useEffect(() => {
    const timer = window.setTimeout(() => setApplied(search.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [search])

  const filters = useMemo<EventQuery>(() => {
    const query: EventQuery = {}
    if (kind !== 'all') query.kind = kind as MonitorEventKind
    if (level !== 'all') query.level = level
    if (applied) query.search = applied
    return query
  }, [kind, level, applied])

  /**
   * 拉取循环。滤波器一变就换了一个数据集：游标归零、清空屏面，
   * 先倒着取最近一屏（省得从头把几万条拉一遍），之后一路按 since 增量追。
   */
  useEffect(() => {
    let alive = true
    let busy = false
    let primed = false
    let cursor = 0
    setRows([])
    setOpen(null)

    const tick = async (): Promise<void> => {
      if (busy || pausedRef.current) return
      busy = true
      try {
        const page = await window.monitor.queryEvents(
          primed
            ? { ...filters, since: cursor, limit: PAGE, order: 'asc' }
            : { ...filters, limit: 300, order: 'desc' }
        )
        if (!alive || !page) return
        primed = true
        cursor = page.nextSince
        if (page.rows.length > 0) {
          setRows((prev) => [...prev, ...page.rows].slice(-MAX_ROWS))
        }
        setError(null)
      } catch (err) {
        if (alive) setError((err as Error).message)
      } finally {
        busy = false
      }
    }

    const id = window.setInterval(() => void tick(), POLL_MS)
    void tick()
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [filters])

  // 统计慢得多，没必要跟着 700ms 跳。liveTick 顺手敲一下，省一个定时器
  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      const next = await window.monitor.getEventStats()
      if (alive) setStats(next)
    }
    void load()
    const id = window.setInterval(() => void load(), 5000)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [liveTick])

  useEffect(() => {
    const element = listRef.current
    if (!element || !follow) return
    element.scrollTop = element.scrollHeight
  }, [rows, follow])

  const respond = async (accept: boolean): Promise<void> => {
    const result = await window.monitor.handleDialog(accept)
    setNote(result.ok ? (accept ? '已放行对话框' : '已取消对话框') : `对话框应答失败：${result.error ?? '未知原因'}`)
  }

  /** 末尾那条 dialog 若只见到 opened，说明它现在还挂在页面上（页面是卡住的） */
  const pendingDialog = useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i]
      if (row.kind !== 'dialog') continue
      return pick(row.detail, 'event') === 'opened' ? row : null
    }
    return null
  }, [rows])

  const byKind = useMemo(() => {
    const map = new Map<string, number>()
    for (const row of stats?.rows ?? []) map.set(row.kind, (map.get(row.kind) ?? 0) + row.count)
    return [...map.entries()].sort((a, b) => b[1] - a[1])
  }, [stats])

  return (
    <div className="ev-panel">
      <div className="ev-bar">
        <select value={kind} onChange={(event) => setKind(event.target.value)} title="只看某一类事件">
          <option value="all">全部类型</option>
          {KINDS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
        <select value={level} onChange={(event) => setLevel(event.target.value)} title="只看某个级别">
          <option value="all">全部级别</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
        <input
          className="search"
          placeholder="搜索 URL / 正文"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <label className="check">
          <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
          跟随最新
        </label>
        <button type="button" className="btn" onClick={() => setPaused((value) => !value)}>
          {paused ? '继续' : '暂停'}
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            setSearch('')
            setKind('all')
            setLevel('all')
          }}
        >
          重置
        </button>
        <span className="spacer" />
        <span className="mono dim small">{rows.length} 行在屏 · 库里 {formatCount(stats?.total ?? 0)}</span>
      </div>

      {byKind.length > 0 && (
        <div className="ev-chips">
          {byKind.map(([name, count]) => (
            <span key={name} className={`chip chip-xs ${KIND_CLASS[name] ?? ''}`}>
              {KIND_LABEL[name] ?? name} {formatCount(count)}
            </span>
          ))}
        </div>
      )}

      {pendingDialog && (
        <div className="banner banner-warn">
          页面弹了 {text(pick(pendingDialog.detail, 'type'))}：{text(pick(pendingDialog.detail, 'message'))}
          <span className="spacer" />
          <button type="button" className="btn" onClick={() => void respond(true)}>
            确定 / 放行
          </button>
          <button type="button" className="btn" onClick={() => void respond(false)}>
            取消
          </button>
        </div>
      )}

      {note && (
        <div className="banner">
          {note}
          <span className="spacer" />
          <button type="button" className="link" onClick={() => setNote(null)}>
            知道了
          </button>
        </div>
      )}
      {error && <div className="banner banner-err">{error}</div>}

      <div className="ev-list" ref={listRef}>
        {rows.length === 0 && (
          <div className="empty">
            还没有事件。导航、console 告警与未捕获异常、下载、JavaScript 对话框、WebSocket 生命周期
            都会出现在这里
          </div>
        )}
        {rows.map((row, index) => {
          const key = row.id ?? `live-${index}`
          const expanded = open !== null && open === row.id
          return (
            <div
              key={key}
              className={`ev-row ${row.level === 'error' ? 'ev-error' : row.level === 'warn' ? 'ev-warn' : ''}`}
              onClick={() => setOpen(expanded ? null : row.id ?? null)}
            >
              <span className="ev-time mono dim">{formatTime(row.ts)}</span>
              <span className={`ev-kind mono small ${KIND_CLASS[row.kind] ?? ''}`}>
                {KIND_LABEL[row.kind] ?? row.kind}
              </span>
              <span className="ev-text" title={describe(row)}>
                {describe(row) || '—'}
              </span>
              <span className="ev-url mono dim small" title={row.url ?? ''}>
                {row.url ?? row.targetType ?? ''}
              </span>
              {expanded && <pre className="ev-detail">{pretty(row.detail)}</pre>}
            </div>
          )
        })}
      </div>
    </div>
  )
}