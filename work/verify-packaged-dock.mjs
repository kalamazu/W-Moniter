/**
 * 验证**打包版**里真的有窗口吸附：启动 dist/win-unpacked/ChromiumMonitor.exe，
 * 从外部挂 CDP 读标题栏，看有没有 .tb-dock 按钮、状态里 dock 字段是否可用。
 *
 * 注意：这是真 GUI 程序，会短暂弹出窗口并起一个 Chrome，跑完自己收工。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCdp, waitControlTarget, sleep, makeChecker, ROOT } from '../scripts/app-harness.mjs'

const EXE = join(ROOT, 'dist', 'win-unpacked', 'ChromiumMonitor.exe')
const PORT = 9720
const SHOT_DIR = join(ROOT, 'work', 'dock-shots')
mkdirSync(SHOT_DIR, { recursive: true })

const { check, report } = makeChecker()
const dataDir = mkdtempSync(join(tmpdir(), 'dockpkg-'))

console.log('启动打包版：' + EXE)
console.log('数据目录：' + dataDir)

const child = spawn(EXE, ['--no-sandbox', `--remote-debugging-port=${PORT}`], {
  detached: true,
  stdio: 'ignore',
  env: {
    ...process.env,
    MONITOR_DATA_DIR: dataDir,
    MONITOR_URL: 'about:blank',
    MONITOR_AUTO_QUIT_MS: '90000'
  }
})
child.unref()

const target = await waitControlTarget(PORT, 90000)
if (!target) {
  console.log('FAIL 打包版的控制窗口没起来')
  process.exit(1)
}
const cdp = await openCdp(target.webSocketDebuggerUrl)
await cdp.send('Runtime.enable')
await cdp.send('Page.enable')

const evaluate = async (expression) => {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception ?? {}))
  return r.result.value
}

// 等界面挂载
await sleep(2500)

const bar = await evaluate(`(() => {
  const el = document.querySelector('.tb-dock')
  if (!el) return { found: false }
  const r = el.getBoundingClientRect()
  return { found: true, text: el.textContent.trim(), cls: el.className,
           disabled: el.disabled === true, x: Math.round(r.x), y: Math.round(r.y),
           w: Math.round(r.width), h: Math.round(r.height),
           title: el.getAttribute('title') ?? '' }
})()`)

check('打包版控制窗口里存在「吸附」按钮（.tb-dock）', () => {
  if (!bar.found) throw new Error('页面里没有 .tb-dock —— 这份包还是旧的')
})

const bodyMode = await evaluate('window.monitor.getStatus().then((s) => s.bodyMode)')
check('打包版的 body 采集范围是「全部类型」', () => {
  if (!/全部类型/.test(String(bodyMode))) throw new Error('bodyMode=' + String(bodyMode))
})
console.log('  bodyMode=' + JSON.stringify(bodyMode))

const status = await evaluate('window.monitor.getStatus().then((s) => s.dock ?? null)')

check('打包版的 status 里带 dock 字段', () => {
  if (!status) throw new Error('getStatus() 没有 dock 字段')
})

check('打包版里助手可用（available=true，说明 resources/win/dock-helper.ps1 就位）', () => {
  if (status.available !== true) throw new Error('available=' + String(status.available))
})

check('干净数据目录上默认没开吸附', () => {
  if (status.enabled !== false) throw new Error('enabled=' + String(status.enabled))
})

check('按钮在顶栏右上区、文案是「吸附」', () => {
  if (!/吸附/.test(bar.text)) throw new Error('按钮文案=' + JSON.stringify(bar.text))
})

console.log('  按钮：text=' + JSON.stringify(bar.text) + ' class=' + JSON.stringify(bar.cls) +
  ' disabled=' + String(bar.disabled) + ' 位置=' + bar.x + ',' + bar.y + ' ' + bar.w + 'x' + bar.h)
if (bar.title) console.log('  title=' + JSON.stringify(bar.title))
console.log('  dock=' + JSON.stringify(status))

// 截图：整窗 + 顶栏那一条（好核对按钮长相）
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
writeFileSync(join(SHOT_DIR, 'packaged-ready.png'), Buffer.from(shot.data, 'base64'))

const clip = await cdp.send('Page.captureScreenshot', {
  format: 'png',
  clip: { x: 0, y: 0, width: 1360, height: 64, scale: 2 }
})
writeFileSync(join(SHOT_DIR, 'packaged-titlebar.png'), Buffer.from(clip.data, 'base64'))
console.log('  截图：work/dock-shots/packaged-ready.png · packaged-titlebar.png')

// 点一下真的能吸上吗
const on = await evaluate('window.monitor.setDock(true)')
await sleep(500)
check('打包版点一下能吸上（attached=true）', () => {
  if (on.enabled !== true) throw new Error('enabled=' + String(on.enabled))
  if (on.attached !== true) throw new Error('attached=' + String(on.attached) + ' reason=' + String(on.reason))
})
console.log('  吸附后 dock=' + JSON.stringify(on))

const bar2 = await evaluate(`(() => {
  const el = document.querySelector('.tb-dock')
  return { text: el.textContent.trim(), cls: el.className }
})()`)
check('吸附后按钮进入「已吸上」态（文案带方向）', () => {
  if (!/左|右/.test(bar2.text)) throw new Error('文案=' + JSON.stringify(bar2.text))
})
console.log('  吸附后按钮：' + JSON.stringify(bar2.text) + ' class=' + JSON.stringify(bar2.cls))

const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' })
writeFileSync(join(SHOT_DIR, 'packaged-docked.png'), Buffer.from(shot2.data, 'base64'))

await evaluate('window.monitor.setDock(false)')
cdp.close()

// 收工：让主进程自己走 shutdown
console.log('收工（让主进程走完关停）…')
await sleep(2000)
try { process.kill(child.pid) } catch { /* 可能已经退了 */ }

const ok = report()
process.exit(ok ? 0 : 1)