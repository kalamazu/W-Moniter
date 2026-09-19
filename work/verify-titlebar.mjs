#!/usr/bin/env node
/**
 * 自绘标题栏的一次性验收（跑完就删）。
 *
 * A 段：结构 / CSS / IPC —— 在控制窗口里求值，走真实 preload 桥。
 * B 段：真实鼠标 —— CDP 注入的输入走不到 Windows 的 HTCAPTION 命测，
 *       拖动标题栏和双击最大化只有真实输入才能证明。
 *
 * 两个坑：
 *  1. PowerShell 5.1 是 DPI-unaware 的，GetWindowRect / SetCursorPos 都走虚拟化
 *     坐标，跟渲染层的 screenX / outerWidth(DIP) 天然对齐 —— 不要乘 devicePixelRatio。
 *  2. PS 里函数调用要写 (Rect)，写成 Rect() 会被解析成「命令 + 空表达式」而报错。
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, sleep, makeChecker } from '../scripts/app-harness.mjs'
import { startOrigin } from '../scripts/test-origin.mjs'

const PORT = 9713
const SHOT_DIR = join(import.meta.dirname, 'titlebar-shots')
mkdirSync(SHOT_DIR, { recursive: true })

const { check, assert, report } = makeChecker()
const dataDir = mkdtempSync(join(tmpdir(), 'tb-'))
const origin = await startOrigin(0)
const app = await launchApp({
  url: 'http://127.0.0.1:' + origin.port + '/',
  dataDir,
  port: PORT,
  tab: 'list',
  shotDir: SHOT_DIR
})

const click = async (x, y) => {
  const base = { x, y, button: 'left', clickCount: 1 }
  await app.cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 })
  await app.cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 })
}

const boxOf = (sel, index) =>
  app.evaluate(
    `(() => { const b = document.querySelectorAll(${JSON.stringify(sel)})[${index}].getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } })()`
  )

const CSharp = [
  'using System;',
  'using System.Runtime.InteropServices;',
  'public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
  '[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }',
  'public class Win {',
  '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
  '  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);',
  '  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);',
  '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
  '  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, IntPtr e);',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
  '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
  '}'
].join('\n')

const PS_HEAD = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -TypeDefinition $cs',
'[void][Win]::SetProcessDPIAware()',
  '$h = [IntPtr]::Zero',
  'foreach ($pr in (Get-Process -Name electron -ErrorAction SilentlyContinue)) {',
  '  if ($pr.MainWindowHandle -ne 0 -and $pr.MainWindowTitle -like "*Chromium*") { $h = $pr.MainWindowHandle; break }',
  '}',
  'if ($h -eq [IntPtr]::Zero) { Write-Output "NO-HWND"; exit 0 }',
  'function Rect { $x = New-Object RECT; [void][Win]::GetWindowRect($h, [ref]$x); return ($x.Left.ToString() + "," + $x.Top.ToString() + "," + $x.Right.ToString() + "," + $x.Bottom.ToString()) }',
  'function Focus {',
  '  if ([Win]::IsIconic($h)) { [void][Win]::ShowWindow($h, 9) }',
  '  [Win]::keybd_event(0x12, 0, 0, [IntPtr]::Zero); [Win]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)',
  '  for ($t = 1; $t -le 5; $t++) { [void][Win]::SetForegroundWindow($h); Start-Sleep -Milliseconds 200; if ([Win]::GetForegroundWindow() -eq $h) { return $true } }',
  '  return $false',
  '}',
  'function DblClick { for ($i = 1; $i -le 2; $i++) { [Win]::mouse_event(0x0002,0,0,0,[IntPtr]::Zero); [Win]::mouse_event(0x0004,0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 70 } }'
]

const runPs = (body) => {
  const script = PS_HEAD.join('\n').replace('$cs', '@"\n' + CSharp + '\n"@') + '\n' + body.join('\n')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const out = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    timeout: 90000
  })
  if (out.status !== 0) console.log('  PS 报错: ' + String(out.stderr).replace(/\s+/g, ' ').slice(0, 300))
  return String(out.stdout).trim().split('\n').pop().trim().split('|')
}

try {
  await app.waitConnected(1)
  await sleep(800)

  /* ---------------- A. 结构 / CSS ---------------- */

  const layout = await app.evaluate(`(() => {
    const tb = document.querySelector('.titlebar')
    const r = tb ? tb.getBoundingClientRect() : null
    const region = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).getPropertyValue('-webkit-app-region') : null }
    return {
      hasTitlebar: !!tb,
      hasOldTopbar: !!document.querySelector('.topbar'),
      top: r ? Math.round(r.top) : null,
      height: r ? Math.round(r.height) : null,
      outerH: window.outerHeight, innerH: window.innerHeight,
      outerW: window.outerWidth, innerW: window.innerWidth,
      dpr: window.devicePixelRatio,
      tbRegion: tb ? getComputedStyle(tb).getPropertyValue('-webkit-app-region') : null,
      btnRegion: region('.tb-btn'),
      winBtnRegion: region('.tb-win-btn'),
      winBtnCount: document.querySelectorAll('.tb-win-btn').length,
      name: document.querySelector('.tb-name') ? document.querySelector('.tb-name').textContent : null,
      metrics: Array.from(document.querySelectorAll('.tb-metrics .metric')).map((e) => e.textContent.trim()),
      actions: Array.from(document.querySelectorAll('.tb-btn')).map((e) => e.textContent.trim()),
      footButtons: Array.from(document.querySelectorAll('.foot button')).map((e) => e.textContent.trim()),
      toolbarButtons: Array.from(document.querySelectorAll('.toolbar button')).map((e) => e.textContent.trim())
    }
  })()`)
  console.log('\n  [A] ' + JSON.stringify({ ...layout, metrics: undefined }))
  console.log('  [A] metrics=' + JSON.stringify(layout.metrics) + '\n')

  check('自绘 .titlebar 存在', () => assert(layout.hasTitlebar, '没找到 .titlebar'))
  check('旧 .topbar 已移除', () => assert(!layout.hasOldTopbar, '.topbar 还在'))
  check('.titlebar 是拖动区', () => assert(layout.tbRegion === 'drag', 'app-region=' + layout.tbRegion))
  check('.tb-btn 是 no-drag（否则点刷新会变拖窗口）', () => assert(layout.btnRegion === 'no-drag', 'app-region=' + layout.btnRegion))
  check('.tb-win-btn 是 no-drag', () => assert(layout.winBtnRegion === 'no-drag', 'app-region=' + layout.winBtnRegion))
  check('标题栏贴窗口最顶部（top=0）', () => assert(layout.top === 0, 'top=' + layout.top))
  check('标题栏高度 46px', () => assert(layout.height === 46, 'height=' + layout.height))
  check('frame:false 证据 —— 内外高度只差 1px 缩放边框（有系统标题栏时会差约 31px）', () =>
    assert(layout.outerH - layout.innerH <= 4, 'outer=' + layout.outerH + ' inner=' + layout.innerH))
  check('三键齐全（最小化/最大化/关闭）', () => assert(layout.winBtnCount === 3, '按钮数=' + layout.winBtnCount))
  check('品牌名在自绘标题栏里', () => assert(layout.name === 'Chromium 监控容器', 'name=' + layout.name))
  check('全局动作已迁到顶部（刷新/清空/数据目录）', () =>
    assert(JSON.stringify(layout.actions) === JSON.stringify(['刷新', '清空', '数据目录']), JSON.stringify(layout.actions)))
  check('页脚不再有「打开目录」按钮（已上移）', () =>
    assert(!layout.footButtons.some((t) => t.includes('打开目录')), JSON.stringify(layout.footButtons)))
  check('工具栏不再有重复的「刷新」', () =>
    assert(!layout.toolbarButtons.includes('刷新'), JSON.stringify(layout.toolbarButtons)))
  check('指标仍完整', () => {
    const labels = layout.metrics.map((m) => m.replace(/[\d/,.\s]/g, ''))
    assert(JSON.stringify(labels) === JSON.stringify(['本次采集', '命中筛选', '已落库', 'body', '脚本', 'target']), JSON.stringify(layout.metrics))
  })
  check('target 指标渲染成 N/M 形态', () => assert(/^\d+\/\d+ target$/.test(layout.metrics[5]), layout.metrics[5]))

  await app.shot('01-normal.png')

  /* ---------------- B. 最大化 / 还原（CDP 真实点击） ---------------- */

  let box = await boxOf('.tb-win-btn', 1)
  await click(box.x, box.y)
  await sleep(900)
  const maximized1 = await app.evaluate('window.monitor.isWindowMaximized()')
  const title1 = await app.evaluate(`document.querySelectorAll('.tb-win-btn')[1].getAttribute('title')`)
  check('点最大化 → isWindowMaximized() = true', () => assert(maximized1 === true, 'maximized=' + maximized1))
  check('最大化后按钮标题变「还原」', () => assert(title1 === '还原', 'title=' + title1))
  await app.shot('02-maximized.png')

  box = await boxOf('.tb-win-btn', 1)
  await click(box.x, box.y)
  await sleep(900)
  const maximized2 = await app.evaluate('window.monitor.isWindowMaximized()')
  const title2 = await app.evaluate(`document.querySelectorAll('.tb-win-btn')[1].getAttribute('title')`)
  check('再点一次 → 还原', () => assert(maximized2 === false, 'maximized=' + maximized2))
  check('还原后按钮标题变回「最大化」', () => assert(title2 === '最大化', 'title=' + title2))

  /* ---------------- C. 真实鼠标：拖动标题栏 ---------------- */

  const geo = () =>
    app.evaluate(`(() => {
      const r = document.querySelector('.tb-name').getBoundingClientRect()
      const s = window.devicePixelRatio
      return { x: Math.round((window.screenX + r.x + r.width / 2) * s), y: Math.round((window.screenY + r.y + r.height / 2) * s), scale: s, screen: [window.screenX, window.screenY], outer: [window.outerWidth, window.outerHeight] }
    })()`)

  const geo0 = await geo()
  let g = geo0
  console.log('  [C] 目标点 ' + JSON.stringify(g) + ' dpr=' + layout.dpr)

  const dragOut = runPs([
    '$b = (Rect)',
    '$cur = New-Object POINT; [void][Win]::GetCursorPos([ref]$cur)',
    'if (-not (Focus)) { Write-Output ("NO-FOCUS|" + $b); exit 0 }',
    '[void][Win]::SetCursorPos(' + g.x + ', ' + g.y + ')',
    'Start-Sleep -Milliseconds 250',
    '[Win]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)',
    'Start-Sleep -Milliseconds 250',
    '[void][Win]::SetCursorPos(' + (g.x + 2) + ', ' + (g.y + 2) + ')',
    'Start-Sleep -Milliseconds 200',
    '[void][Win]::SetCursorPos(' + (g.x + 92) + ', ' + (g.y + 62) + ')',
    'Start-Sleep -Milliseconds 250',
    '[Win]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)',
    'Start-Sleep -Milliseconds 600',
    '[void][Win]::SetCursorPos($cur.X, $cur.Y)',
    'Write-Output ("OK|" + $b + "|" + (Rect))'
  ])
  console.log('  [C] 拖动 → ' + dragOut.join(' | '))
  check('物理坐标体系对得上（GetWindowRect 宽度 == outerWidth x dpr）', () => {
    assert(dragOut[0] === 'OK', dragOut.join('|'))
    const b = dragOut[1].split(',').map(Number)
    const w = b[2] - b[0]
    const want = Math.round(geo0.outer[0] * geo0.scale)
    assert(Math.abs(w - want) <= 3, 'win32W=' + w + ' 期望=' + want)
  })
  check('真实拖动标题栏能把窗口挪走（-webkit-app-region: drag 生效）', () => {
    assert(dragOut[0] === 'OK', dragOut.join('|'))
    const b = dragOut[1].split(',').map(Number)
    const a = dragOut[2].split(',').map(Number)
    assert(a[0] - b[0] === 90 && a[1] - b[1] === 60, '位移=(' + (a[0] - b[0]) + ',' + (a[1] - b[1]) + ') 期望 (90,60)')
  })

  /* ---------------- D. 真实鼠标：双击标题栏 ---------------- */

  const preMax = await app.evaluate('window.monitor.isWindowMaximized()')
  check('双击前处于非最大化（双击语义是「最大化」）', () => assert(preMax === false, 'maximized=' + preMax))

  await app.evaluate(`(() => { window.__tbEvents = []; window.monitor.onWindowMaximized((m) => window.__tbEvents.push(m)); return true })()`)
  g = await geo()
  console.log('  [D] 目标点 ' + JSON.stringify(g))

  const dbl = runPs([
    '$b = (Rect)',
    '$cur = New-Object POINT; [void][Win]::GetCursorPos([ref]$cur)',
    'if (-not (Focus)) { Write-Output ("NO-FOCUS|" + $b); exit 0 }',
    '[void][Win]::SetCursorPos(' + g.x + ', ' + g.y + ')',
    'Start-Sleep -Milliseconds 250',
    'DblClick',
    'Start-Sleep -Milliseconds 900',
    '[void][Win]::SetCursorPos($cur.X, $cur.Y)',
    'Write-Output ("OK|" + $b + "|" + (Rect))'
  ])
  console.log('  [D] 双击 → ' + dbl.join(' | '))
  await sleep(400)
  const events = await app.evaluate('window.__tbEvents')
  const nowMax = await app.evaluate('window.monitor.isWindowMaximized()')
  console.log('  [D] push 事件 ' + JSON.stringify(events) + ' → maximized=' + nowMax)

  check('真实双击标题栏 → 窗口最大化', () => assert(dbl[0] === 'OK' && nowMax === true, 'status=' + dbl[0] + ' maximized=' + nowMax))
  check('双击只切换一次（渲染层与原生没有双重切换）', () => assert(JSON.stringify(events) === '[true]', 'events=' + JSON.stringify(events)))
  await app.shot('03-dblclick-maximized.png')

  const dbl2 = runPs([
    '$b = (Rect)',
    '$cur = New-Object POINT; [void][Win]::GetCursorPos([ref]$cur)',
    'if (-not (Focus)) { Write-Output ("NO-FOCUS|" + $b); exit 0 }',
    '$r = New-Object RECT; [void][Win]::GetWindowRect($h, [ref]$r)',
    '$mid = [int](($r.Left + $r.Right) / 2)',
    '$y = $r.Top + ' + Math.round(23 * g.scale) + '',
    '[void][Win]::SetCursorPos($mid, $y)',
    'Start-Sleep -Milliseconds 250',
    'DblClick',
    'Start-Sleep -Milliseconds 900',
    '[void][Win]::SetCursorPos($cur.X, $cur.Y)',
    'Write-Output ("OK|" + $b + "|" + (Rect))'
  ])
  console.log('  [D] 再双击 → ' + dbl2.join(' | '))
  await sleep(500)
  const back = await app.evaluate('window.monitor.isWindowMaximized()')
  check('再双击一次 → 还原', () => assert(dbl2[0] === 'OK' && back === false, 'status=' + dbl2[0] + ' maximized=' + back))

  /* ---------------- E. 关闭键 ---------------- */

  const closeBox = await boxOf('.tb-win-btn', 2)
  await click(closeBox.x, closeBox.y)
  await sleep(2500)
  const exited = app.app.exitCode !== null || app.app.signalCode !== null
  check('点关闭键 → 应用真的退出（走正常关闭流程）', () => assert(exited, 'exitCode=' + app.app.exitCode))
} catch (err) {
  console.error('\n  验收中断: ' + err.message + '\n' + err.stack)
} finally {
  try { app.cdp.close() } catch { /* ignore */ }
  try { app.app.kill() } catch { /* ignore */ }
  spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "*Chromium*" } | Stop-Process -Force'], { encoding: 'utf8' })
  await origin.close()
  await sleep(500)
  const ok = report()
  console.log('  数据目录 ' + dataDir)
  process.exit(ok ? 0 : 1)
}