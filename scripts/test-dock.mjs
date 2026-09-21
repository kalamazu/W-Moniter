#!/usr/bin/env node
/**
 * 窗口吸附验收（§窗口吸附）。
 *
 * 验的是用户点得到的那条路：控制窗口里的 window.monitor.setDock()，走真实 preload 桥
 * → IPC → WindowDock → win/dock-helper.ps1 → SetWindowPos。
 *
 * 判据来自一个**独立的** Win32 探针（work/dock-test-win.ps1）：它自己枚举窗口、
 * 自己读 GetWindowRect。用被测代码的助手来判被测代码，等于没测。
 *
 * 这台机器的工作区是 1707 DIP 宽，控制窗口 minWidth=900 —— 所以「打开吸附时
 * 先把控制窗口分屏让位」是必须的，不是可选优化：不让位的话左右各只剩 ~170 DIP，
 * 浏览器根本挤不进去。B2 就是在证这一条。
 *
 * 注意：这是**真窗口**验收，会挪动、缩放、最小化控制窗口，跑的时候别碰鼠标。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { launchApp, makeChecker, sleep, ROOT } from './app-harness.mjs'
import { startOrigin } from './test-origin.mjs'

const PORT = 9714
const SHOT_DIR = join(ROOT, 'work', 'dock-shots')
mkdirSync(SHOT_DIR, { recursive: true })

/** 设计文档里定的缝：控制窗口和浏览器之间留 8 DIP */
const GAP_DIP = 8
/** 断言容差（物理像素）。窗口边框、SetWindowPos 的取整都会带来 1~2px 误差 */
const TOL = 6

const PS = join(
  process.env['SystemRoot'] ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)

/* ------------------------------------------------------------ 独立探针 */

/** work/dock-test-win.ps1 的客户端：常驻进程，一行一条命令 */
class Probe {
  constructor() {
    this.child = spawn(
      PS,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(ROOT, 'work', 'dock-test-win.ps1')
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    )
    this.slots = new Map()
    this.nextId = 1
    this.stderr = ''
    this.child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-800)
    })
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      const text = line.trim()
      if (!text) return
      const parts = text.split(' ')
      const slot = this.slots.get(parts[0])
      if (!slot) return
      this.slots.delete(parts[0])
      if (parts[1] === 'ok') slot.resolve(parts.slice(2))
      else slot.reject(new Error(parts.slice(2).join(' ')))
    })
  }

  call(command, timeoutMs = 30000) {
    const id = String(this.nextId++)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.slots.delete(id)
        reject(new Error('探针超时：' + command + ' ' + this.stderr.slice(0, 200)))
      }, timeoutMs)
      this.slots.set(id, { resolve, reject, timer })
      this.child.stdin.write(id + ' ' + command + '\n')
    })
  }

  async rects(profileDir) {
    const tokens = await this.call('rects ' + b64(profileDir))
    const kv = {}
    for (const token of tokens) {
      const at = token.indexOf('=')
      if (at > 0) kv[token.slice(0, at)] = token.slice(at + 1)
    }
    const box = (text) => {
      const [left, top, right, bottom] = (text ?? '0,0,0,0').split(',').map(Number)
      return { left, top, right, bottom, width: right - left, height: bottom - top }
    }
    return {
      app: box(kv.app),
      chrome: box(kv.chrome),
      fg: Number(kv.fg),
      appIconic: kv.appiconic === '1',
      chromeIconic: kv.chromeiconic === '1',
      appHwnd: Number(kv.apphwnd),
      chromeHwnd: Number(kv.chromehwnd)
    }
  }

  moveApp(x, y, width, height) {
    return this.call(`moveapp ${Math.round(x)} ${Math.round(y)} ${Math.round(width)} ${Math.round(height)}`)
  }

  /** 把控制窗口亮出来并抢一下前台（后面「不抢焦点」那条要靠它当起点） */
  async showApp() {
    const tokens = await this.call('showapp')
    return {
      visible: tokens[0] === 'True',
      focused: String(tokens[2] ?? '').replace('now=', '') === 'True'
    }
  }

  /** 抢前台：最小化再还原（SW_RESTORE 会激活窗口） */
  async focusApp() {
    const [value] = await this.call('focusapp')
    return value === 'True'
  }

  minApp() {
    return this.call('minapp')
  }

  unminApp() {
    return this.call('unminapp')
  }

  killChrome(profileDir) {
    return this.call(`killchrome ${b64(profileDir)}`, 60000)
  }

  dispose() {
    try {
      this.child.stdin.write('0 quit\n')
    } catch {
      /* 已经断了 */
    }
    setTimeout(() => {
      try {
        this.child.kill()
      } catch {
        /* 已经退了 */
      }
    }, 500).unref?.()
  }
}

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64')

/** 断言消息里带上实测矩形，不然失败了还得回去翻日志 */
const box = (rect) => `${rect.left},${rect.top} ${rect.width}x${rect.height}`

/**
 * 两个窗口之间那条缝的实测值。贴在右边时是 chrome.left - app.right，
 * 贴在左边时是 app.left - chrome.right —— 两种都得认（换边之后关系是反的，
 * 之前只按右边判，重启恢复（设置里是 left）就永远等不到）。
 */
const gapOf = (rects) =>
  Math.min(
    Math.abs(rects.chrome.left - (rects.app.right + gapPhys)),
    Math.abs(rects.app.left - (rects.chrome.right + gapPhys))
  )

/* ------------------------------------------------------------------ */

const { check, assert, report } = makeChecker()
const dataDir = mkdtempSync(join(tmpdir(), 'dock-'))
const profileDir = join(dataDir, 'browser-profile')
const settingsPath = join(dataDir, 'ui-settings.json')
const quitFile = join(dataDir, 'quit.txt')
/** 第二次启动得换一个 quit 文件：上一个已经存在了，进来就会被判定成「该收工了」 */
const quitFile2 = join(dataDir, 'quit2.txt')
const origin = await startOrigin(0)
console.log('  数据目录 ' + dataDir)

const probe = new Probe()
await probe.call('rects ' + b64(profileDir))

const readSettings = () => {
  if (!existsSync(settingsPath)) return null
  try {
    return JSON.parse(readFileSync(settingsPath, 'utf8'))
  } catch {
    return null
  }
}

const launch = (quit) =>
  launchApp({
    url: 'http://127.0.0.1:' + origin.port + '/',
    dataDir,
    port: PORT,
    tab: 'list',
    shotDir: SHOT_DIR,
    extraEnv: { MONITOR_QUIT_FILE: quit }
  })

/** 等吸附落定（含一次 resnap 的异步窗口查找） */
const waitFor = async (fn, label, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await sleep(300)
  }
  throw new Error('等不到：' + label + '（最后状态 ' + JSON.stringify(last) + '）')
}

let app = await launch(quitFile)
let status = await app.waitConnected(1)

// app-harness 用 spawn(windowsHide: true) 起 electron —— 那是 GUI 程序，第一个 ShowWindow
// 会被 STARTUPINFO 的 SW_HIDE 按下去：窗口有真实几何，但 IsWindowVisible=false，
// 于是最小化/还原根本不会发生（测的不是代码，是环境）。先显式亮出来再测。
const shown = await probe.showApp()
const focused = await probe.focusApp()
check('A0 控制窗口可见、且拿到了前台（B5 要用它当起点）', () => {
  assert(shown.visible === true, 'ShowWindow 之后窗口还是不可见')
  assert(focused === true, '最小化再还原之后控制窗口仍不是前台窗口')
})

// 工作区（DIP）—— 面板里读的是 screen.*，和主进程 screen.getDisplayMatching().workArea 同一个口径
const screenInfo = await app.evaluate(
  '({ left: screen.availLeft, top: screen.availTop, width: screen.availWidth, height: screen.availHeight, dpr: devicePixelRatio })'
)
const dpr = screenInfo.dpr
const gapPhys = GAP_DIP * dpr
const work = {
  left: Math.round(screenInfo.left * dpr),
  top: Math.round(screenInfo.top * dpr),
  right: Math.round((screenInfo.left + screenInfo.width) * dpr),
  bottom: Math.round((screenInfo.top + screenInfo.height) * dpr)
}
console.log(
  `  工作区 ${screenInfo.width}x${screenInfo.height} DIP @${screenInfo.left},${screenInfo.top}，dpr=${dpr}`
)

/* -------------------------------------------------- A 前置：起点与配置 */

check('A1 status 里带 dock 状态，且 Windows 上 available=true', () => {
  assert(status.dock, 'status.dock 缺失')
  assert(status.dock.available === true, 'available 应为 true，实际 ' + String(status.dock.available))
})

check('A2 干净的 dataDir 上默认不开吸附', () => {
  assert(status.dock.enabled === false, 'enabled 应为 false')
  assert(status.dock.attached === false, '没开吸附不该有 attached')
  assert(readSettings() === null || readSettings().dock.enabled === false, '不该已经落盘成开启')
})

check('A3 抗节流三开关还在（吸附不碰启动参数，设计文档 D3）', () => {
  const args = status.browserArgs.join(' ')
  for (const flag of [
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    'CalculateNativeWinOcclusion'
  ]) {
    assert(args.includes(flag), '启动参数里少了 ' + flag)
  }
})

const before = await probe.rects(profileDir)
check('A4 开关之前浏览器是按启动参数摆在 (60,40)、1280x900 DIP 的', () => {
  assert(before.chromeHwnd > 0, '独立探针没找到浏览器窗口')
  assert(Math.abs(before.chrome.left - 60 * dpr) <= 3, 'left=' + before.chrome.left)
  assert(Math.abs(before.chrome.top - 40 * dpr) <= 3, 'top=' + before.chrome.top)
  assert(Math.abs(before.chrome.width - 1280 * dpr) <= 3, 'width=' + before.chrome.width)
})

/* ------------------------------------------------------ B 打开吸附分屏 */

const docked = await app.evaluate('window.monitor.setDock(true)')
await sleep(400)
const afterOn = await probe.rects(profileDir)

check('B1 setDock(true) 回「吸上了」，默认贴右侧', () => {
  assert(docked.enabled === true, 'enabled 应为 true')
  assert(docked.available === true, 'available 应为 true')
  assert(docked.attached === true, 'attached 应为 true，reason=' + String(docked.reason))
  assert(docked.side === 'right', 'side 应为 right，实际 ' + String(docked.side))
})

check('B2 控制窗口让到左侧并铺满工作区高度（不让位就挤不下浏览器）', () => {
  assert(Math.abs(afterOn.app.left - work.left) <= TOL, `app.left=${afterOn.app.left} 应为 ${work.left}`)
  assert(Math.abs(afterOn.app.top - work.top) <= TOL, `app.top=${afterOn.app.top}`)
  assert(Math.abs(afterOn.app.height - (work.bottom - work.top)) <= TOL, `app.height=${afterOn.app.height}`)
  assert(afterOn.app.width < before.app.width, '控制窗口应该变窄让位')
})

check('B3 浏览器贴到右侧、铺满工作区高度、中间正好留 8 DIP', () => {
  assert(Math.abs(afterOn.chrome.left - (afterOn.app.right + gapPhys)) <= TOL,
    `gap 应为 ${gapPhys}px，实际 ${afterOn.chrome.left - afterOn.app.right}`)
  assert(Math.abs(afterOn.chrome.right - work.right) <= TOL, `chrome.right=${afterOn.chrome.right} 应贴 ${work.right}`)
  assert(Math.abs(afterOn.chrome.top - afterOn.app.top) <= TOL, '两个窗口顶边应对齐（都从工作区顶开始）')
  assert(Math.abs(afterOn.chrome.bottom - afterOn.app.bottom) <= TOL, '两个窗口底边应对齐（都铺满工作区）')
})

check('B4 浏览器拿到的是「用户自己摆的宽度」和工作区 45% 里的小者', () => {
  const expected = Math.min(1280, Math.round(screenInfo.width * 0.45)) * dpr
  assert(Math.abs(afterOn.chrome.width - expected) <= TOL,
    `chrome.width=${afterOn.chrome.width} 期望 ${expected}`)
})

check('B5 挪浏览器没有抢焦点（SWP_NOACTIVATE）', () => {
  // 起点是 A0 抢到的前台（控制窗口）。吸附一开就挪了浏览器，这里看前台有没有被换走
  assert(before.fg === before.appHwnd, `起点前台不是控制窗口（${before.fg} vs ${before.appHwnd}）`)
  assert(afterOn.fg === afterOn.appHwnd,
    `前台被换成了 ${afterOn.fg}（控制=${afterOn.appHwnd} 浏览器=${afterOn.chromeHwnd}）`)
})

await app.shot('dock-on.png')

/* ------------------------------------------------------------ C 跟随 */

const step = (dx, dy, dw, dh) => async (base) => {
  const target = {
    x: base.app.left + dx,
    y: base.app.top + dy,
    width: base.app.width + dw,
    height: base.app.height + dh
  }
  await probe.moveApp(target.x, target.y, target.width, target.height)
  await sleep(260)
  return probe.rects(profileDir)
}

// C1：整体挪一段，浏览器得跟着挪同样的距离
const moved = await step(240, 0, 0, 0)(afterOn)
check('C1 拖动控制窗口，浏览器跟着挪同样的距离、缝不变', () => {
  const dxApp = moved.app.left - afterOn.app.left
  const dxChrome = moved.chrome.left - afterOn.chrome.left
  assert(Math.abs(dxApp - dxChrome) <= TOL, `控制窗口动了 ${dxApp}，浏览器只动了 ${dxChrome}`)
  assert(Math.abs(moved.chrome.left - (moved.app.right + gapPhys)) <= TOL, '缝变了')
})

// C2：连续拖拽，每一步都跟得上（不是「拖完了才追」）
let cursor = moved
let lagged = 0
const trail = []
for (let i = 1; i <= 12; i++) {
  const dx = i % 2 === 0 ? 90 : -90
  cursor = await step(dx, 0, 0, 0)(cursor)
  const gap = cursor.chrome.left - cursor.app.right
  trail.push(gap)
  if (Math.abs(gap - gapPhys) > TOL) lagged++
}
check('C2 连续 12 次拖动，每一次浏览器都贴在 8 DIP 上（没有滞后累积）', () => {
  assert(lagged === 0, `有 ${lagged} 步没跟上，实际缝=${trail.join(',')}`)
})

// C3：控制窗口变宽 → 浏览器被挤窄；变窄 → 浏览器回到自己的上限
// 摆到最左再加宽 340 物理像素：留给浏览器的宽度仍在它自己能接受的范围内
// （Chrome 窗口有 ~515 DIP 的硬下限，低于它的请求它不认，见 C3c）
await probe.moveApp(work.left, work.top, afterOn.app.width + 340, work.bottom - work.top)
await sleep(340)
const narrow = await probe.rects(profileDir)
check('C3a 拉宽控制窗口，浏览器被挤窄，但仍贴着工作区右边', () => {
  const at = `app=${box(narrow.app)} chrome=${box(narrow.chrome)} 工作区右边=${work.right}`
  assert(narrow.chrome.width < cursor.chrome.width,
    `${cursor.chrome.width} → ${narrow.chrome.width} 应该变窄（${at}）`)
  assert(Math.abs(narrow.chrome.left - (narrow.app.right + gapPhys)) <= TOL, '缝变了：' + at)
  assert(Math.abs(narrow.chrome.right - work.right) <= TOL, '右边没贴住：' + at)
})

// C3c：再拉宽，把浏览器挤到它自己的下限。Chrome 的窗口宽度有硬下限（实测 ≈515 DIP），
// 我们再要更窄它也只会停在 515 —— 这时右边的确会溢出工作区，但**左边绝不越过来压住
// 控制窗口**，这才是这条不变量：
await probe.moveApp(work.left, work.top, afterOn.app.width + 700, work.bottom - work.top)
await sleep(340)
const squeezed = await probe.rects(profileDir)
check('C3c 挤到浏览器下限后不再变窄，且绝不压到控制窗口身上', () => {
  const at = `app=${box(squeezed.app)} chrome=${box(squeezed.chrome)}`
  assert(squeezed.chrome.left >= squeezed.app.right + gapPhys - TOL, '浏览器压到控制窗口上了：' + at)
  assert(Math.abs(squeezed.chrome.left - (squeezed.app.right + gapPhys)) <= TOL, '缝变了：' + at)
  assert(squeezed.chrome.width >= 500 * dpr - TOL,
    `浏览器宽度 ${squeezed.chrome.width} 小于它自己的下限（应为 ~${Math.round(500 * dpr)}）：${at}`)
  assert(squeezed.chrome.width <= narrow.chrome.width + TOL, '这个方向不该变宽：' + at)
})

// 缩回去没法用「减一点宽度」——BrowserWindow 的 minWidth=900 DIP 会被 WM_GETMINMAXINFO
// 挡回来（SetWindowPos 拿到的宽度不等于给的那个）。所以直接摆回分屏时的几何。
await probe.moveApp(work.left, work.top, afterOn.app.width, work.bottom - work.top)
await sleep(320)
const wide = await probe.rects(profileDir)
check('C3b 控制窗口恢复分屏宽度，浏览器宽度回到自己的上限', () => {
  const cap = Math.min(1280, Math.round(screenInfo.width * 0.45)) * dpr
  assert(Math.abs(wide.chrome.width - cap) <= TOL, `chrome.width=${wide.chrome.width} 期望回到 ${cap}`)
  assert(Math.abs(wide.chrome.left - (wide.app.right + gapPhys)) <= TOL, '缝变了')
})

// C4：换边。先把控制窗口挪到屏幕右侧 —— 左边空出来，吸附才谈得上换过去。
// （让位规则是「优先用设置里的边，那边没地方才换」：控制窗口占到右半边之后，
//   它右边只剩一条缝，于是自动换到左，用户不用手动切。）
await probe.moveApp(work.right - afterOn.app.width, work.top, afterOn.app.width, work.bottom - work.top)
await sleep(420)
const autoLeft = await probe.rects(profileDir)
check('C4a 控制窗口占到右边之后，吸附自己换到左侧', () => {
  // 换到左边之后贴边关系也跟着换：浏览器贴工作区左边，控制窗口在它右边隔一条缝
  const at = `app=${box(autoLeft.app)} chrome=${box(autoLeft.chrome)}`
  assert(Math.abs(autoLeft.chrome.left - work.left) <= TOL,
    `chrome.left=${autoLeft.chrome.left} 应贴 ${work.left}（${at}）`)
  assert(Math.abs(autoLeft.app.left - (autoLeft.chrome.right + gapPhys)) <= TOL,
    `缝=${autoLeft.app.left - autoLeft.chrome.right} 应为 ${gapPhys}（${at}）`)
})

const flipState = await app.evaluate("window.monitor.setDock(true, 'left')")
await sleep(400)
const flipped = await probe.rects(profileDir)
check('C4b 显式指定左侧仍是左贴，且状态里记的就是 left', () => {
  const at = `app=${box(flipped.app)} chrome=${box(flipped.chrome)}`
  assert(flipState.side === 'left', 'side 应为 left，实际 ' + String(flipState.side))
  assert(Math.abs(flipped.chrome.left - work.left) <= TOL, '浏览器没贴左边：' + at)
  assert(Math.abs(flipped.app.left - (flipped.chrome.right + gapPhys)) <= TOL, '缝不对：' + at)
  assert(Math.abs(flipped.chrome.bottom - flipped.app.bottom) <= TOL, '底边应对齐：' + at)
})

await app.shot('dock-left.png')

/* ------------------------------------------------------- D 最小化镜像 */

await probe.minApp()
await sleep(700)
const minRects = await probe.rects(profileDir)
check('D1 最小化控制窗口 → 浏览器跟着最小化', () => {
  assert(minRects.appIconic === true, '控制窗口没最小化')
  assert(minRects.chromeIconic === true, '浏览器没跟着最小化')
})

await probe.unminApp()
await sleep(900)
const unminRects = await probe.rects(profileDir)
check('D2 还原控制窗口 → 浏览器也跟着还原', () => {
  assert(unminRects.appIconic === false, '控制窗口没还原')
  assert(unminRects.chromeIconic === false, '浏览器没跟着还原')
})

/* --------------------------------------------------------- E 关掉吸附 */

const off = await app.evaluate('window.monitor.setDock(false)')
const beforeOffMove = await probe.rects(profileDir)
const afterOffMove = await step(-160, 0, 0, 0)(beforeOffMove)

check('E1 关掉吸附后，控制窗口再动，浏览器停在原地', () => {
  assert(off.enabled === false, 'enabled 应为 false')
  assert(Math.abs(afterOffMove.chrome.left - beforeOffMove.chrome.left) <= 2,
    `浏览器被挪了 ${afterOffMove.chrome.left - beforeOffMove.chrome.left}px`)
  assert(Math.abs(afterOffMove.app.left - beforeOffMove.app.left) > 10, '控制窗口自己没动，这轮等于没测')
})

check('E2 关掉的状态落了盘', () => {
  const saved = readSettings()
  assert(saved?.dock?.enabled === false, 'ui-settings.json 里应为 false，实际 ' + JSON.stringify(saved))
})

/* -------------------------------------------------- F 落盘 + 重启恢复 */

const reOn = await app.evaluate('window.monitor.setDock(true)')
await sleep(400)
check('F1 打开的状态也落盘（含贴哪一侧）', () => {
  const saved = readSettings()
  assert(saved?.dock?.enabled === true, '应为 true，实际 ' + JSON.stringify(saved))
  assert(saved?.dock?.side === reOn.side, `side 应为 ${reOn.side}，实际 ${String(saved?.dock?.side)}`)
})

// 体面退出：让主进程走完 shutdown（会关浏览器、收掉助手进程），别硬杀
writeFileSync(quitFile, '')
await sleep(6000)
app.cdp.close()
await app.close()
probe.killChrome(profileDir)
await sleep(1500)

console.log('  重启应用（同一个 dataDir）…')
app = await launch(quitFile2)
status = await app.waitConnected(1)

check('F2 重启后自动恢复吸附（不用再点一次）', () => {
  assert(status.dock.enabled === true, '重启后 enabled 应为 true，实际 ' + JSON.stringify(status.dock))
  assert(status.dock.available === true, 'available 应为 true')
})

const restored = await waitFor(
  async () => {
    const rects = await probe.rects(profileDir)
    if (rects.chromeHwnd === 0) return null
    return gapOf(rects) <= TOL ? rects : null
  },
  '重启后浏览器被自动贴上',
  25000
)
check('F3 重启后浏览器真的被贴回去了，且用的还是落盘的那一侧（left）', () => {
  const at = `app=${box(restored.app)} chrome=${box(restored.chrome)}`
  assert(gapOf(restored) <= TOL, `缝=${gapOf(restored)} 应为 ${gapPhys}（${at}）`)
  assert(Math.abs(restored.chrome.left - work.left) <= TOL, '没贴在工作区左边（设置里存的是 left）：' + at)
  assert(Math.abs(restored.app.right - work.right) <= TOL, '控制窗口没让到右边：' + at)
  assert(Math.abs(restored.chrome.height - restored.app.height) <= TOL, '高度没铺满：' + at)
})

await app.shot('dock-restored.png')

/* --------------------------------------------------- G 边界：浏览器没了 */

await probe.killChrome(profileDir)
const lost = await waitFor(
  async () => {
    const state = await app.evaluate('window.monitor.getStatus().then((s) => s.dock)')
    // 要的是**落定**的状态：attached=false 和 reason 是两个字段，
    // 只看 attached 会抽到中间那一帧（窗口刚丢、位置还没重算）
    return state && state.attached === false && state.reason === 'no-window' ? state : null
  },
  '浏览器被关掉后状态回落到 no-window',
  25000
)
check('G1 浏览器被关掉后，状态回到 attached=false 且说明原因', () => {
  assert(lost.attached === false, 'attached 应为 false')
  assert(lost.reason === 'no-window', 'reason 应为 no-window，实际 ' + String(lost.reason))
  assert(lost.enabled === true, '用户的开关状态不该被清掉')
})

/* --------------------------------------------------------------- 收尾 */

writeFileSync(quitFile2, '')
await sleep(6000)
app.cdp.close()
await app.close()
probe.killChrome(profileDir)
probe.dispose()
await origin.close?.()

const ok = report()
process.exit(ok ? 0 : 1)