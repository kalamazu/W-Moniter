#!/usr/bin/env node
/**
 * 窗口吸附探针：先验证两个关键假设，再谈要不要写进主进程。
 *   1. 能不能按 --user-data-dir 找到被监控 Chrome 的顶层 HWND
 *   2. Electron 主进程是 DPI-aware 的，而 PowerShell 5.1 默认不是 ——
 *      SetProcessDPIAware 之后两边是不是同一套物理坐标
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { launchApp, sleep, makeChecker } from '../scripts/app-harness.mjs'
import { startOrigin } from '../scripts/test-origin.mjs'

const { check, assert, report } = makeChecker()
const PORT = 9714
const dataDir = mkdtempSync(join(tmpdir(), 'dock-'))
const profileDir = join(dataDir, 'browser-profile')
const shots = join(import.meta.dirname, 'dock-shots')
mkdirSync(shots, { recursive: true })

const CS = [
  'using System;',
  'using System.Text;',
  'using System.Runtime.InteropServices;',
  'public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
  'public class Dock {',
  '  delegate bool EnumProc(IntPtr h, IntPtr p);',
  '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);',
  '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);',
  '  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);',
  '  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
  '  public static IntPtr FindForPid(int pid) {',
  '    IntPtr found = IntPtr.Zero; int best = 0;',
  '    EnumWindows(new EnumProc(delegate(IntPtr h, IntPtr p) {',
  '      uint wpid; GetWindowThreadProcessId(h, out wpid);',
  '      if ((int)wpid != pid) return true;',
  '      if (!IsWindowVisible(h)) return true;',
  '      var sb = new StringBuilder(256); GetClassName(h, sb, 256);',
  '      if (sb.ToString() != "Chrome_WidgetWin_1") return true;',
  '      RECT r; GetWindowRect(h, out r);',
  '      int area = (r.Right - r.Left) * (r.Bottom - r.Top);',
  '      if (area > best) { best = area; found = h; }',
  '      return true;',
  '    }), IntPtr.Zero);',
  '    return found;',
  '  }',
  '  public static string RectOf(IntPtr h) { RECT r; GetWindowRect(h, out r); return r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom; }',
  '}'
].join('\n')

const runPs = (body) => {
  const head = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -TypeDefinition $cs',
    '[void][Dock]::SetProcessDPIAware()'
  ].join('\n')
  const script = head.replace('$cs', '@"\n' + CS + '\n"@') + '\n' + body.join('\n')
  const out = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 90000 })
  if (out.status !== 0) console.log('  PS stderr: ' + String(out.stderr).replace(/\s+/g, ' ').slice(0, 300))
  return String(out.stdout).trim()
}

const origin = await startOrigin(0)
const app = await launchApp({ url: 'http://127.0.0.1:' + origin.port + '/', dataDir, port: PORT, tab: 'list', shotDir: shots })

try {
  const status = await app.waitConnected(1)
  console.log('  内核 pid 相关：' + JSON.stringify({ path: status.browserPath, profile: status.profile }))

  // 1) 按 profile 目录找 Chrome 主进程
  const find = runPs([
    "$dir = '" + profileDir + "'",
    '$procs = Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" | Where-Object { $_.CommandLine -like ("*--user-data-dir=" + $dir + "*") }',
    'Write-Output ("PROCS=" + ($procs | Measure-Object).Count)',
    '$target = $procs | Where-Object { $_.CommandLine -notlike "*--type=*" } | Select-Object -First 1',
    'if ($null -eq $target) { Write-Output "NO-BROWSER-PROC"; exit 0 }',
    '$hwnd = [Dock]::FindForPid($target.ProcessId)',
    'Write-Output ("PID=" + $target.ProcessId)',
    'if ($hwnd -eq [IntPtr]::Zero) { Write-Output "NO-HWND"; exit 0 }',
    'Write-Output ("HWND=" + $hwnd.ToInt64())',
    'Write-Output ("RECT=" + [Dock]::RectOf($hwnd))'
  ])
  console.log('\n  [找窗] ' + find.replace(/\n/g, ' | ') + '\n')

  const lines = find.split('\n').map((s) => s.trim())
  const get = (k) => (lines.find((l) => l.startsWith(k + '=')) ?? '').slice(k.length + 1)
  const hwnd = get('HWND')
  const rect = get('RECT').split(',').map(Number)

  check('按 --user-data-dir 找得到 Chrome 进程', () => assert(Number(get('PROCS')) >= 1, find))
  check('找得到 Chrome 的顶层 HWND（Chrome_WidgetWin_1）', () => assert(hwnd && hwnd !== '0', find))
  check('窗口矩形合理（宽 > 400 且高 > 300）', () => {
    assert(rect.length === 4, 'RECT=' + get('RECT'))
    assert(rect[2] - rect[0] > 400 && rect[3] - rect[1] > 300, 'RECT=' + get('RECT'))
  })

  // 2) 坐标体系：DIP 与物理的换算。真值来自 Chrome 的启动参数
  //    （--window-position=60,40 --window-size=1280,900，单位是 DIP）
  const dip = await app.evaluate(`({ sx: window.screenX, sy: window.screenY, w: window.outerWidth, h: window.outerHeight, dpr: window.devicePixelRatio })`)
  const dipCmd = { x: 60, y: 40, w: 1280, h: 900 }
  console.log('  [坐标] 启动参数(DIP)=' + JSON.stringify(dipCmd) + '  dpr=' + dip.dpr + '  PS 报文物理矩形=' + JSON.stringify(rect))
  check('DIP → 物理换算对得上（Chrome 物理矩形 == 启动参数 x dpr）', () => {
    assert(rect.length === 4, 'RECT=' + get('RECT'))
    assert(Math.abs(rect[0] - dipCmd.x * dip.dpr) <= 3, '物理 x=' + rect[0] + ' 期望=' + dipCmd.x * dip.dpr)
    assert(Math.abs(rect[1] - dipCmd.y * dip.dpr) <= 3, '物理 y=' + rect[1] + ' 期望=' + dipCmd.y * dip.dpr)
    assert(Math.abs(rect[2] - rect[0] - dipCmd.w * dip.dpr) <= 3, '物理宽=' + (rect[2] - rect[0]) + ' 期望=' + dipCmd.w * dip.dpr)
    assert(Math.abs(rect[3] - rect[1] - dipCmd.h * dip.dpr) <= 3, '物理高=' + (rect[3] - rect[1]) + ' 期望=' + dipCmd.h * dip.dpr)
  })

  // 3) 真的能挪动它。真值：吸附后矩形应该紧贴控制窗口右缘（同一套物理坐标）
  const winDip = await app.evaluate(`({ x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight })`)
  const dpr = dip.dpr
  // SetWindowPos 要的是 (x, y, 宽, 高)，不是 (left, top, right, bottom) —— 这里踩过一次
  const target = [
    Math.round((winDip.x + winDip.w) * dpr) + 20,
    Math.round(winDip.y * dpr),
    Math.round(900 * dpr),
    Math.round(winDip.h * dpr)
  ]

  const moved = runPs([
    '$h = [IntPtr](' + hwnd + ')',
    'if (-not [Dock]::IsWindow($h)) { Write-Output "GONE"; exit 0 }',
    '$ok = [Dock]::SetWindowPos($h, [IntPtr]::Zero, ' + target.join(', ') + ', 0x0014)',
    'Start-Sleep -Milliseconds 400',
    'Write-Output ("OK=" + $ok)',
    'Write-Output ("RECT=" + [Dock]::RectOf($h))'
  ])
  console.log('  [挪窗] 目标=' + JSON.stringify(target) + ' → ' + moved.replace(/\n/g, ' | '))
  check('SetWindowPos 把 Chrome 挪到了指定位置', () => {
    const after = moved.split('\n').map((s) => s.trim()).find((l) => l.startsWith('RECT=')).slice(5).split(',').map(Number)
    assert(Math.abs(after[0] - target[0]) <= 2, 'x=' + after[0] + ' 期望=' + target[0])
    assert(Math.abs(after[1] - target[1]) <= 2, 'y=' + after[1] + ' 期望=' + target[1])
    assert(Math.abs(after[2] - after[0] - target[2]) <= 2, '宽=' + (after[2] - after[0]) + ' 期望=' + target[2])
    assert(Math.abs(after[3] - after[1] - target[3]) <= 2, '高=' + (after[3] - after[1]) + ' 期望=' + target[3])
  })

  await app.shot('01-docked.png')
} catch (err) {
  console.error('\n  探针中断: ' + err.message)
} finally {
  try { app.cdp.close() } catch { /* ignore */ }
  try { app.app.kill() } catch { /* ignore */ }
  spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Process electron,chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "*Chromium*" } | Stop-Process -Force'], { encoding: 'utf8' })
  await origin.close()
  await sleep(500)
  const ok = report()
  console.log('  数据目录 ' + dataDir)
  process.exit(ok ? 0 : 1)
}
