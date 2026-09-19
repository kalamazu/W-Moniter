import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { PipeTransport } from './pipe-transport'

export interface LaunchOptions {
  executablePath: string
  userDataDir: string
  url: string
  headless?: boolean
  windowSize?: string
  extraArgs?: string[]
}

export interface LaunchedBrowser {
  child: ChildProcess
  transport: PipeTransport
  args: string[]
}

/**
 * 构造启动参数。
 * 原则：只加"必须"的 —— 每一个参数都是一处可被识别的特征。
 */
function buildArgs(options: LaunchOptions): string[] {
  const args = [
    // Chrome 136+ 起远程调试必须配非默认 user-data-dir
    `--user-data-dir=${options.userDataDir}`,
    // 走 fd 3/4，不开网络端口，netstat 扫不到
    '--remote-debugging-pipe',
    '--no-first-run',
    '--no-default-browser-check',
    // 去掉 navigator.webdriver 标记
    '--disable-blink-features=AutomationControlled',
    `--window-size=${options.windowSize ?? '1280,900'}`,
    '--window-position=60,40',
    // 被监控窗口被别的窗口盖住时，Chromium 按「窗口不可见」节流渲染：鼠标事件的回执被
    // 拖到 ~5s、mousemove/wheel 被按帧合并（实测一次 80 点轨迹 80s、滚轮总量少 12%、
    // 轨迹里凭空出现 637px 的跳步）。这三个开关关掉的是节流本身，不改任何页面可见状态 ——
    // 窗口真在前台时本来就不节流。（test-ui-perf 量渲染时踩过同一个坑，那边是给控制窗口加的。）
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion'
  ]

  if (options.headless) args.push('--headless=new')
  if (options.extraArgs?.length) args.push(...options.extraArgs)

  // URL 必须放最后，否则 Chrome 会打开默认页
  args.push(options.url)
  return args
}

export function launchBrowser(options: LaunchOptions): LaunchedBrowser {
  const args = buildArgs(options)

  const child = spawn(options.executablePath, args, {
    // fd 3 = 父→子，fd 4 = 子→父，与 Chromium 的约定一致
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    windowsHide: false
  })

  const toBrowser = child.stdio[3] as unknown as Writable | undefined
  const fromBrowser = child.stdio[4] as unknown as Readable | undefined

  if (!toBrowser || !fromBrowser) {
    throw new Error('无法取得 fd 3/4，--remote-debugging-pipe 不可用')
  }

  const transport = new PipeTransport({ toBrowser, fromBrowser })
  return { child, transport, args }
}
