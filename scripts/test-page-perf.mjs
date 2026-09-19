#!/usr/bin/env node
/**
 * §12「对页面的性能影响」验收：Profile L < 2×，Profile H < 1.3×。
 *
 * 三臂对照，同一台机器、同一个 chrome.exe、同一份负载页：
 *   base  直接起 Chrome —— 参数与容器逐字一致，只是不带 --remote-debugging-pipe，零监控
 *   L     监控容器 · Profile L（Runtime/Debugger 开着，直连模式）
 *   H     监控容器 · Profile H（隐蔽模式，无 Runtime）
 *
 * 数字由负载页自己量、POST 回受控 origin，脚本再从 origin 的请求日志里读回来。
 * 为什么绕这一圈：基线臂压根没有 CDP，只有「页面自量 + HTTP 回报」这条路，
 * 三臂量的才是同一件事。经 CDP 的 Runtime.evaluate 取数会把监控自己的开销算进去。
 *
 * 轮内交错（base → L → H），各阶段取中位数再算倍数 —— 机器热漂移和后台抖动
 * 被交错抵消，剩下的才是监控开销。
 *
 * 判据用 work（cpu+dom+net）而不是导航全程：导航全程里混着浏览器启动这类
 * 一次性成本（新 profile 实测 270ms 上下），跟监控无关，会把倍数搅成 0.5×。
 * 页面自己跑两轮，只认第二轮，start / warm_* / total 照报但只作参考。
 *
 * 第三臂参数是服务端思考时间（ms/请求）。判据取 15ms —— 真实页面的耗时大头是
 * 网络与服务端处理，监控碰不到那一块。把它调成 0 就是 loopback 最坏情况：
 * 此时 L / H 实测到 1.51× / 1.39×（绝对值 +94ms / +70ms per 120 请求），
 * 也就是「页面耗时几乎全贴着监控」时比值能差到什么程度。
 *
 *   node scripts/test-page-perf.mjs [轮数=3]
 */

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startOrigin } from './test-origin.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const CLEANUP = join(ROOT, 'scripts', 'cleanup-stray.ps1')

const ROUNDS = Math.max(1, Number(process.argv[2] ?? 3))
/** §12 的两条判据 */
const BUDGET = { L: 2, H: 1.3 }
const WORKLOAD = '/perf.html'
/**
 * 服务端思考时间（ms/请求），模拟真实网络 RTT + 服务端处理。
 * 这块时间监控碰不到，而它正是真实页面耗时的大头 —— 用 loopback 的 0 延迟
 * 当对照组，等于假设页面全部耗时都贴着监控，比值会被放大到最坏情况。
 * 判据用 15ms（保守：真实 RTT 普遍 10~100ms）；传 0 可以复现最坏情况。
 */
const THINK_MS = Math.max(0, Number(process.argv[3] ?? 15))
/** 负载页固定发 120 条请求；少了说明页面没跑完，不能拿去算倍数 */
const EXPECTED_REQUESTS = 120

const REPORT_TIMEOUT_MS = 90_000
const QUIT_TIMEOUT_MS = 25_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Chromium\\Application\\chrome.exe'
]

function locateChrome() {
  const override = process.env['CHROME_PATH']
  if (override && existsSync(override)) return override
  const hit = CHROME_CANDIDATES.find((candidate) => existsSync(candidate))
  if (!hit) throw new Error('找不到 Chrome 内核，用 CHROME_PATH 指过去')
  return hit
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function cleanupStray() {
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CLEANUP, '-Root', ROOT], {
      encoding: 'utf8',
      timeout: 60_000,
      stdio: 'pipe'
    })
  } catch {
    /* 清理失败不影响结论 */
  }
}

/** 只结束自己 spawn 出来的那棵进程树，不碰用户自己的浏览器 */
function killTree(pid) {
  if (!pid) return
  try {
    execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', timeout: 30_000 })
  } catch {
    /* 已经退干净了 */
  }
}

function waitExit(child, ms) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true)
    const timer = setTimeout(() => resolve(false), ms)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/**
 * 与 src/main/browser/launch.ts 的 buildArgs 逐字对齐，只去掉 --remote-debugging-pipe。
 * 两臂差的必须只有「监控」这一件事 —— 参数漂了，量出来的倍数就不是监控开销了。
 */
function baselineArgs(userDataDir, url) {
  return [
    '--user-data-dir=' + userDataDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1280,900',
    '--window-position=60,40',
    '--headless=new',
    url
  ]
}

async function waitReport(origin, nonce, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const hit = origin.requests.find(
      (row) => row.path === '/api/perf-report' && String(row.query || '').includes('nonce=' + nonce)
    )
    if (hit) return new URLSearchParams(String(hit.query).replace(/^\?/, ''))
    await sleep(150)
  }
  return null
}

function parseReport(params) {
  if (!params) return null
  const num = (key) => Number(params.get(key))
  return {
    err: params.get('err') || null,
    ua: params.get('ua') || '',
    start: num('start'),
    total: num('total'),
    warm: num('warm_cpu') + num('warm_dom') + num('warm_net'),
    cpu: num('cpu'),
    dom: num('dom'),
    net: num('net'),
    work: num('work'),
    ok: num('ok'),
    rows: num('rows')
  }
}

function verify(label, report) {
  if (!report) throw new Error(label + '：页面没回报负载数字')
  if (report.err) throw new Error(label + '：页面执行出错 ' + report.err)
  if (report.ok !== EXPECTED_REQUESTS) {
    throw new Error(label + '：只跑完 ' + report.ok + '/' + EXPECTED_REQUESTS + ' 条请求，页面没跑完')
  }
  if (!(report.work > 0)) throw new Error(label + '：work 不是正数（' + report.work + '）')
  return report
}

async function runBaseline(chrome, url, nonce, origin) {
  const dir = mkdtempSync(join(tmpdir(), 'page-perf-base-'))
  const child = spawn(chrome, baselineArgs(join(dir, 'profile'), url), {
    stdio: 'ignore',
    windowsHide: true
  })
  try {
    return verify('base', parseReport(await waitReport(origin, nonce, REPORT_TIMEOUT_MS)))
  } finally {
    killTree(child.pid)
    await sleep(400)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* Windows 上偶尔删不掉，不影响结论 */
    }
  }
}

async function runMonitored(profile, url, nonce, origin) {
  const dir = mkdtempSync(join(tmpdir(), 'page-perf-' + profile + '-'))
  const quitFile = join(dir, 'quit')
  const child = spawn(ELECTRON, ['out/main/index.js', '--no-sandbox'], {
    cwd: ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      MONITOR_URL: url,
      MONITOR_DATA_DIR: dir,
      MONITOR_HEADLESS: '1',
      MONITOR_PROFILE: profile,
      MONITOR_QUIT_FILE: quitFile
    }
  })
  const log = []
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => log.push(chunk))
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => log.push(chunk))
  try {
    const params = await waitReport(origin, nonce, REPORT_TIMEOUT_MS)
    if (!params) {
      throw new Error('Profile ' + profile + '：等不到负载回报；日志尾部\n' + log.join('').split('\n').slice(-12).join('\n'))
    }
    return verify('Profile ' + profile, parseReport(params))
  } finally {
    writeFileSync(quitFile, 'quit')
    const exited = await waitExit(child, QUIT_TIMEOUT_MS)
    if (!exited) console.log('  应用没按时退出，强制结束')
    killTree(child.pid)
    await sleep(400)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 同上 */
    }
  }
}

/* ---------------------------------------------------------------- 主流程 */

console.log('== §12 对页面的性能影响 ==')
const chrome = locateChrome()
console.log('内核 ' + chrome)
console.log('轮数 ' + ROUNDS + ' × 3 臂（base → L → H 交错）')
console.log('服务端思考时间 ' + THINK_MS + 'ms/请求' + (THINK_MS === 0 ? '（loopback 最坏情况）' : '（模拟真实网络与服务端）'))

cleanupStray()
const origin = await startOrigin(0)
const runs = { base: [], L: [], H: [] }
let ua = ''
let failure = null

try {
  for (let round = 1; round <= ROUNDS; round += 1) {
    for (const arm of ['base', 'L', 'H']) {
      const nonce = arm + '-' + round + '-' + Date.now()
      const url = 'http://127.0.0.1:' + origin.port + WORKLOAD + '?d=' + THINK_MS + '&nonce=' + nonce
      const report =
        arm === 'base'
          ? await runBaseline(chrome, url, nonce, origin)
          : await runMonitored(arm, url, nonce, origin)
      runs[arm].push(report)
      if (report.ua) ua = report.ua
      console.log(
        '  第 ' + round + ' 轮 ' + arm.padEnd(4) +
        ' total ' + report.total.toFixed(1) + 'ms' +
        '  (start ' + report.start.toFixed(1) + ' / warm ' + report.warm.toFixed(1) +
        ' / work ' + report.work.toFixed(1) + ' = cpu ' + report.cpu.toFixed(1) + ' + dom ' + report.dom.toFixed(1) + ' + net ' + report.net.toFixed(1) + ')'
      )
      if (arm === 'base') cleanupStray()
    }
  }
} catch (err) {
  failure = err
} finally {
  await origin.close()
  cleanupStray()
}

if (failure) {
  console.log('\n✗ 跑挂了: ' + failure.message)
  process.exit(1)
}

const med = (arm, key) => median(runs[arm].map((row) => row[key]))
/** 前两行与最后一行只作参考（一次性成本 / 导航全程），判据只看 work 那一行 */
const KEYS = [
  ['start', 'start 导航→脚本'],
  ['warm', 'warm 第一轮'],
  ['cpu', 'cpu 纯计算'],
  ['dom', 'dom 建节点'],
  ['net', 'net 120 请求'],
  ['work', 'work 判据负载'],
  ['total', 'total 导航→结束']
]

console.log('\n================ §12 对页面的性能影响 ================')
console.log('chrome 内核      Chrome/' + ua)
console.log('每臂轮数         ' + ROUNDS + '（取中位数）')

let line = '阶段'.padEnd(18, ' ')
for (const arm of ["base", "L", "H"]) line += arm.padStart(12, " ")
line += 'L/base'.padStart(10, ' ') + 'H/base'.padStart(10, ' ')
console.log(line)

const ratio = {}
for (const [key, label] of KEYS) {
  const base = med("base", key)
  const l = med("L", key)
  const h = med("H", key)
  ratio[key] = { L: l / base, H: h / base }
  const row =
    label.padEnd(14, " ") +
    base.toFixed(1).padStart(14, " ") +
    l.toFixed(1).padStart(12, " ") +
    h.toFixed(1).padStart(12, " ") +
    ratio[key].L.toFixed(2).padStart(12, " ") +
    ratio[key].H.toFixed(2).padStart(12, " ")
  console.log(row)
}

const results = []
function check(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
    console.log('  ✓ ' + name)
  } catch (err) {
    results.push({ name, ok: false, message: err.message })
    console.log('  ✗ ' + name + '\n      ' + err.message)
  }
}

check('Profile L：页面负载耗时 < 2×（§12）', () => {
  const got = ratio.work.L
  if (!(got < BUDGET.L)) {
    throw new Error('L 实测 ' + got.toFixed(2) + '×，超过 ' + BUDGET.L + '×');
  }
  console.log("      实测 " + got.toFixed(2) + "×");
})
check('Profile H：页面负载耗时 < 1.3×（§12）', () => {
  const got = ratio.work.H
  if (!(got < BUDGET.H)) {
    throw new Error('H 实测 ' + got.toFixed(2) + '×，超过 ' + BUDGET.H + '×');
  }
  console.log("      实测 " + got.toFixed(2) + "×");
})
check('负载页在每一臂都真的跑完了', () => {
  for (const arm of ["base", "L", "H"]) {
    if (runs[arm].length !== ROUNDS) {
      throw new Error(arm + ' 只成功 ' + runs[arm].length + '/' + ROUNDS + ' 轮');
    }
  }
})

console.log('\n== 结果 ==')
const failed = results.filter((item) => !item.ok)
console.log('  ' + (results.length - failed.length) + '/' + results.length + ' 通过')
process.exit(failed.length === 0 ? 0 : 1)
