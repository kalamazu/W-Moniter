param(
  [string]$ProcessName = 'electron',
  [string]$Title = '',
  [Parameter(Mandatory = $true)][string]$Out
)

# Node 那边按 utf8 解码我们的 stdout，而 PowerShell 5.1 默认用 OEM 代码页，
# 不显式改一下中文窗口标题会变乱码。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Drawing
Add-Type -Namespace NW -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
'@

[void][NW.Win]::SetProcessDPIAware()

# 一个 Electron 应用有好几个带窗口的进程，挑面积最大的那个才是主窗口。
$best = $null
$bestArea = 0
foreach ($p in (Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)) {
  if ($p.MainWindowHandle -eq 0) { continue }
  if ($Title -and $p.MainWindowTitle -ne $Title) { continue }
  $rect = New-Object NW.Win+RECT
  [void][NW.Win]::GetWindowRect($p.MainWindowHandle, [ref]$rect)
  $area = ($rect.Right - $rect.Left) * ($rect.Bottom - $rect.Top)
  if ($area -gt $bestArea) { $bestArea = $area; $best = $p }
}

if (-not $best) { Write-Output "没找到窗口 (process=$ProcessName)"; exit 1 }

$hwnd = $best.MainWindowHandle

# 最小化时 GetWindowRect 返回离屏坐标，必须先还原再截。
if ([NW.Win]::IsIconic($hwnd)) {
  [void][NW.Win]::ShowWindow($hwnd, 9)   # SW_RESTORE
  Start-Sleep -Milliseconds 1200
}

$r = New-Object NW.Win+RECT
[void][NW.Win]::GetWindowRect($hwnd, [ref]$r)
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
Write-Output ("capturing pid=" + $best.Id + " " + $w + "x" + $h)

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path -LiteralPath $dir)) {
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# 2 = PW_RENDERFULLCONTENT。Chromium 是离屏合成，不带这个标志 PrintWindow 会返回全黑。
$ok = [NW.Win]::PrintWindow($hwnd, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()

if (-not $ok) { Write-Output 'PrintWindow 返回 false' }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "saved: $Out"
