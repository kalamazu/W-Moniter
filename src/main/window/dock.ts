import { screen, type BrowserWindow } from 'electron'
import type { DockSide, DockState, UiSettings } from '../../shared/types'
import { Win32Helper } from './helper'
import { readUiSettings, writeUiSettings } from './settings'

/** 控制窗口与浏览器之间留的缝（DIP） */
const GAP = 8

/**
 * 太窄就别贴了 —— 贴一条 100px 的缝没有意义。
 *
 * 注意这是「值不值得贴」的下限，**不是**浏览器能接受的宽度下限：Chrome 的窗口有硬下限
 * （实测挤到 ~515 DIP 就不再变窄）。所以控制窗口被拉得很宽时，浏览器会停在 515 并越过
 * 工作区右边缘溢出屏幕 —— 这时它的左边缘仍然贴着控制窗口，绝不反过来压住控制窗口。
 * 宁可溢出屏幕也不压住自己的窗口，这是有意的。
 */
const MIN_FIT_W = 320

/** 分屏时控制窗口的宽度下限，和 BrowserWindow 的 minWidth 对齐 */
const MIN_APP_W = 900

/** 没量到浏览器当前宽度时的默认值（DIP） */
const DEFAULT_CHROME_W = 1100

/** 分屏时浏览器最多占工作区宽度的比例 */
const CHROME_RATIO = 0.45

/** 跟随节流：拖拽时 move 事件每秒几十次，攒到 ~60fps 再落地 */
const SYNC_MS = 16

/**
 * 巡视间隔。
 *
 * 光靠 move/resize 事件是不够的：浏览器被关掉、或 Chrome 自己把窗口重建了（GPU 崩溃 /
 * 全屏切换 / 主题变更）时，控制窗口一动不动 —— 没人来查，状态就会一直停在「吸上了」，
 * 面板上写着吸附中、实际那个窗口早没了。所以开着吸附时每 3s 巡一次：
 * 在就什么都不做，不在就标 no-window 并重找（浏览器再起来也能自愈）。
 */
const WATCH_MS = 3000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 窗口吸附。
 *
 * 目标：让被监控的 Chrome 看起来像是这个应用的一部分 —— 控制窗口一动，它就跟着动。
 *
 * **不是嵌入**：浏览器仍然是独立进程、独立顶层窗口，这里只改它的位置尺寸
 * （`SetWindowPos`，不带 SWP_NOACTIVATE 之外的任何东西：不动 z 序、不抢焦点）。
 * 这么选是因为跨进程 SetParent 会让 Chrome 的窗口几何变成不可控 —— 而这个项目的
 * 抗节流方案（设计文档 D3）恰恰依赖几何是对的，踩过一次坑，不再踩第二次。
 *
 * 两条行为分开：
 *   - 打开吸附时做一次**分屏**（控制窗口靠一侧、浏览器占另一侧，都铺满工作区高度）
 *   - 之后只**跟随**：控制窗口被拖动/缩放时，浏览器贴着它，宽度吃剩下的空间
 */
export class WindowDock {
  private readonly win: BrowserWindow
  private readonly helper: Win32Helper
  private readonly profileDir: string
  private readonly settingsPath: string
  private readonly log: (line: string) => void

  private settings: UiSettings
  private hwnd: number | null = null
  /** 浏览器自己的宽度（DIP）。在「重新抓到窗口」那一刻量一次，之后跟着工作区收窄 */
  private chromeWidthDip: number | null = null
  private reason: string | undefined
  private timer: NodeJS.Timeout | null = null
  private watch: NodeJS.Timeout | null = null
  private dirty = false
  private busy = false
  private disposed = false

  private listener: (state: DockState) => void = () => {}
  /** 上一次推出去的状态（JSON）。拖动时每帧都会算出一个状态，但绝大多数帧没变化 */
  private lastPublished = ''
  /** 运行时实际用到的边和设置里存的不一样（让位那侧没空间了），退出时落盘 */
  private sideDirty = false

  constructor(options: {
    win: BrowserWindow
    scriptPath: string | null
    profileDir: string
    settingsPath: string
    log: (line: string) => void
  }) {
    this.win = options.win
    this.helper = new Win32Helper(options.scriptPath)
    this.profileDir = options.profileDir
    this.settingsPath = options.settingsPath
    this.log = options.log
    this.settings = readUiSettings(options.settingsPath, options.log)

    this.win.on('move', () => this.notifyGeometry())
    this.win.on('resize', () => this.notifyGeometry())
    this.win.on('minimize', () => void this.mirrorMinimize(true))
    this.win.on('restore', () => void this.mirrorMinimize(false))
  }

  onState(listener: (state: DockState) => void): void {
    this.listener = listener
  }

  state(): DockState {
    const state: DockState = {
      enabled: this.settings.dock.enabled,
      available: this.helper.available,
      attached: this.hwnd !== null,
      side: this.settings.dock.side
    }
    if (this.reason) state.reason = this.reason
    return state
  }

  /**
   * 启动时调用：设置里开着就直接进吸附态。
   *
   * 这里**必须**和用户点开关走同一条路（含分屏）：控制窗口启动时是居中 1360 宽，
   * 两边各只剩 ~170 DIP —— 光「跟随」的话 position() 直接回 no-room 然后就不再动了，
   * 用户会看到设置明明是开着的、浏览器却纹丝不动。
   */
  async restore(): Promise<void> {
    if (!this.settings.dock.enabled) return
    await this.engage(true)
  }

  /** 进吸附态：预热助手 → 起巡视 → （需要就）分屏让位 → 接上浏览器 */
  private async engage(split: boolean): Promise<void> {
    this.helper.warm()
    this.startWatch()
    if (split) await this.applySplit()
    await this.resnap()
  }

  async setEnabled(enabled: boolean, side?: DockSide): Promise<DockState> {
    const changed = this.settings.dock.enabled !== enabled
    // 布局是同文件里的另一块偏好，改吸附时不能顺手把它抹掉
    this.settings = {
      ...this.settings,
      dock: { enabled, side: side ?? this.settings.dock.side }
    }
    try {
      writeUiSettings(this.settingsPath, this.settings)
    } catch (error) {
      this.log(`[dock] 写 ${this.settingsPath} 失败：${(error as Error).message}`)
    }

    if (!enabled) {
      this.cancelTimer()
      this.stopWatch()
      this.reason = undefined
      // 关掉只是不再跟随，不把浏览器挪回去 —— 用户自己摆过的位置不该被我们改
      this.publish()
      return this.state()
    }

    await this.engage(changed)
    return this.state()
  }

  /** 重新找一次浏览器窗口并贴上去。按钮重复点、Chrome 重启过、切换 Profile 之后都走它 */
  async resnap(): Promise<DockState> {
    if (!this.settings.dock.enabled) return this.state()
    if (!this.helper.available) {
      this.reason = 'not-windows'
      this.publish()
      return this.state()
    }
    try {
      await this.position()
      this.reason = this.hwnd === null ? 'no-window' : undefined
    } catch (error) {
      this.reason = (error as Error).message
      this.log(`[dock] 吸附失败：${this.reason}`)
    }
    this.publish()
    return this.state()
  }

  /* ---------------- 内部 ---------------- */

  /**
   * 状态没变就不推。
   *
   * flush 是被窗口 move/resize 驱动到 60fps 的，而 enabled / attached / side 这些
   * 绝大多数帧都是一样的 —— 不挡一下，渲染层会每帧收一次 IPC，纯属白烧。
   */
  private publish(): void {
    const state = this.state()
    const json = JSON.stringify(state)
    if (json === this.lastPublished) return
    this.lastPublished = json
    this.listener(state)
  }

  private cancelTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.dirty = false
  }

  private notifyGeometry(): void {
    if (!this.settings.dock.enabled || this.disposed) return
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, SYNC_MS)
  }

  private async flush(): Promise<void> {
    if (this.disposed) return
    if (this.busy) return
    if (!this.dirty) return
    this.dirty = false
    this.busy = true
    try {
      await this.position()
      this.reason = this.hwnd === null ? 'no-window' : undefined
      this.publish()
    } catch (error) {
      this.reason = (error as Error).message
    } finally {
      this.busy = false
      if (this.dirty) this.notifyGeometry()
    }
  }

  private startWatch(): void {
    if (this.watch || this.disposed) return
    this.watch = setInterval(() => void this.tick(), WATCH_MS)
    this.watch.unref?.()
  }

  private stopWatch(): void {
    if (!this.watch) return
    clearInterval(this.watch)
    this.watch = null
  }

  /**
   * 巡一次：窗口还在就什么都不做（一次 rect 往返，实测 1.6ms），不在就重找。
   * 重找顺带把「浏览器重启后又被抓回来」这条也覆盖了。
   */
  private async tick(): Promise<void> {
    if (this.disposed || this.busy || !this.settings.dock.enabled) return
    if (this.hwnd !== null) {
      try {
        const rect = await this.helper.rect(this.hwnd)
        if (rect.width > 0) return
      } catch {
        /* 窗口没了，下面重找 */
      }
      this.hwnd = null
      // 先立刻推一次状态：面板不用等下面那次 WMI 查找（可能要几百毫秒）。
      // 不推的话会存在一个「attached=false 但说不出原因」的空档。
      this.reason = 'no-window'
      this.publish()
    }
    await this.resnap()
  }

  private async mirrorMinimize(minimize: boolean): Promise<void> {
    if (!this.settings.dock.enabled || !this.helper.available) return
    const hwnd = this.hwnd
    if (hwnd === null) return
    try {
      if (minimize) await this.helper.minimize(hwnd)
      else await this.helper.restore(hwnd)
    } catch {
      // 窗口没了就算了，下一次 resnap 会重新找
      this.hwnd = null
    }
  }

  /**
   * 打开吸附时的一次性分屏。
   *
   * 为什么必须动控制窗口：实测这台机器工作区 1707 DIP 宽、控制窗口 1360 宽居中，
   * 左右各只剩 ~170 DIP，浏览器根本挤不进去。只「跟随」不「让位」等于吸不住。
   */
  private async applySplit(): Promise<void> {
    if (!this.helper.available) return
    if (this.win.isMaximized()) this.win.unmaximize()
    if (this.win.isFullScreen()) this.win.setFullScreen(false)

    const wa = screen.getDisplayMatching(this.win.getBounds()).workArea
    /** 工作区里真正能分的宽度（中间那条 GAP 得先扣掉） */
    const usable = wa.width - GAP
    const want = this.chromeWidthDip ?? DEFAULT_CHROME_W

    // 先按「用户自己摆过的宽度」给浏览器分，但不能超过工作区的 45%（否则控制窗口就没地方了）
    let appWidth = usable - Math.max(MIN_FIT_W, Math.min(want, Math.round(wa.width * CHROME_RATIO)))
    if (appWidth < MIN_APP_W) {
      // 屏幕不够宽：控制窗口退到它自己的下限（和 BrowserWindow 的 minWidth 对齐），
      // 浏览器吃剩下那点 —— 宁可它窄，也不能让控制窗口碎掉
      appWidth = Math.max(MIN_FIT_W, Math.min(MIN_APP_W, usable - MIN_FIT_W))
    }
    // 极窄屏的最后兜底：两个都别小到不能用
    appWidth = Math.max(240, Math.round(appWidth))
    const chromeWidth = Math.max(160, Math.round(Math.min(want, usable - appWidth)))

    const appX =
      this.settings.dock.side === 'right' ? wa.x : wa.x + wa.width - appWidth
    this.win.setBounds({ x: appX, y: wa.y, width: appWidth, height: wa.height })
    this.log(
      `[dock] 分屏：控制窗口 ${appWidth}x${wa.height} @${appX},${wa.y}；浏览器将占 ${chromeWidth} 宽`
    )
    // setBounds 到窗口真正就位之间有一点延迟，等一拍再量
    await sleep(60)
    this.chromeWidthDip = chromeWidth
  }

  /** 确保手上有一个活的窗口句柄；失效就重新按 profile 目录找 */
  private async ensureWindow(): Promise<number | null> {
    if (this.hwnd !== null) {
      try {
        const rect = await this.helper.rect(this.hwnd)
        if (rect.width > 0) return this.hwnd
      } catch {
        // 窗口没了（Chrome 重启 / 被关掉 / 内部换过窗口），下面重新找
      }
      this.hwnd = null
    }

    const found = await this.helper.findWindow(this.profileDir)
    if (found === null) return null
    this.hwnd = found

    // 只在「刚抓到」这一刻量宽度，量到的是用户自己摆的尺寸；之后再量就是在量我们自己写的值
    if (this.chromeWidthDip === null) {
      try {
        const physical = await this.helper.rect(found)
        const dip = screen.screenToDipRect(this.win, physical)
        if (dip.width >= MIN_FIT_W) this.chromeWidthDip = Math.round(dip.width)
      } catch {
        /* 量不到就用默认值 */
      }
    }
    return found
  }

  /** 把浏览器贴到控制窗口旁边。几何算完再一次性转成物理坐标交给助手 */
  private async position(): Promise<void> {
    const hwnd = await this.ensureWindow()
    if (hwnd === null) return

    const app = this.win.getBounds()
    const wa = screen.getDisplayMatching(app).workArea

    const rightRoom = wa.x + wa.width - (app.x + app.width + GAP)
    const leftRoom = app.x - GAP - wa.x
    const prefer = this.settings.dock.side
    const other: DockSide = prefer === 'left' ? 'right' : 'left'
    const room: Record<DockSide, number> = { left: leftRoom, right: rightRoom }

    let side: DockSide = prefer
    if (room[prefer] < MIN_FIT_W) {
      side = room[other] >= MIN_FIT_W ? other : leftRoom >= rightRoom ? 'left' : 'right'
    }
    // 位置不够（比如控制窗口被拉得很宽、或者整个铺满工作区）时**也要贴上去**：
    // 早先这里是「没位置就 return，什么都不动」，结果控制窗口长过去之后浏览器被压在
    // 底下 —— 自己的窗口被盖住，比浏览器溢出屏幕难看得多。所以宁可让它溢出屏幕，
    // 也要保证「紧贴控制窗口的边、绝不重叠」这条不变量。
    const available = room[side]
    const width = Math.round(
      Math.max(MIN_FIT_W, Math.min(this.chromeWidthDip ?? DEFAULT_CHROME_W, available))
    )
    const x = Math.round(side === 'right' ? app.x + app.width + GAP : app.x - GAP - width)
    const y = Math.round(Math.max(wa.y, Math.min(app.y, wa.y + wa.height - MIN_FIT_W)))
    const height = Math.round(Math.max(MIN_FIT_W, Math.min(app.height, wa.y + wa.height - y)))

    const physical = screen.dipToScreenRect(this.win, { x, y, width, height })
    await this.helper.move(hwnd, physical)
    if (side !== this.settings.dock.side) {
      // 偏好那一侧让不出位置，实际落到了另一边。先记在内存里（position 是 60fps 的热路径，
      // 不能在这儿写盘），退出时统一落盘，下次启动就别再去挤没空间的那边了。
      this.settings = { ...this.settings, dock: { ...this.settings.dock, side } }
      this.sideDirty = true
    }
  }

  dispose(): void {
    this.disposed = true
    this.cancelTimer()
    this.stopWatch()
    if (this.sideDirty) {
      try {
        writeUiSettings(this.settingsPath, this.settings)
      } catch {
        /* 写不进去不影响退出 */
      }
    }
    this.helper.dispose()
  }
}