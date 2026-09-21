<#
  验收用的 Win32 探针（**独立于被测代码**）。

  为什么不复用 win/dock-helper.ps1：那是被测对象的一部分，用同一份实现去判自己
  有没有做对，等于没测。这里另写一份，口径一致（都是物理像素、都 SetProcessDPIAware），
  但代码独立 —— 两边对不上就说明有一边错了。

  两个环境坑（都踩过）：
   1. A 段的 app 窗口是用 Node 的 spawn windowsHide:true 起的 electron，GUI 程序的第一个
      ShowWindow 会被 STARTUPINFO 的 SW_HIDE 按下去 —— 窗口有真实几何，但 IsWindowVisible=false。
      所以找窗口时先找可见的，找不到再退一步找不可见的（showapp 会把窗口亮出来）。
   2. PowerShell 5.1 是 DPI-unaware 的，坐标必须自己 SetProcessDPIAware 才是物理像素。

  常驻进程，stdin 一行一条命令，stdout 一行一条结果。
  命令：rects <b64profile> / showapp / moveapp x y w h / minapp / unminapp / killchrome <b64profile> / quit
#>
param([Parameter(Mandatory=$false)][string]$Dummy = '')

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

public class TW {
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  // 同一进程可能有多个顶层窗口（隐藏的 message 窗口、下载气泡……），取面积最大的主窗口。
  // 先只挑可见的；一个都没有再放宽（见文件头的坑 1）。
  public static IntPtr Biggest(int pid) {
    IntPtr vis = Find(pid, true);
    if (vis != IntPtr.Zero) return vis;
    return Find(pid, false);
  }

  static IntPtr Find(int pid, bool needVisible) {
    IntPtr found = IntPtr.Zero;
    int best = 0;
    EnumWindows(new EnumProc(delegate(IntPtr h, IntPtr p) {
      uint wpid;
      GetWindowThreadProcessId(h, out wpid);
      if ((int)wpid != pid) return true;
      if (needVisible && !IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256);
      GetClassName(h, sb, 256);
      if (sb.ToString() != "Chrome_WidgetWin_1") return true;
      RECT r;
      GetWindowRect(h, out r);
      int area = (r.Right - r.Left) * (r.Bottom - r.Top);
      if (area > best) { best = area; found = h; }
      return true;
    }), IntPtr.Zero);
    return found;
  }

  public static string RectOf(IntPtr h) {
    RECT r;
    if (!GetWindowRect(h, out r)) return "0,0,0,0";
    return r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom;
  }
}
"@

[void][TW]::SetProcessDPIAware()

function Write-Line([string]$text) {
  [Console]::Out.WriteLine($text)
  [Console]::Out.Flush()
}

# electron 主进程：命令行里没有 --type=（renderer/gpu/utility 都有）
function Find-AppPid {
  foreach ($p in (Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue)) {
    $cmd = $p.CommandLine
    if ([string]::IsNullOrEmpty($cmd)) { continue }
    if ($cmd.Contains('--type=')) { continue }
    return [int]$p.ProcessId
  }
  return 0
}

function Find-ChromePid([string]$dir) {
  $needle = '--user-data-dir=' + $dir
  foreach ($p in (Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue)) {
    $cmd = $p.CommandLine
    if ([string]::IsNullOrEmpty($cmd)) { continue }
    if (-not $cmd.Contains($needle)) { continue }
    if ($cmd.Contains('--type=')) { continue }
    return [int]$p.ProcessId
  }
  return 0
}

function Get-AppHwnd {
  $apid = Find-AppPid
  if ($apid -eq 0) { return [IntPtr]::Zero }
  return [TW]::Biggest($apid)
}

function Get-ChromeHwnd([string]$dir) {
  $cpid = Find-ChromePid $dir
  if ($cpid -eq 0) { return [IntPtr]::Zero }
  return [TW]::Biggest($cpid)
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }
  $parts = $line.Split(' ')
  $id = $parts[0]
  $verb = $parts[1]

  try {
    if ($verb -eq 'quit') { break }

    $dir = ''
    if ($verb -eq 'rects' -or $verb -eq 'killchrome') {
      $dir = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[2]))
    }

    $appH = Get-AppHwnd
    $chromeH = [IntPtr]::Zero
    if ($dir -ne '') { $chromeH = Get-ChromeHwnd $dir }

    if ($verb -eq 'rects') {
      $ai = 0
      if ($appH -ne [IntPtr]::Zero -and [TW]::IsIconic($appH)) { $ai = 1 }
      $ci = 0
      if ($chromeH -ne [IntPtr]::Zero -and [TW]::IsIconic($chromeH)) { $ci = 1 }
      $av = 0
      if ($appH -ne [IntPtr]::Zero -and [TW]::IsWindowVisible($appH)) { $av = 1 }
      $msg = 'app=' + [TW]::RectOf($appH) + ' chrome=' + [TW]::RectOf($chromeH)
      $msg = $msg + ' fg=' + [TW]::GetForegroundWindow().ToInt64()
      $msg = $msg + ' appiconic=' + $ai + ' chromeiconic=' + $ci + ' appvisible=' + $av
      $msg = $msg + ' apphwnd=' + $appH.ToInt64() + ' chromehwnd=' + $chromeH.ToInt64()
      Write-Line ("$id ok " + $msg)
      continue
    }

    if ($verb -eq 'showapp') {
      if ($appH -eq [IntPtr]::Zero) { Write-Line ("$id err no-app-window"); continue }
      [void][TW]::ShowWindow($appH, 5)
      Start-Sleep -Milliseconds 250
      if (-not [TW]::IsWindowVisible($appH)) {
        # Windows 对进程的第一次 ShowWindow 会沿用 STARTUPINFO 的 SW_HIDE，之后才认账。
        # 再补一发带 SWP_SHOWWINDOW 的 SetWindowPos，只改可见性、不动几何、不抢焦点。
        [void][TW]::SetWindowPos($appH, [IntPtr]::Zero, 0, 0, 0, 0, 0x0057)
        Start-Sleep -Milliseconds 250
      }
      $fg = [TW]::SetForegroundWindow($appH)
      Start-Sleep -Milliseconds 200
      Write-Line ("$id ok " + [TW]::IsWindowVisible($appH) + " fg=" + $fg + " now=" + ([TW]::GetForegroundWindow() -eq $appH))
      continue
    }

    if ($verb -eq 'focusapp') {
      # SetForegroundWindow 会被前台锁挡下来（调用方不是前台进程）。SW_RESTORE 走的是
      # 「还原被最小化的窗口」，系统会顺手把它激活 —— 这是测试里唯一稳的抢前台办法。
      if ($appH -eq [IntPtr]::Zero) { Write-Line ("$id err no-app-window"); continue }
      [void][TW]::ShowWindow($appH, 6)
      Start-Sleep -Milliseconds 350
      [void][TW]::ShowWindow($appH, 9)
      Start-Sleep -Milliseconds 450
      Write-Line ("$id ok " + ([TW]::GetForegroundWindow() -eq $appH))
      continue
    }

    if ($verb -eq 'moveapp') {
      if ($appH -eq [IntPtr]::Zero) { Write-Line ("$id err no-app-window"); continue }
      $x = [int]$parts[2]; $y = [int]$parts[3]; $w = [int]$parts[4]; $hh = [int]$parts[5]
      # 和真实拖动一样：只挪位置、不抢焦点
      $ok = [TW]::SetWindowPos($appH, [IntPtr]::Zero, $x, $y, $w, $hh, 0x0014)
      Write-Line ("$id ok " + $ok)
      continue
    }

    if ($verb -eq 'minapp') {
      if ($appH -eq [IntPtr]::Zero) { Write-Line ("$id err no-app-window"); continue }
      [void][TW]::ShowWindow($appH, 6)
      Write-Line ("$id ok")
      continue
    }

    if ($verb -eq 'unminapp') {
      if ($appH -eq [IntPtr]::Zero) { Write-Line ("$id err no-app-window"); continue }
      [void][TW]::ShowWindow($appH, 9)
      Write-Line ("$id ok")
      continue
    }

    if ($verb -eq 'killchrome') {
      $needle = '--user-data-dir=' + $dir
      $n = 0
      foreach ($p in (Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue)) {
        $cmd = $p.CommandLine
        if ([string]::IsNullOrEmpty($cmd)) { continue }
        if (-not $cmd.Contains($needle)) { continue }
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        $n = $n + 1
      }
      Write-Line ("$id ok n=" + $n)
      continue
    }

    Write-Line ("$id err unknown_verb")
  } catch {
    $msg = $_.Exception.Message -replace '\s+', '_'
    Write-Line ("$id err $msg")
  }
}