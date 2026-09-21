$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public class EN {
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  public static string Dump(string pids) {
    var sb = new StringBuilder();
    EnumWindows(new EnumProc(delegate(IntPtr h, IntPtr p) {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pids.Length > 0 && ("," + pids + ",").IndexOf("," + pid + ",") < 0) return true;
      var cls = new StringBuilder(256); GetClassName(h, cls, 256);
      RECT r; GetWindowRect(h, out r);
      sb.AppendLine("pid=" + pid + " hwnd=" + h.ToInt64() + " vis=" + IsWindowVisible(h) + " owned=" + (GetParent(h) != IntPtr.Zero) + " rect=" + r.Left + "," + r.Top + "," + (r.Right - r.Left) + "x" + (r.Bottom - r.Top) + " class=" + cls);
      return true;
    }), IntPtr.Zero);
    return sb.ToString();
  }
  public static bool Aware() { return SetProcessDPIAware(); }
}
"@
[void][EN]::Aware()
$pids = @()
foreach ($proc in (Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue)) {
  $pids += [int]$proc.ProcessId
}
Write-Output ('electron 相关 pid: ' + ($pids -join ','))
Write-Output ([EN]::Dump(($pids -join ',')))