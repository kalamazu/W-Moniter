#!/usr/bin/env node
/**
 * 起受控 origin + 非 headless 跑一次看板，中途截图，然后体面收工。
 * 用 Node 编排而不是 PowerShell：跨进程等待和信号处理干净得多。
 *
 *   node scripts/demo-run.mjs <自动退出ms> <截图前等待秒> <输出png>
 *
 * 两个 Windows 坑，踩过就别再踩：
 *   1. 截图先落到 ASCII 临时路径再拷到目标路径 —— PowerShell 5.1 的 -File
 *      参数传非 ASCII 路径不可靠；窗口在出现之前会被反复重试。
 *   2. 拉起 Electron 时**不能**设 windowsHide —— 它会把 STARTUPINFO 的
 *      wShowWindow 设成 SW_HIDE，而进程第一次 ShowWindow 会被强制成隐藏，
 *      于是 BrowserWindow 永远不显示，PrintWindow 也就无窗可截。
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, openSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url)) + '/..'
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const SHOOT = join(ROOT, 'scripts', 'shoot-win.ps1')
const CLEANUP = join(ROOT, 'scripts', 'cleanup-stray.ps1')

const [autoQuitMs = '45000', shotAfterSec = '14', out = 'shot.png'] = process.argv.slice(2)
const ORIGIN_PORT = process.env['DEMO_ORIGIN_PORT'] ?? '8777'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 这两个 ps1 内部会把 stdout 设成 utf8，所以这里按 utf8 解码是安全的 */
function runPs(script, args) {
  return execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
    { encoding: 'utf8', timeout: 60_000 }
  )
}

function cleanupStray() {
  try {
    process.stdout.write(runPs(CLEANUP, ['-Root', ROOT]))
  } catch (err) {
    console.error('清理残留进程失败:', String(err.stdout ?? err.message).trim())
  }
}

// 上一次没退干净的 electron / chrome 会让截图抓到旧窗口，先清场
cleanupStray()

const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '')
const dataDir = join(ROOT, '.userdata', `demo-${stamp}`)
mkdirSync(dataDir, { recursive: true })

const origin = spawn(process.execPath, ['scripts/test-origin.mjs', ORIGIN_PORT], {
  cwd: ROOT,
  stdio: 'ignore',
  windowsHide: true
})
await sleep(1500)
console.log(`origin pid=${origin.pid}`)
console.log(`数据目录 ${dataDir}`)

const logFd = openSync(join(dataDir, 'app.log'), 'a')
const app = spawn(ELECTRON, ['out/main/index.js', '--no-sandbox'], {
  cwd: ROOT,
  stdio: ['ignore', logFd, logFd],
  env: {
    ...process.env,
    MONITOR_URL: `http://127.0.0.1:${ORIGIN_PORT}/`,
    MONITOR_DATA_DIR: dataDir,
    MONITOR_AUTO_QUIT_MS: autoQuitMs
  }
})
console.log(`electron pid=${app.pid}  面板=${process.env['MONITOR_UI_TAB'] ?? 'list'}`)

/** 窗口从 spawn 到能截需要点时间，抓不到就隔一会儿再试 */
async function shoot(target, attempts = 6, gapMs = 3000) {
  for (let i = 1; i <= attempts; i++) {
    const stage = join(tmpdir(), `monitor-shot-${stamp}.png`)
    try {
      process.stdout.write(runPs(SHOOT, ['-ProcessName', 'electron', '-Out', stage]))
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(stage, target)
      console.log(`截图 ${target}`)
      return true
    } catch (err) {
      console.log(`第 ${i}/${attempts} 次没截到: ${String(err.stdout ?? err.message).trim()}`)
    } finally {
      try {
        rmSync(stage, { force: true })
      } catch {
        /* 临时文件没删掉不影响结果 */
      }
    }
    await sleep(gapMs)
  }
  console.error('截图失败：重试次数用尽')
  return false
}

if (out !== '-' && out !== 'skip') {
  await sleep(Number(shotAfterSec) * 1000)
  await shoot(out)
}

const exited = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), 90_000)
  app.on('exit', () => {
    clearTimeout(timer)
    resolve(true)
  })
})
if (!exited) app.kill()
if (!origin.killed) origin.kill()

// 应用体面退出后仍可能有孤儿进程
cleanupStray()

console.log(`日志 ${join(dataDir, 'app.log')}`)
