import { useEffect, useState } from 'react'
import type { ControllerState, ControllerStatus, TargetInfo } from '../../../shared/types'
import { formatCount } from '../format'

interface Props {
  status: ControllerStatus | null
  state: ControllerState
  /** 当前筛选命中的条数（在 App 里算好，标题栏只负责显示） */
  matched: number
  /** 附着的 target 数 / 总数，跟状态灯一起说明「内核现在连上了几个页面」 */
  targets: TargetInfo[]
  onRefresh: () => void
}

const STATE_TEXT: Record<ControllerState, string> = {
  idle: '待机',
  launching: '启动内核中',
  connecting: '建立连接中',
  connected: '已连接',
  error: '出错'
}

/**
 * 自绘标题栏。
 *
 * 窗口是 `frame: false` 起的（见 src/main/index.ts）—— 系统标题栏一个像素都不留，
 * 所以**拖动、最小化、最大化、关闭全都得在这里实现**：
 *
 *   - 拖动：整条 `.titlebar` 上 `-webkit-app-region: drag`。里面的按钮必须
 *     `no-drag`，否则点「刷新」会变成拖窗口（CSS 里统一给了）
 *   - 三键：走 IPC。主进程用 `BrowserWindow.fromWebContents(event.sender)` 找窗口，
 *     这样将来多窗口也各管各的，不用在渲染层记窗口身份
 *
 * 双击标题栏 = 最大化/还原**故意不在渲染层实现**：`-webkit-app-region: drag` 的区域
 * 在 Windows 上就是窗口标题栏（HTCAPTION），系统自己处理双击最大化与拖边吸附。
 * 实测（SendInput 级真实鼠标）：带不带渲染层 onDoubleClick，`monitor:window-maximized`
 * 的事件序列都是 `[true]` —— caption 区的 dblclick 压根不派发给渲染进程，那个处理器
 * 是纯多余的；留着只会在别的平台或 Electron 版本上多出一次「和系统对切」的机会。
 *
 * 另外把几个**全局**动作收上来（刷新 / 清空 / 数据目录）：它们不属于任何一个面板，
 * 原先散在页脚和工具栏里，现在统一放顶栏右侧。
 */
export function TitleBar({ status, state, matched, targets, onRefresh }: Props): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.monitor.isWindowMaximized().then(setMaximized)
    return window.monitor.onWindowMaximized(setMaximized)
  }, [])

  const storage = status?.storage
  const body = status?.body

  return (
    <header className="titlebar">
      <span className="tb-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7">
          <rect x="2.6" y="4.4" width="18.8" height="13" rx="2.6" />
          <path d="M8.2 20.6h7.6" strokeLinecap="round" />
          <circle cx="12" cy="10.9" r="3.1" />
        </svg>
      </span>
      <span className="tb-name">Chromium 监控容器</span>

      <span className={`dot dot-${state}`} />
      <span className="tb-state">{STATE_TEXT[state]}</span>
      <span className="chip">Profile {status?.profile ?? '-'}</span>
      {status?.browserVersion && <span className="chip chip-dim">{status.browserVersion}</span>}
      {status?.bodyMode && <span className="chip chip-dim">body: {status.bodyMode}</span>}

      <div className="tb-metrics">
        <Metric value={status?.requestCount ?? 0} label="本次采集" />
        <Metric value={matched} label="命中筛选" />
        <Metric value={storage?.rowsWritten ?? 0} label="已落库" />
        <Metric value={body?.captured ?? 0} label="body" />
        <Metric value={status?.scriptCount ?? 0} label="脚本" />
        <Metric
          value={targets.filter((target) => target.attached).length}
          suffix={`/${targets.length}`}
          label="target"
        />
      </div>

      <div className="tb-actions">
        <button type="button" className="tb-btn" onClick={onRefresh} title="重新拉取当前面板的数据">
          刷新
        </button>
        <button
          type="button"
          className="tb-btn"
          onClick={() => void window.monitor.clear()}
          title="清空本次会话的采集缓冲（库里的历史不动）"
        >
          清空
        </button>
        <button
          type="button"
          className="tb-btn"
          onClick={() => void window.monitor.openDataDir()}
          title="在资源管理器里打开数据目录"
        >
          数据目录
        </button>
      </div>

      <div className="tb-win">
        <button
          type="button"
          className="tb-win-btn"
          title="最小化"
          onClick={() => void window.monitor.windowMinimize()}
        >
          <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
            <path d="M0 5.5h10" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        </button>
        <button
          type="button"
          className="tb-win-btn"
          title={maximized ? '还原' : '最大化'}
          onClick={() => void window.monitor.windowToggleMaximize().then(setMaximized)}
        >
          {maximized ? (
            <svg viewBox="0 0 10 10" width="10" height="10" fill="none" aria-hidden="true">
              <path d="M2.5 0.5h7v7" stroke="currentColor" strokeWidth="1.1" />
              <rect x="0.5" y="2.5" width="6.5" height="6.5" rx="0.6" stroke="currentColor" strokeWidth="1.1" />
            </svg>
          ) : (
            <svg viewBox="0 0 10 10" width="10" height="10" fill="none" aria-hidden="true">
              <rect x="0.5" y="0.5" width="9" height="9" rx="0.8" stroke="currentColor" strokeWidth="1.1" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="tb-win-btn tb-win-close"
          title="关闭"
          onClick={() => void window.monitor.windowClose()}
        >
          <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
            <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        </button>
      </div>
    </header>
  )
}

function Metric({
  value,
  label,
  suffix
}: {
  value: number
  label: string
  suffix?: string
}): React.JSX.Element {
  return (
    <span className="metric">
      <b>{formatCount(value)}</b>
      {suffix ?? ''} {label}
    </span>
  )
}