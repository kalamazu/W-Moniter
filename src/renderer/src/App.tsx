import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ControllerStatus } from '../../shared/types'
import { DetailPanel } from './components/DetailPanel'
import { DomPanel } from './components/DomPanel'
import { ConsolePanel } from './components/ConsolePanel'
import { EnvPanel } from './components/EnvPanel'
import { RequestTable } from './components/RequestTable'
import { RulePanel } from './components/RulePanel'
import { ScriptPanel } from './components/ScriptPanel'
import { SessionsPanel } from './components/SessionsPanel'
import { StatsPanel } from './components/StatsPanel'
import { TitleBar } from './components/TitleBar'
import { Waterfall } from './components/Waterfall'
import { buildQuery, formatSize, type UiFilters } from './format'
import { useRequests } from './hooks/useRequests'

const DEFAULT_FILTERS: UiFilters = {
  search: '',
  resourceType: 'all',
  statusBand: 'all',
  targetType: 'all',
  onlyFailed: false,
  onlyWithBody: false
}

const RESOURCE_TYPES = [
  'Document',
  'Stylesheet',
  'Script',
  'Image',
  'Font',
  'XHR',
  'Fetch',
  'EventSource',
  'Media',
  'Manifest',
  'Ping',
  'Other'
]

type Tab = 'list' | 'waterfall' | 'scripts' | 'stats' | 'rules' | 'console' | 'env' | 'dom' | 'sessions'

const TABS: ReadonlyArray<readonly [Tab, string]> = [
  ['list', '请求列表'],
  ['waterfall', '瀑布图'],
  ['scripts', '脚本'],
  ['stats', '统计'],
  ['rules', '规则'],
  ['console', '控制台'],
  ['env', '环境'],
  ['dom', 'DOM'],
  ['sessions', '会话']
]

/** 允许从 URL 指定开局面板（MONITOR_UI_TAB），截图和演示时省得手点 */
function initialTab(): Tab {
  const value = new URLSearchParams(window.location.search).get('tab')
  return TABS.some(([key]) => key === value) ? (value as Tab) : 'list'
}

/** 允许从 URL 指定开局选中哪条请求（MONITOR_UI_SELECT），按 URL 子串匹配 */
function initialSelectNeedle(): string {
  return new URLSearchParams(window.location.search).get('sel') ?? ''
}

export default function App(): React.JSX.Element {
  const [status, setStatus] = useState<ControllerStatus | null>(null)
  const [filters, setFilters] = useState<UiFilters>(DEFAULT_FILTERS)
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null)
  // 开局要自动选中的那条请求；选中一次就把针清掉，之后不再干扰用户
  const selectNeedle = useRef(initialSelectNeedle())
  const [tab, setTab] = useState<Tab>(() => initialTab())
  const [waterfallLimit, setWaterfallLimit] = useState(2000)

  // 实时流量只用来「敲一下」：真正取数是去库里查，避免维护两份数据源
  const [liveTick, setLiveTick] = useState(0)
  const tickTimer = useRef<number | null>(null)

  useEffect(() => {
    const offStatus = window.monitor.onStatus(setStatus)
    const offRecords = window.monitor.onRequests((batch) => {
      if (batch.length === 0) return
      // 高频流量下别把渲染进程淹了，节流到 400ms 敲一次
      if (tickTimer.current !== null) return
      tickTimer.current = window.setTimeout(() => {
        tickTimer.current = null
        setLiveTick((value) => value + 1)
      }, 400)
    })
    void window.monitor.getStatus().then(setStatus)
    return () => {
      offStatus()
      offRecords()
      if (tickTimer.current !== null) window.clearTimeout(tickTimer.current)
    }
  }, [])

  const query = useMemo(() => buildQuery(filters), [filters])
  const storageReady = status?.storage.enabled ?? false
  const requests = useRequests(query, storageReady, liveTick)

  useEffect(() => {
    const needle = selectNeedle.current
    if (!needle || selectedSeq !== null) return
    const hit = requests.rows.find((row) => row.url.includes(needle))
    if (!hit) return
    selectNeedle.current = ''
    setSelectedSeq(hit.seq)
  }, [requests.rows, selectedSeq])

  const onSelect = useCallback((seq: number) => setSelectedSeq(seq), [])
  const onClose = useCallback(() => setSelectedSeq(null), [])

  const state = status?.state ?? 'idle'
  const storage = status?.storage
  const body = status?.body

  return (
    <div className="app">
      <TitleBar
        status={status}
        state={state}
        matched={requests.total}
        targets={status?.targets ?? []}
        onRefresh={requests.refresh}
      />

      {status?.error && <div className="banner banner-err">{status.error}</div>}
      {state === 'launching' && <div className="banner">正在启动内核…</div>}
      {state === 'connecting' && <div className="banner">正在建立 CDP 连接…</div>}
      {storage && !storage.enabled && (
        <div className="banner banner-err">
          存储未启用：{storage.error ?? '未知原因'} —— 列表与统计不可用，仅能看实时流水
        </div>
      )}
      {storage?.rowsIgnored ? (
        <div className="banner banner-err">
          有 {storage.rowsIgnored} 行被数据库约束丢弃，检查字段映射
        </div>
      ) : null}

      <div className="targets">
        <span className="targets-label">target</span>
        {status?.targets.map((target) => (
          <span
            key={target.targetId}
            className={`chip chip-xs ${target.attached ? 'chip-hot' : 'chip-dim'}`}
            title={`${target.type} · ${target.url}`}
          >
            {target.type}
            {target.url ? ` ${target.url.replace(/^https?:\/\//, '').slice(0, 28)}` : ''}
          </span>
        ))}
        {status?.targets.length === 0 && <span className="dim small">还没有 target</span>}

        <span className="spacer" />

        <div className="tabs">
          {TABS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`tab${tab === key ? ' tab-active' : ''}`}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="toolbar">
        <input
          className="search"
          placeholder="搜索 URL / host / 发起页面"
          value={filters.search}
          onChange={(event) => setFilters({ ...filters, search: event.target.value })}
        />
        <select
          value={filters.resourceType}
          onChange={(event) => setFilters({ ...filters, resourceType: event.target.value })}
        >
          <option value="all">全部类型</option>
          {RESOURCE_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
        <select
          value={filters.statusBand}
          onChange={(event) => setFilters({ ...filters, statusBand: event.target.value })}
        >
          <option value="all">全部状态</option>
          <option value="2xx">2xx</option>
          <option value="3xx">3xx</option>
          <option value="4xx">4xx</option>
          <option value="5xx">5xx</option>
          <option value="pending">无响应</option>
        </select>
        <select
          value={filters.targetType}
          onChange={(event) => setFilters({ ...filters, targetType: event.target.value })}
        >
          <option value="all">全部来源</option>
          <option value="page">page</option>
          <option value="iframe">iframe</option>
          <option value="worker">worker</option>
          <option value="service_worker">service_worker</option>
          <option value="shared_worker">shared_worker</option>
        </select>
        <label className="check">
          <input
            type="checkbox"
            checked={filters.onlyFailed}
            onChange={(event) => setFilters({ ...filters, onlyFailed: event.target.checked })}
          />
          只看失败
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={filters.onlyWithBody}
            onChange={(event) => setFilters({ ...filters, onlyWithBody: event.target.checked })}
          />
          有响应体
        </label>
        <button type="button" className="ghost" onClick={() => setFilters(DEFAULT_FILTERS)}>
          重置
        </button>
      </div>

      {tab === 'list' && (
        <div className="split">
          <RequestTable
            rows={requests.rows}
            total={requests.total}
            hasMore={requests.hasMore}
            loading={requests.loading}
            pendingNew={requests.pendingNew}
            selectedSeq={selectedSeq}
            onSelect={onSelect}
            onLoadMore={requests.loadMore}
            onRefresh={requests.refresh}
            onScrollTop={requests.notifyScrollTop}
          />
          <DetailPanel seq={selectedSeq} onClose={onClose} />
        </div>
      )}

      {tab === 'waterfall' && (
        <div className="split">
          <Waterfall
            query={query}
            liveTick={liveTick}
            selectedSeq={selectedSeq}
            onSelect={onSelect}
            limit={waterfallLimit}
          />
          <DetailPanel seq={selectedSeq} onClose={onClose} />
        </div>
      )}

      {tab === 'stats' && <StatsPanel liveTick={liveTick} />}

      {tab === 'scripts' && <ScriptPanel liveTick={liveTick} />}

      {tab === 'rules' && <RulePanel liveTick={liveTick} />}

      {tab === 'console' && <ConsolePanel liveTick={liveTick} />}

      {tab === 'env' && <EnvPanel liveTick={liveTick} />}

      {tab === 'dom' && <DomPanel liveTick={liveTick} />}

      {tab === 'sessions' && <SessionsPanel liveTick={liveTick} />}

      <footer className="foot">
        <span className="mono dim">{status?.browserPath ?? '未找到内核'}</span>
        {storage?.dbPath && <span className="mono dim">库: {storage.dbPath}</span>}
        {storage?.enabled && (
          <span className="mono dim">
            node {storage.nodeVersion} · 队列 {storage.queueDepth} · 丢弃{' '}
            {storage.droppedRequests}/{storage.droppedBodies} · 更新 {storage.rowsUpdated} · body 重试{' '}
            {storage.bodiesRetried}
          </span>
        )}
        {body && (
          <span className="mono dim">
            pause {body.paused} 取回 {body.captured} · {formatSize(body.capturedBytes)} · 超限{' '}
            {body.tooLarge} 流式 {body.streaming} 超时 {body.timeouts} 异常 {body.errors}
          </span>
        )}
      </footer>
    </div>
  )
}
