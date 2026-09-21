import { useEffect, useMemo, useRef, useState } from 'react'
import type { WsConnectionRow, WsFrameRow } from '../../../shared/types'
import { formatSize, formatTime } from '../format'

/**
 * WebSocket 面板。
 *
 * 先列连接（几千帧的会话一上来糊一屏没法看），点开某条连接再看它的帧。
 * 帧和事件流一样按 since 增量拉 —— 游标是 ws_frames.id，不是时间戳。
 */

const DIR_LABEL: Record<string, string> = { sent: '↑ 发出', received: '↓ 收到' }
const POLL_MS = 900
const FRAME_MAX = 3000

/** 文本帧直接看原文；二进制帧 payload 是 base64，别装作看得懂 */
function preview(frame: WsFrameRow): string {
  if (frame.binary) return `(二进制 ${formatSize(frame.size)})`
  return frame.payload.length > 300 ? frame.payload.slice(0, 300) + '…' : frame.payload
}

export function WsPanel(): React.JSX.Element {
  const [connections, setConnections] = useState<WsConnectionRow[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [frames, setFrames] = useState<WsFrameRow[]>([])
  const [direction, setDirection] = useState('all')
  const [search, setSearch] = useState('')
  const [paused, setPaused] = useState(false)
  const [follow, setFollow] = useState(true)
  const [open, setOpen] = useState<number | null>(null)

  const pausedRef = useRef(false)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    pausedRef.current = paused
  }, [paused])

  // 连接列表：有新帧就可能变，跟着轮询
  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      if (pausedRef.current) return
      const page = await window.monitor.getWsConnections(100)
      if (!alive || !page) return
      setConnections(page.rows)
    }
    const id = window.setInterval(() => void tick(), POLL_MS)
    void tick()
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [])

  // 选中连接的帧：换连接 = 换数据集，游标归零
  useEffect(() => {
    if (!selected) {
      setFrames([])
      return
    }
    let alive = true
    let busy = false
    let primed = false
    let cursor = 0
    setFrames([])
    setOpen(null)

    const tick = async (): Promise<void> => {
      if (busy || pausedRef.current) return
      busy = true
      try {
        const page = await window.monitor.queryWsFrames(
          primed
            ? { requestId: selected, since: cursor, limit: 500, order: 'asc' }
            : { requestId: selected, limit: 400, order: 'desc' }
        )
        if (!alive || !page) return
        primed = true
        cursor = page.nextSince
        if (page.rows.length > 0) {
          setFrames((prev) => [...prev, ...page.rows].slice(-FRAME_MAX))
        }
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
  }, [selected])

  useEffect(() => {
    const element = listRef.current
    if (!element || !follow) return
    element.scrollTop = element.scrollHeight
  }, [frames, follow])

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return frames.filter((frame) => {
      if (direction !== 'all' && frame.direction !== direction) return false
      if (needle && !frame.payload.toLowerCase().includes(needle)) return false
      return true
    })
  }, [frames, direction, search])

  const current = connections.find((row) => row.requestId === selected) ?? null

  return (
    <div className="ws-panel">
      <div className="ws-bar">
        <button
          type="button"
          className="btn"
          onClick={() => setPaused((value) => !value)}
        >
          {paused ? '继续' : '暂停'}
        </button>
        <span className="spacer" />
        <span className="mono dim small">
          {connections.length} 条连接 · {connections.reduce((sum, row) => sum + row.frames, 0)} 帧
        </span>
      </div>

      <div className="ws-split">
        <div className="ws-conns">
          {connections.length === 0 && (
            <div className="empty">还没有 WebSocket 连接（页面里 new WebSocket 之后才会出现）</div>
          )}
          {connections.map((row) => (
            <button
              key={row.requestId}
              type="button"
              className={`ws-conn ${row.requestId === selected ? 'ws-conn-active' : ''}`}
              onClick={() => setSelected(row.requestId)}
              title={row.url}
            >
              <span className="ws-conn-url mono ellipsis">{row.url}</span>
              <span className="ws-conn-meta mono dim small">
                {formatTime(row.firstTs)} · {row.frames} 帧 ↑{row.sent} ↓{row.received} · {formatSize(row.bytes)}
                {row.binaryFrames > 0 ? ` · bin ${row.binaryFrames}` : ''}
                {row.truncatedFrames > 0 ? ` · 截断 ${row.truncatedFrames}` : ''}
              </span>
            </button>
          ))}
        </div>

        <div className="ws-frames">
          <div className="ws-frames-bar">
            <span className="mono dim small ellipsis">{current ? current.url : '选一条连接看帧'}</span>
            <span className="spacer" />
            <select value={direction} onChange={(event) => setDirection(event.target.value)}>
              <option value="all">收发都看</option>
              <option value="sent">只看发出</option>
              <option value="received">只看收到</option>
            </select>
            <input
              className="search"
              placeholder="搜索帧正文"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <label className="check">
              <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
              跟随最新
            </label>
          </div>

          <div className="ws-frame-list" ref={listRef}>
            {!current && <div className="empty">左边选一条连接</div>}
            {current && visible.length === 0 && <div className="empty">这条连接还没有帧</div>}
            {visible.map((frame) => (
              <div
                key={frame.id}
                className={`ws-frame ${frame.direction === 'sent' ? 'ws-sent' : 'ws-recv'}`}
                onClick={() => setOpen(open === frame.id ? null : frame.id)}
              >
                <span className="ws-dir mono small">{DIR_LABEL[frame.direction] ?? frame.direction}</span>
                <span className="mono dim small ws-op">{frame.opcodeName}</span>
                <span className="ws-payload mono">{open === frame.id ? frame.payload : preview(frame)}</span>
                <span className="mono dim small ws-size">
                  {formatTime(frame.ts)} · {formatSize(frame.size)}
                  {frame.truncated ? ' · 截断' : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}