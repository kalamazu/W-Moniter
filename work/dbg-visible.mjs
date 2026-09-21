import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT, sleep } from '../scripts/app-harness.mjs'

const dataDir = mkdtempSync(join(tmpdir(), 'vis-'))
const mode = process.argv[2] ?? 'hide'
const logFd = openSync(join(dataDir, 'app.log'), 'a')
const child = spawn(
  join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
  ['out/main/index.js', '--no-sandbox', '--remote-debugging-port=9723'],
  {
    cwd: ROOT,
    stdio: ['ignore', logFd, logFd],
    windowsHide: mode === 'hide',
    env: { ...process.env, MONITOR_URL: 'https://example.com', MONITOR_DATA_DIR: dataDir, MONITOR_API: '0', MONITOR_PROFILE: 'L' }
  }
)
await sleep(12000)
const out = spawnSync('powershell.exe', ['-NoProfile', '-Command', [
  "$ErrorActionPreference='SilentlyContinue'",
  "Get-Process -Name electron | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object Id,MainWindowHandle,MainWindowTitle | Format-Table -AutoSize | Out-String"
].join('\n')], { encoding: 'utf8' })
console.log('windowsHide=' + (mode === 'hide') + '  ->  ' + (out.stdout.trim() || '(没有带主窗口的 electron 进程)'))
try { child.kill() } catch {}
await sleep(800)
process.exit(0)