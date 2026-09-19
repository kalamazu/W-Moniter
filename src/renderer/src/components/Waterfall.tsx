import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RequestQuery, TimelineRow } from '../../../shared/types'
import { formatMs, formatTime, splitUrl, statusClass, typeColor } from '../format'

const ROW_HEIGHT = 9
const LABEL_WIDTH = 260
const HEADER_HEIGHT = 22

/**
 * 代理侧的分段时序（§5.1 里 CDP 给不了的那部分）。顺序就是真实发生的顺序：
 * 建连 → 等首字节 → 收 body。复用连接时 dns/connect/tls 本来就没有（和浏览器语义一致），
 * 所以每段都是「有才画」，不补零。
 */
const PROXY_SEGMENTS = [
  ['net_dns_ms', '#8b7bff', 'DNS'],
  ['net_connect_ms', '#4c8dff', 'TCP'],
  ['net_tls_ms', '#2fc6a8', 'TLS'],
  ['ttfb_ms', '#f0b23a', 'TTFB'],
  ['net_download_ms', '#7bd88f', 'download']
] as const

/** 第一段之前那段空档：CDP 记到请求 → 代理真的看到它。突发并发下这段就是排队 */
const GAP_COLOR = '#3a4453'

/** 三源关联的结果要能一眼看出来，不然「配没配上」只能去翻详情 */
const MERGE_COLORS: Record<string, string> = {
  merged: '#7bd88f',
  'cdp-only': '#f0b23a',
  'proxy-only': '#2fc6a8'
}

const MERGE_LABELS: Record<string, string> = {
  merged: '三源已关联',
  'cdp-only': '只有 CDP（代理没看到）',
  'proxy-only': '只有代理（CDP 没看到）'
}

export interface WaterfallProps {
  query: RequestQuery
  liveTick: number
  selectedSeq: number | null
  onSelect(seq: number): void
  limit: number
}

/**
 * 瀑布图用 Canvas 画：行数上千时 DOM 方案会直接跪，
 * 而且这里没有任何交互元素，画布是最合适的载体。
 *
 * 只画视口内的行，画布高度等于视口高度 —— 数据量再大也不涨内存。
 */
export function Waterfall(props: WaterfallProps): React.JSX.Element {
  const { query, liveTick, selectedSeq, onSelect, limit } = props
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [rows, setRows] = useState<TimelineRow[]>([])
  const [scrollTop, setScrollTop] = useState(0)
  const [size, setSize] = useState({ width: 900, height: 500 })
  const [error, setError] = useState<string | null>(null)

  const queryKey = JSON.stringify(query)
  const nonceRef = useRef(0)

  useEffect(() => {
    const nonce = ++nonceRef.current
    const timer = setTimeout(
      () => {
        void window.monitor.getTimeline(query, limit).then((result) => {
          if (nonce !== nonceRef.current) return
          // 查询返回的是倒序（方便看最新），画图要正序
          const ordered = [...result].reverse()
          setRows(ordered)
          if (ordered.length === 0) setError('这段时间没有可画的请求')
          else setError(null)
        })
      },
      liveTick === 0 ? 0 : 400
    )
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, limit, liveTick])

  useLayoutEffect(() => {
    const element = wrapRef.current
    if (!element) return
    const measure = (): void =>
      setSize({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.floor(size.width * dpr))
    canvas.height = Math.max(1, Math.floor(size.height * dpr))
    canvas.style.width = `${size.width}px`
    canvas.style.height = `${size.height}px`
    context.setTransform(dpr, 0, 0, dpr, 0, 0)

    const css = getComputedStyle(document.documentElement)
    const bg = css.getPropertyValue('--bg').trim() || '#0d1014'
    const line = css.getPropertyValue('--line').trim() || '#242b35'
    const muted = css.getPropertyValue('--muted').trim() || '#8b95a5'
    const text = css.getPropertyValue('--text').trim() || '#e6eaf0'

    context.fillStyle = bg
    context.fillRect(0, 0, size.width, size.height)

    if (rows.length === 0) {
      context.fillStyle = muted
      context.font = '13px "Segoe UI", "Microsoft YaHei", sans-serif'
      context.textAlign = 'center'
      context.fillText(error ?? '暂无数据', size.width / 2, size.height / 2)
      return
    }

    let minStart = Infinity
    let maxEnd = -Infinity
    for (const row of rows) {
      if (row.start_ts < minStart) minStart = row.start_ts
      const end = row.end_ts ?? row.start_ts + (row.duration_ms ?? 0)
      if (end > maxEnd) maxEnd = end
    }
    const span = Math.max(maxEnd - minStart, 1)

    const chartLeft = LABEL_WIDTH
    const chartWidth = Math.max(size.width - chartLeft - 12, 40)
    const xOf = (ts: number): number => chartLeft + ((ts - minStart) / span) * chartWidth

    const first = Math.max(0, Math.floor((scrollTop - HEADER_HEIGHT) / ROW_HEIGHT) - 4)
    const last = Math.min(
      rows.length,
      first + Math.ceil(size.height / ROW_HEIGHT) + 8
    )

    // 纵向网格 + 刻度：相对时间，读时间轴比读绝对时间有用
    const ticks = 6
    context.font = '11px Consolas, monospace'
    context.textAlign = 'left'
    context.textBaseline = 'top'
    for (let step = 0; step <= ticks; step += 1) {
      const ratio = step / ticks
      const x = chartLeft + ratio * chartWidth
      context.strokeStyle = line
      context.globalAlpha = 0.6
      context.beginPath()
      context.moveTo(x, HEADER_HEIGHT)
      context.lineTo(x, size.height)
      context.stroke()
      context.globalAlpha = 1
      context.fillStyle = muted
      context.fillText(`${Math.round(ratio * span)} ms`, x + 3, 4)
    }

    context.textBaseline = 'middle'
    for (let index = first; index < last; index += 1) {
      const row = rows[index]
      const y = HEADER_HEIGHT + index * ROW_HEIGHT - scrollTop
      if (y < HEADER_HEIGHT - ROW_HEIGHT || y > size.height) continue

      if (row.seq === selectedSeq) {
        context.fillStyle = 'rgba(76, 141, 255, 0.18)'
        context.fillRect(0, y, size.width, ROW_HEIGHT)
      }

      // 左侧标签
      const { host, path } = splitUrl(row.url)
      context.textAlign = 'left'
      context.fillStyle = index % 2 === 0 ? text : muted
      const label = `${row.method} ${host}${path}`
      context.save()
      context.beginPath()
      context.rect(6, y, LABEL_WIDTH - 14, ROW_HEIGHT)
      context.clip()
      context.fillText(label, 6, y + ROW_HEIGHT / 2)
      context.restore()

      // 右侧时间条。有代理分段时底条降透明度当「整体包络」，分段画在上面
      const hasSegments = PROXY_SEGMENTS.some(
        ([key]) => typeof row[key] === 'number' && (row[key] as number) > 0
      )
      const startX = xOf(row.start_ts)
      const endTs = row.end_ts ?? row.start_ts + (row.duration_ms ?? 0)
      const width = Math.max(1.5, xOf(endTs) - startX)
      context.fillStyle = row.failed ? '#ff7a7a' : typeColor(row.resource_type)
      context.globalAlpha = hasSegments ? 0.26 : row.status && row.status >= 400 ? 0.55 : 1
      context.fillRect(startX, y + 1.5, width, ROW_HEIGHT - 3)
      context.globalAlpha = 1

      if (hasSegments) {
        // 代理看到请求之前的那段：浏览器栈里的排队。它就是「±50ms 窗口为什么不够」的可视化
        const proxyStart = row.proxy_delta_ms === null ? row.start_ts : row.start_ts + row.proxy_delta_ms
        if (proxyStart > row.start_ts) {
          context.fillStyle = GAP_COLOR
          context.fillRect(startX, y + 2.5, Math.max(1, xOf(proxyStart) - startX), ROW_HEIGHT - 5)
        }
        let cursor = proxyStart
        for (const [key, color] of PROXY_SEGMENTS) {
          const value = row[key]
          if (typeof value !== 'number' || value <= 0) continue
          const x1 = xOf(cursor)
          const x2 = xOf(cursor + value)
          cursor += value
          context.fillStyle = color
          context.fillRect(x1, y + 2.5, Math.max(1, x2 - x1), ROW_HEIGHT - 5)
        }
        // 长连接在收工时被补报，响应还没结束 —— 别让它看起来「到这就画完了」
        if (row.proxy_open) {
          const tail = xOf(cursor)
          const gradient = context.createLinearGradient(tail, 0, tail + 24, 0)
          gradient.addColorStop(0, 'rgba(139, 149, 165, 0.85)')
          gradient.addColorStop(1, 'rgba(139, 149, 165, 0)')
          context.fillStyle = gradient
          context.fillRect(tail, y + 2.5, 24, ROW_HEIGHT - 5)
        }
      }

      // 关联结果：在最左侧钉一小段色标，扫一眼就知道这条是哪一源来的
      const mergeColor = row.merge_state ? MERGE_COLORS[row.merge_state] : undefined
      if (mergeColor) {
        context.fillStyle = mergeColor
        context.fillRect(startX, y + 1, 2, ROW_HEIGHT - 2)
      }
    }

    // 选中行的耗时数字贴在最右侧
    const selectedIndex = rows.findIndex((row) => row.seq === selectedSeq)
    if (selectedIndex >= 0) {
      const row = rows[selectedIndex]
      const y = HEADER_HEIGHT + selectedIndex * ROW_HEIGHT - scrollTop
      if (y >= HEADER_HEIGHT && y <= size.height) {
        context.textAlign = 'right'
        context.fillStyle = text
        context.font = '11px Consolas, monospace'
        context.fillText(formatMs(row.duration_ms), size.width - 8, y + ROW_HEIGHT / 2)
      }
    }
  }, [rows, scrollTop, size, selectedSeq, error])

  function handleClick(event: React.MouseEvent<HTMLCanvasElement>): void {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const y = event.clientY - rect.top
    const index = Math.floor((y - HEADER_HEIGHT + scrollTop) / ROW_HEIGHT)
    const row = rows[index]
    if (row) onSelect(row.seq)
  }

  const contentHeight = HEADER_HEIGHT + rows.length * ROW_HEIGHT

  return (
    <div className="waterfall" ref={wrapRef}>
      <div
        className="waterfall-scroll"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div style={{ height: contentHeight }} />
      </div>
      <canvas ref={canvasRef} className="waterfall-canvas" onClick={handleClick} />
      <div className="waterfall-legend">
        {[...new Set(rows.map((row) => row.resource_type ?? 'Other'))].slice(0, 10).map((type) => (
          <span key={type} className="legend-item">
            <i style={{ background: typeColor(type) }} />
            {type}
          </span>
        ))}
        {PROXY_SEGMENTS.map(([key, color, label]) => (
          <span key={key} className="legend-item">
            <i style={{ background: color }} />
            {label}
          </span>
        ))}
        <span className="legend-item">
          <i style={{ background: GAP_COLOR }} />
          排队
        </span>
        {Object.entries(MERGE_LABELS)
          .filter(([state]) => rows.some((row) => row.merge_state === state))
          .map(([state, label]) => (
            <span key={state} className="legend-item" title={label}>
              <i style={{ background: MERGE_COLORS[state], borderRadius: 1, width: 3 }} />
              {state}
            </span>
          ))}
        <span className="dim small">
          {rows.length} 条 · 起点 {rows.length ? formatTime(rows[0].start_ts) : '-'}
        </span>
      </div>
    </div>
  )
}
