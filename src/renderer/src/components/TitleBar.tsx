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
  onOpenCommand: () => void
  /** 开关窗口吸附（让浏览器贴到控制窗口旁边） */
  onToggleDock: () => void
  /** 换一侧贴。只有吸附着的时候才显示这个按钮 */
  onFlipDock: () => void
}

/** reason 是给机器看的，这里翻成人话；没见过的原样显示，别把原因吞掉 */
const REASON_TEXT: Record<string, string> = {
  'no-window': '没找到本应用启动的浏览器窗口（可能还没起来，或者已经被关掉）',
  'no-room': '屏幕工作区不够宽，挤不出浏览器要的位置',
  'not-windows': '只有 Windows 上可用（靠 win/dock-helper.ps1 调 Win32 接口）',
  'not-ready': '主进程还没准备好'
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
export function TitleBar({
  status,
  state,
  matched,
  targets,
  onRefresh,
  onOpenCommand,
  onToggleDock,
  onFlipDock
}: Props): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.monitor.isWindowMaximized().then(setMaximized)
    return window.monitor.onWindowMaximized(setMaximized)
  }, [])

  const storage = status?.storage
  const body = status?.body

  // 吸附按钮三态：不可用 / 开着且吸上了（蓝） / 开着但没吸上（黄）。
  // 「开着但没吸上」必须显形 —— 否则用户以为吸上了，实际浏览器根本没动。
  const dock = status?.dock
  const dockAvailable = dock?.available === true
  const dockOn = dock?.enabled === true && dockAvailable
  const dockAttached = dock?.attached === true
  const dockSideText = dock?.side === 'left' ? '左' : '右'
  const dockClass = dockOn ? (dockAttached ? ' is-on' : ' is-warn') : ''
  let dockTitle: string
  if (!dock) dockTitle = '窗口吸附：等主进程就绪'
  else if (!dock.available) dockTitle = REASON_TEXT['not-windows'] as string
  else if (dockOn && dockAttached)
    dockTitle = `浏览器已吸附在${dockSideText}侧。再点一次取消吸附（浏览器停在原地，不会被挪回去）`
  else if (dockOn)
    dockTitle = `已开启，但还没吸上：${dock.reason ? (REASON_TEXT[dock.reason] ?? dock.reason) : '未知原因'}`
  else dockTitle = '把浏览器贴到控制窗口旁边：不改浏览器归属，只同步它的位置尺寸'

  return (
    <header className="titlebar">
      <div className="tb-content">
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
        <button type="button" className="tb-btn tb-command" onClick={onOpenCommand} title="命令面板（Ctrl+Shift+P）">
          <span aria-hidden="true">⌕</span> 命令
          <kbd>Ctrl Shift P</kbd>
        </button>
        <button
          type="button"
          className={`tb-btn tb-dock${dockClass}`}
          disabled={!dockAvailable}
          title={dockTitle}
          onClick={onToggleDock}
        >
          <svg
            viewBox="0 0 16 16"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            aria-hidden="true"
          >
            <rect x="1.3" y="2.3" width="13.4" height="11.4" rx="1.7" />
            <path d="M9.6 2.5v11" />
          </svg>
          吸附
          {dockOn && dockAttached && <span className="tb-dock-side">{dockSideText}</span>}
        </button>
        {dockOn && (
          <button
            type="button"
            className="tb-btn tb-dock-flip"
            title={`换到${dockSideText === '左' ? '右' : '左'}侧`}
            onClick={onFlipDock}
          >
            <svg
              viewBox="0 0 16 16"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M2 5.4h9.6M9.2 3l2.4 2.4-2.4 2.4" />
              <path d="M14 10.6H4.4M6.8 8.2 4.4 10.6 6.8 13" />
            </svg>
          </button>
        )}
        <button type="button" className="tb-btn" onClick={onRefresh} title="重新拉取当前面板的数据">
          刷新
        </button>
        <button
          type="button"
          className="tb-btn tb-optional"
          onClick={() => void window.monitor.clear()}
          title="清空本次会话的采集缓冲（库里的历史不动）"
        >
          清空
        </button>
        <button
          type="button"
          className="tb-btn tb-optional"
          onClick={() => void window.monitor.openDataDir()}
          title="在资源管理器里打开数据目录"
        >
          数据目录
        </button>
      </div>
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
