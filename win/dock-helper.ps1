<#
  窗口吸附的 Win32 助手。常驻进程，从 stdin 读一行一条命令，往 stdout 回一行结果。

  为什么要一个常驻进程：吸附要跟着控制窗口的 move/resize 连续改位置（拖拽时每秒几十次），
  每次现起一个 powershell.exe 要 200~300ms，窗口会跟不动。这里 Add-Type 只编译一次，
  之后每条命令就是几次 P/Invoke。

  为什么要 SetProcessDPIAware：PowerShell 5.1 默认是 DPI-unaware 的，
  GetWindowRect / SetWindowPos 会被系统按虚拟化坐标解释。调了之后两边才都是**物理像素**，
  主进程那边用 Electron 的 screen.dipToScreenRect 换算过来，才能对上。

  协议（stdout 一行）：
    <id> ok [payload...]
    <id> err <message>
  命令里的路径走 base64，避免空格与引号把分隔符搅乱。
#>
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

public class DockHelper {
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  // 同一进程可能有多个顶层窗口（下载气泡等），取面积最大的那个主窗口
  public static IntPtr FindForPid(int pid) {
    IntPtr found = IntPtr.Zero;
    int best = 0;
    EnumWindows(new EnumProc(delegate(IntPtr h, IntPtr p) {
      uint wpid;
      GetWindowThreadProcessId(h, out wpid);
      if ((int)wpid != pid) return true;
      if (!IsWindowVisible(h)) return true;
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
    GetWindowRect(h, out r);
    return r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom;
  }
}
"@

[void][DockHelper]::SetProcessDPIAware()

function Write-Line([string]$text) {
  [Console]::Out.WriteLine($text)
  [Console]::Out.Flush()
}

# 按 profile 目录找浏览器主进程。不能用 $pid 当变量名 —— 那是 PowerShell 的只读自动变量。
function Find-BrowserPid([string]$dir) {
  $needle = '--user-data-dir=' + $dir
  foreach ($proc in (Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue)) {
    $cmdline = $proc.CommandLine
    if ([string]::IsNullOrEmpty($cmdline)) { continue }
    if (-not $cmdline.Contains($needle)) { continue }
    if ($cmdline.Contains('--type=')) { continue }
    return [int]$proc.ProcessId
  }
  return 0
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

    if ($verb -eq 'find') {
      $dir = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[2]))
      $bpid = Find-BrowserPid $dir
      if ($bpid -eq 0) { Write-Line ("$id ok 0 0"); continue }
      $hwnd = [DockHelper]::FindForPid($bpid)
      Write-Line ("$id ok " + $hwnd.ToInt64() + " " + $bpid)
      continue
    }

    if ($verb -eq 'rect') {
      $h = [IntPtr]([int64]$parts[2])
      if (-not [DockHelper]::IsWindow($h)) { Write-Line ("$id err gone"); continue }
      Write-Line ("$id ok " + [DockHelper]::RectOf($h))
      continue
    }

    if ($verb -eq 'move') {
      $h = [IntPtr]([int64]$parts[2])
      if (-not [DockHelper]::IsWindow($h)) { Write-Line ("$id err gone"); continue }
      $x = [int]$parts[3]; $y = [int]$parts[4]; $w = [int]$parts[5]; $hh = [int]$parts[6]
      # 0x0014 = SWP_NOZORDER | SWP_NOACTIVATE：只挪位置，不动 z 序、不抢焦点
      $ok = [DockHelper]::SetWindowPos($h, [IntPtr]::Zero, $x, $y, $w, $hh, 0x0014)
      Write-Line ("$id ok " + $ok)
      continue
    }

    if ($verb -eq 'min') {
      $h = [IntPtr]([int64]$parts[2])
      if ([DockHelper]::IsWindow($h)) { [void][DockHelper]::ShowWindow($h, 6) }
      Write-Line ("$id ok")
      continue
    }

    if ($verb -eq 'unmin') {
      $h = [IntPtr]([int64]$parts[2])
      if ([DockHelper]::IsWindow($h)) { [void][DockHelper]::ShowWindow($h, 9) }
      Write-Line ("$id ok")
      continue
    }

    if ($verb -eq 'iconic') {
      $h = [IntPtr]([int64]$parts[2])
      $v = 0
      if ([DockHelper]::IsWindow($h) -and [DockHelper]::IsIconic($h)) { $v = 1 }
      Write-Line ("$id ok " + $v)
      continue
    }

    Write-Line ("$id err unknown_verb")
  } catch {
    $msg = $_.Exception.Message -replace '\s+', '_'
    Write-Line ("$id err $msg")
  }
}