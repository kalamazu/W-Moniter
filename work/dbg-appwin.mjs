import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, sleep } from '../scripts/app-harness.mjs'
import { startOrigin } from '../scripts/test-origin.mjs'

const dataDir = mkdtempSync(join(tmpdir(), 'dbg-'))
const origin = await startOrigin(0)
const app = await launchApp({
  url: 'http://127.0.0.1:' + origin.port + '/',
  dataDir,
  port: 9721,
  tab: 'list',
  extraEnv: {}
})
await app.waitConnected(1)

const ps = [
  "$ErrorActionPreference='Stop'",
  "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | ForEach-Object { 'PID ' + $_.ProcessId + ' :: ' + $_.CommandLine }"
].join('\n')
const out = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
console.log('--- electron 进程 ---')
console.log(out.stdout.trim().slice(0, 3000))
console.log('--- app.log 尾部 ---')
console.log('stderr:', out.stderr.trim().slice(0, 500))

const out2 = spawnSync('powershell.exe', ['-NoProfile', '-Command', [
  "$ErrorActionPreference='Stop'",
  "Get-Process -Name electron | Select-Object Id, MainWindowHandle, MainWindowTitle | Format-Table -AutoSize | Out-String"
].join('\n')], { encoding: 'utf8' })
console.log(out2.stdout.trim())

await app.close()
await sleep(500)
process.exit(0)