import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ControllerStatus, DockState, PanelId, PanelLayout } from '../../shared/types'
import type { WorkspaceOverview } from '../../shared/contracts/workspace'
import { DetailPanel } from './components/DetailPanel'
import { DomPanel } from './components/DomPanel'
import { ConsolePanel } from './components/ConsolePanel'
import { EndpointsPanel } from './components/EndpointsPanel'
import { EnvPanel } from './components/EnvPanel'
import { EventsPanel } from './components/EventsPanel'
import { GraphPanel } from './components/GraphPanel'
import { RequestTable } from './components/RequestTable'
import { RulePanel } from './components/RulePanel'
import { ScriptPanel } from './components/ScriptPanel'
import { SessionsPanel } from './components/SessionsPanel'
import { SitePanel } from './components/SitePanel'
import { StatsPanel } from './components/StatsPanel'
import { PANELS, PaneGrid } from './components/PaneGrid'
import { TitleBar } from './components/TitleBar'
import { Waterfall } from './components/Waterfall'
import { WsPanel } from './components/WsPanel'
import { WorkspaceBar } from './components/WorkspaceBar'
import { CommandPalette, type CommandItem } from './components/CommandPalette'
import { ContextDrawer } from './components/ContextDrawer'
import { WorkbenchNav, areaForPanel, type WorkbenchArea } from './components/WorkbenchNav'
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

/** 窗格上限，和主进程 window/settings.ts 里的 MAX_PANES 对齐 */
const MAX_PANES = 4

/** 默认布局 = 以前那个固定分栏的样子：左边请求列表，右边详情 */
const DEFAULT_LAYOUT: PanelLayout = { panes: ['list', 'detail'], sizes: [0.62, 0.38], dir: 'row' }

/** URL 里指定的开局面板（MONITOR_UI_TAB）。截图与演示脚本靠它，优先级高于落盘的布局 */
function urlPanel(): PanelId | null {
  const value = new URLSearchParams(window.location.search).get('tab')
  return PANELS.some((panel) => panel.id === value) ? (value as PanelId) : null
}

function initialLayout(): PanelLayout {
  const panel = urlPanel()
  if (!panel) return DEFAULT_LAYOUT
  // 列表 / 瀑布图历史上就是「主区 + 详情」两栏，其它面板是单栏铺满
  return panel === 'list' || panel === 'waterfall'
    ? { panes: [panel, 'detail'], sizes: [0.62, 0.38], dir: 'row' }
    : { panes: [panel], sizes: [1], dir: 'row' }
}

/** 允许从 URL 指定开局选中哪条请求（MONITOR_UI_SELECT），按 URL 子串匹配 */
function initialSelectNeedle(): string {
  return new URLSearchParams(window.location.search).get('sel') ?? ''
}

export default function App(): React.JSX.Element {
  const [status, setStatus] = useState<ControllerStatus | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceOverview | null>(null)
  const [filters, setFilters] = useState<UiFilters>(DEFAULT_FILTERS)
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null)
  // 开局要自动选中的那条请求；选中一次就把针清掉，之后不再干扰用户
  const selectNeedle = useRef(initialSelectNeedle())
  const [layout, setLayout] = useState<PanelLayout>(() => initialLayout())
  const [activePane, setActivePane] = useState(0)
  const [workbenchArea, setWorkbenchArea] = useState<WorkbenchArea>(() => areaForPanel(initialLayout().panes[0]))
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [commandOpen, setCommandOpen] = useState(false)
  const [drawer, setDrawer] = useState<'runtime' | 'settings' | null>(null)
  /** 落盘的布局恢复完了没有 —— 没恢复完别把默认值写回去，否则「上次摆的」会被默认盖掉 */
  const [layoutReady, setLayoutReady] = useState(false)
  const [waterfallLimit, setWaterfallLimit] = useState(2000)

  // 实时流量只用来「敲一下」：真正取数是去库里查，避免维护两份数据源
  const [liveTick, setLiveTick] = useState(0)
  const tickTimer = useRef<number | null>(null)

  // 吸附状态并进 status —— 面板只认 status 这一个数据源，不在别处再存一份
  const applyDock = useCallback((next: DockState): void => {
    setStatus((prev) => (prev ? { ...prev, dock: next } : prev))
  }, [])

  useEffect(() => {
    const offStatus = window.monitor.onStatus(setStatus)
    const offWorkspaces = window.monitor.onWorkspaces(setWorkspaces)
    const offDock = window.monitor.onDock(applyDock)
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
    void window.monitor.getWorkspaces().then((result) => {
      if (result.output) setWorkspaces(result.output)
    }).catch((error: unknown) => {
      console.error('读取工作区失败', error)
    })
    return () => {
      offStatus()
      offWorkspaces()
      offDock()
      offRecords()
      if (tickTimer.current !== null) window.clearTimeout(tickTimer.current)
    }
  }, [applyDock])

  // 工作区切换同时恢复它自己的布局。URL 显式指定面板时以 URL 为准（验收脚本按 ?tab= 截图）。
  useEffect(() => {
    if (!workspaces) return
    setSelectedSeq(null)
    if (urlPanel()) {
      setLayoutReady(true)
      return
    }
    let alive = true
    // 读取新工作区期间，不能把旧工作区的 layout 自动写进新目录。
    setLayoutReady(false)
    void window.monitor
      .uiSettings()
      .then((settings) => {
        if (alive && settings?.layout) setLayout(settings.layout)
      })
      .catch((error: unknown) => console.error('读取界面偏好失败', error))
      .finally(() => {
        if (alive) setLayoutReady(true)
      })
    return () => {
      alive = false
    }
  }, [workspaces?.activeWorkspaceId])

  // 布局一变就落盘。原来是 400ms 防抖 + 「关窗口补一次」，实测补不上：关窗口是
  // 直接拆渲染进程，React 的卸载清理根本不跑，防抖窗口里退出就真把那一下丢了。
  // 而拖动只在松手时提交一次 state，本来也没有写盘风暴要压 —— 那就直接写。
  useEffect(() => {
    if (!layoutReady) return
    void window.monitor
      .setUiSettings({ layout })
      .catch((error: unknown) => console.error('保存界面偏好失败', error))
  }, [layout, layoutReady])

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

  const toggleDock = (): void => {
    void window.monitor
      .setDock(!(status?.dock?.enabled ?? false))
      .then(applyDock)
      .catch((error: unknown) => console.error('切换窗口吸附失败', error))
  }

  const flipDock = (): void => {
    void window.monitor
      .setDock(true, status?.dock?.side === 'right' ? 'left' : 'right')
      .then(applyDock)
      .catch((error: unknown) => console.error('切换吸附侧失败', error))
  }

  /* ---- 工作区布局：加栏 / 换面板 / 关栏 / 换方向 / 复位 ---- */

  const pickPanel = useCallback((index: number, id: PanelId): void => {
    setLayout((prev) => ({
      ...prev,
      panes: prev.panes.map((current, i) => (i === index ? id : current))
    }))
  }, [])

  const closePane = useCallback((index: number): void => {
    setLayout((prev) => {
      if (prev.panes.length <= 1) return prev
      const panes = prev.panes.filter((_, i) => i !== index)
      return { ...prev, panes, sizes: panes.map(() => Number((1 / panes.length).toFixed(4))) }
    })
  }, [])

  /** 新栏放一个还没露面的面板；都露过面就放统计（纯只读，塞哪儿都不打扰） */
  const addPane = useCallback((): void => {
    setLayout((prev) => {
      if (prev.panes.length >= MAX_PANES) return prev
      const spare = PANELS.find((panel) => !prev.panes.includes(panel.id))?.id ?? 'stats'
      const panes = [...prev.panes, spare]
      return { ...prev, panes, sizes: panes.map(() => Number((1 / panes.length).toFixed(4))) }
    })
  }, [])

  const flipDir = useCallback((): void => {
    setLayout((prev) => ({ ...prev, dir: prev.dir === 'row' ? 'column' : 'row' }))
  }, [])

  const resetLayout = useCallback((): void => setLayout(DEFAULT_LAYOUT), [])

  const openPanel = useCallback((id: PanelId): void => {
    setLayout((prev) => ({ ...prev, panes: prev.panes.map((panel, index) => index === activePane ? id : panel) }))
    setWorkbenchArea(areaForPanel(id))
  }, [activePane])

  // 关闭当前栏或工作区恢复了更少的栏时，焦点必须收敛到仍存在的窗格；否则命令面板会对一个
  // 已不存在的 index 写入，表面上像是“命令没生效”。
  useEffect(() => {
    setActivePane((index) => Math.min(index, Math.max(0, layout.panes.length - 1)))
  }, [layout.panes.length])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        setCommandOpen((open) => !open)
      }
      if (event.key === 'Escape') {
        setCommandOpen(false)
        setDrawer(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const commands = useMemo<CommandItem[]>(() => [
    ...PANELS.map((panel) => ({ id: `view:${panel.id}`, title: `打开：${panel.label}`, detail: '在当前活动窗格显示', run: () => openPanel(panel.id) })),
    { id: 'layout:add', title: '工作区：添加分栏', detail: `最多 ${MAX_PANES} 栏`, run: addPane },
    { id: 'layout:direction', title: '工作区：切换排列方向', detail: '左右排列 / 上下排列', run: flipDir },
    { id: 'layout:reset', title: '工作区：恢复默认布局', detail: '请求列表 + 请求详情', run: resetLayout },
    { id: 'runtime', title: '打开：运行时上下文', detail: '查看 targets、连接和当前工作区', run: () => setDrawer('runtime') },
    { id: 'settings', title: '打开：设置', detail: '查看界面、快捷键和能力边界', run: () => setDrawer('settings') },
    { id: 'refresh', title: '操作：刷新请求数据', detail: '重新查询当前请求列表', run: requests.refresh }
  ], [addPane, flipDir, openPanel, requests.refresh, resetLayout])

  /** 面板渲染表。详情是独立面板：想「列表 + 详情」就摆两栏，只想看列表就摆一栏 */
  const renderPanel = useCallback(
    (id: PanelId): React.ReactNode => {
      switch (id) {
        case 'list':
          return (
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
          )
        case 'waterfall':
          return (
            <Waterfall
              query={query}
              liveTick={liveTick}
              selectedSeq={selectedSeq}
              onSelect={onSelect}
              limit={waterfallLimit}
            />
          )
        case 'detail':
          return <DetailPanel seq={selectedSeq} onClose={onClose} />
        case 'stats':
          return <StatsPanel liveTick={liveTick} />
        case 'scripts':
          return <ScriptPanel liveTick={liveTick} />
        case 'rules':
          return <RulePanel liveTick={liveTick} workspaceId={workspaces?.activeWorkspaceId ?? null} />
        case 'console':
          return <ConsolePanel liveTick={liveTick} />
        case 'env':
          return <EnvPanel liveTick={liveTick} />
        case 'dom':
          return <DomPanel liveTick={liveTick} />
        case 'sessions':
          return <SessionsPanel liveTick={liveTick} />
        case 'events':
          return <EventsPanel liveTick={liveTick} />
        case 'ws':
          return <WsPanel />
        case 'endpoints':
          return <EndpointsPanel liveTick={liveTick} />
        case 'graph':
          return <GraphPanel liveTick={liveTick} />
        case 'sites':
          return <SitePanel liveTick={liveTick} />
      }
    },
    [requests, query, liveTick, selectedSeq, onSelect, onClose, waterfallLimit]
  )

  return (
    <div className="app">
      <TitleBar
        status={status}
        state={state}
        matched={requests.total}
        targets={status?.targets ?? []}
        onRefresh={requests.refresh}
        onOpenCommand={() => setCommandOpen(true)}
        onToggleDock={toggleDock}
        onFlipDock={flipDock}
      />

      <WorkspaceBar overview={workspaces} onChange={setWorkspaces} />

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

      <div className="workbench">
        <WorkbenchNav
          area={workbenchArea}
          open={sidebarOpen}
          activePanel={layout.panes[activePane] ?? layout.panes[0]}
          onArea={setWorkbenchArea}
          onToggle={() => setSidebarOpen((open) => !open)}
          onOpenPanel={openPanel}
          onOpenRuntime={() => setDrawer('runtime')}
          onOpenSettings={() => setDrawer('settings')}
        />
        <main className="workbench-main">
          <div className="view-context">
            <button type="button" className="runtime-summary" onClick={() => setDrawer('runtime')} title="查看当前 target、连接和工作区">
              <span className={`dot dot-${state}`} />
              运行中 {status?.targets.filter((target) => target.attached).length ?? 0}/{status?.targets.length ?? 0} targets
            </button>
            <span className="view-context-title">{PANELS.find((panel) => panel.id === (layout.panes[activePane] ?? layout.panes[0]))?.label ?? '工作区'}</span>
            <span className="spacer" />
            <div className="tabs tabs-sm" aria-label="布局操作">
          <button type="button" className="tab" onClick={addPane} disabled={layout.panes.length >= MAX_PANES} title={`再加一栏（最多 ${MAX_PANES} 栏）`}>
              ＋ 分栏
          </button>
          <button type="button" className="tab" onClick={flipDir} title="各栏左右排 / 上下排">
            {layout.dir === 'row' ? '⇔ 左右' : '⇕ 上下'}
          </button>
          <button type="button" className="tab" onClick={resetLayout} title="回到默认布局（列表 + 详情）">
            ⟲ 复位
          </button>
        </div>
          </div>

      {(layout.panes.includes('list') || layout.panes.includes('waterfall')) && (
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
      )}

      <PaneGrid
        layout={layout}
        onLayout={setLayout}
        onPick={(index, id) => { setActivePane(index); pickPanel(index, id); setWorkbenchArea(areaForPanel(id)) }}
        activeIndex={activePane}
        onActivate={setActivePane}
        onClose={(index) => {
          setActivePane((current) => {
            const nextCount = Math.max(1, layout.panes.length - 1)
            return current > index ? current - 1 : Math.min(current, nextCount - 1)
          })
          closePane(index)
        }}
        renderPanel={renderPanel}
      />
        </main>
      </div>

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
      <CommandPalette open={commandOpen} items={commands} onClose={() => setCommandOpen(false)} />
      <ContextDrawer mode={drawer} status={status} state={state} workspaces={workspaces} onClose={() => setDrawer(null)} />
    </div>
  )
}
