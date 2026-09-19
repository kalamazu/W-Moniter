param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [string[]]$Names = @('electron.exe', 'chrome.exe')
)

# 杀掉本项目上一次没退干净的 electron / chrome。
# 判据是「命令行里带本项目路径」—— 不会误伤用户自己的浏览器和编辑器。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$hits = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $Names -contains $_.Name -and $_.CommandLine -and $_.CommandLine -like "*$Root*"
})

if ($hits.Count -eq 0) {
  Write-Output '没有残留进程'
  exit 0
}

$killed = 0
foreach ($h in $hits) {
  try {
    Stop-Process -Id $h.ProcessId -Force -ErrorAction Stop
    $killed++
    Write-Output ("killed " + $h.Name + " pid=" + $h.ProcessId)
  } catch {
    Write-Output ("kill failed pid=" + $h.ProcessId + ": " + $_.Exception.Message)
  }
}
Write-Output ("共清理 " + $killed + "/" + $hits.Count + " 个")
