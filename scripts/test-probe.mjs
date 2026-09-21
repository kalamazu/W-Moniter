#!/usr/bin/env node
/**
 * P6 验收（一）：检测探针。
 *
 * 对应设计文档 §3.6（探针报告 → 推荐 profile）、§7.1 #8、§12（隐蔽性）。
 *
 * 这个脚本跑两遍，两个 Profile 各一遍，两边的断言合起来才叫验收：
 *
 *   Profile L：Runtime 域是开的。**探针必须检出痕迹** —— 检不出说明探针是摆设。
 *   Profile H：Runtime 域关着。**探针必须干净** —— 这就是 §12 的「通过探针全部 CDP 检测项」。
 *
 * 顺手验证两条回传通道：L 走 Runtime.evaluate，H 走注入 + 信标回传。
 * H 能拿到报告，就等于 §3.5 的 Hook 回传通道通了。
 *
 *   node scripts/test-probe.mjs [--dump]
 */

import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const CLEANUP = join(ROOT, 'scripts', 'cleanup-stray.ps1')
const DUMP = process.argv.includes('--dump')

const ORIGIN_PORT = Number(process.env['PROBE_ORIGIN_PORT'] ?? 8788)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const results = []
function check(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
    console.log(`  \u2713 ${name}`)
  } catch (err) {
    results.push({ name, ok: false, message: err.message })
    console.log(`  \u2717 ${name}\n      ${err.message}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function cleanupStray() {
  try {
    execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CLEANUP, '-Root', ROOT],
      { encoding: 'utf8', timeout: 60_000, stdio: 'pipe' }
    )
  } catch {
    /* 清理失败不影响结论 */
  }
}

/* ------------------------------------------------------------ CDP 客户端 */

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      if (!msg.id) return
      const slot = this.pending.get(msg.id)
      if (!slot) return
      this.pending.delete(msg.id)
      if (msg.error) slot.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
      else slot.resolve(msg.result)
    }
    ws.onclose = () => this.failAll('调试目标已断开')
    ws.onerror = () => this.failAll('调试连接出错')
  }

  failAll(reason) {
    for (const slot of this.pending.values()) slot.reject(new Error(reason))
    this.pending.clear()
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
}

async function openCdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 15000)
    ws.onopen = () => {
      clearTimeout(timer)
      resolve()
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error('CDP WebSocket 连接失败'))
    }
  })
  return new Cdp(ws)
}

async function waitControlTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const hit = list.find((t) => t.type === 'page' && String(t.url).includes('index.html'))
      if (hit?.webSocketDebuggerUrl) return hit
    } catch {
      /* 端口还没起来 */
    }
    await sleep(400)
  }
  return null
}

/* --------------------------------------------------------- 面板侧的动作 */

/**
 * 打开环境面板、点「运行探针」、等报告，再把所有分组展开并逐组读回表格。
 * 断言全在报告数据上做，所以分组归属必须显式带着 —— 靠行序猜分组是自欺欺人。
 */
const UI_RUN = `
(async () => {
  const frame = () => new Promise((r) => setTimeout(r, 60))
  const waitFor = async (selector, ms) => {
    const t0 = performance.now()
    while (performance.now() - t0 < ms) {
      const el = document.querySelector(selector)
      if (el) return el
      await frame()
    }
    return null
  }
  const text = (el) => (el ? el.textContent.trim() : '')
  // 挂上调试目标时 React 往往还没挂载，必须等元素出现，而不是查一次没有就判死
  // 自由工作区之后没有「环境 tab」了：?tab=env 开局就把环境面板摆进栏里。老版界面
  // 还要点一下 tab，所以两种都认：先等面板，等不到再找 tab 点。
  let button = await waitFor('.probe-run', 12000)
  if (!button) {
    const tabs = await waitFor('.tabs', 10000)
    if (!tabs) return { ok: false, reason: 'no-tabs', html: document.body.innerHTML.slice(0, 300) }
    const tab = [...document.querySelectorAll('.tab')].find((b) => b.textContent.trim() === '环境')
    if (!tab) return { ok: false, reason: 'no-env-panel', html: tabs.innerHTML.slice(0, 300) }
    tab.click()
    button = await waitFor('.probe-run', 20000)
  }
  if (!button) return { ok: false, reason: 'no-probe-button' }
  button.click()
  const report = await waitFor('.probe-report', TIMEOUT_MS)
  if (!report) {
    const banner = document.querySelector('.banner-err')
    return { ok: false, reason: 'no-report', error: banner ? text(banner) : '' }
  }
  for (let round = 0; round < 8; round++) {
    const closed = [...document.querySelectorAll('.probe-group')].filter((g) => !g.querySelector('.probe-table'))
    if (closed.length === 0) break
    for (const group of closed) group.querySelector('.probe-group-head')?.click()
    await frame()
    await frame()
  }
  const details = document.querySelector('.probe-fingerprint')
  if (details && !details.open) details.querySelector('summary')?.click()
  await frame()
  await frame()
  return {
    ok: true,
    recommend: text(document.querySelector('.probe-recommend')),
    summary: text(document.querySelector('.probe-summary')),
    reason: text(document.querySelector('.probe-reason')),
    groupRows: [...document.querySelectorAll('.probe-group')].map((g) => ({
      head: text(g.querySelector('.probe-group-head')),
      rows: [...g.querySelectorAll('.probe-table tr')].map((tr) =>
        [...tr.querySelectorAll('td')].map((td) => td.textContent.trim())
      )
    })),
    fingerprint: [...document.querySelectorAll('.probe-fingerprint .probe-table tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.textContent.trim())
    ),
    capability: [...document.querySelectorAll('.env-caps .pill')].map((p) => p.textContent.trim())
  }
})()
`

/** 取某个分组里的失败项（[状态, 名称, 值, 说明]） */
function failsIn(outcome, groupName) {
  const group = outcome.groupRows.find((entry) => entry.head.includes(groupName))
  return (group?.rows ?? []).filter((row) => row[0] === '失败')
}

function groupSize(outcome, groupName) {
  const group = outcome.groupRows.find((entry) => entry.head.includes(groupName))
  return group?.rows.length ?? 0
}

async function runProfile(profile, cdpPort) {
  const dir = join(ROOT, '.userdata', `probe-${profile}-${Date.now().toString(36)}`)
  mkdirSync(dir, { recursive: true })

  const origin = spawn(process.execPath, ['scripts/test-origin.mjs', String(ORIGIN_PORT)], {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true
  })
  await sleep(1500)

  const logPath = join(dir, 'app.log')
  const logFd = openSync(logPath, 'a')
  const app = spawn(
    ELECTRON,
    ['out/main/index.js', '--no-sandbox', `--remote-debugging-port=${cdpPort}`],
    {
      cwd: ROOT,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        MONITOR_URL: `http://127.0.0.1:${ORIGIN_PORT}/`,
        MONITOR_DATA_DIR: dir,
        MONITOR_PROFILE: profile,
        MONITOR_UI_TAB: 'env',
        MONITOR_CAPTURE_BODIES: '0',
        MONITOR_CAPTURE_SCRIPTS: '0',
        MONITOR_AUTO_QUIT_MS: '0'
      }
    }
  )

  let outcome = null
  let failure = null
  try {
    const target = await waitControlTarget(cdpPort, 60000)
    if (!target) throw new Error('等不到控制窗口的调试目标')
    const cdp = await openCdp(target.webSocketDebuggerUrl)

    // Profile H 要「注入 → 刷新 → 等信标」，给足时间
    const expression = UI_RUN.replace('TIMEOUT_MS', profile === 'H' ? '90000' : '45000')
    let lastError = null
    for (let attempt = 1; attempt <= 3 && !outcome; attempt++) {
      try {
        const evaluated = await cdp.send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
          timeout: 180000
        })
        if (evaluated?.exceptionDetails) {
          throw new Error(evaluated.exceptionDetails.exception?.description ?? '面板探针抛异常')
        }
        outcome = evaluated?.result?.value ?? null
        if (!outcome) throw new Error('面板探针没回结果')
      } catch (err) {
        lastError = err
        if (!/destroyed|Cannot find context|Target closed/i.test(err.message)) throw err
        await sleep(1000)
      }
    }
    if (!outcome) throw lastError ?? new Error('面板探针没结果')
  } catch (err) {
    failure = err
  } finally {
    try {
      app.kill()
    } catch {
      /* 已经退了 */
    }
    try {
      origin.kill()
    } catch {
      /* 已经退了 */
    }
    await sleep(600)
    cleanupStray()
  }

  let log = ''
  try {
    log = readFileSync(logPath, 'utf8')
  } catch {
    /* 日志没写出来就算了 */
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* Windows 上偶尔删不掉，不影响结论 */
  }

  return { outcome, failure, log: log.slice(-4000) }
}

/* ------------------------------------------------------------------ 主流程 */

console.log('== P6 检测探针验收 ==')

for (const [profile, port] of [
  ['L', Number(process.env['PROBE_CDP_PORT_L'] ?? 9455)],
  ['H', Number(process.env['PROBE_CDP_PORT_H'] ?? 9456)]
]) {
  console.log(`\n== Profile ${profile} ==`)
  const run = await runProfile(profile, port)
  if (run.failure) {
    console.log(`  \u2717 跑挂了: ${run.failure.message}`)
    results.push({ name: `Profile ${profile} 跑通`, ok: false, message: run.failure.message })
    console.log('  日志尾部:\n' + run.log.split('\n').slice(-12).join('\n'))
    continue
  }

  const outcome = run.outcome
  if (DUMP) console.log('\n--- 报告原文 ---\n' + JSON.stringify(outcome, null, 2))

  check(`Profile ${profile}：面板里出了探针报告`, () => {
    assert(
      outcome.ok,
      `面板没出报告（${outcome.reason} ${outcome.error ?? ''} ${outcome.html ?? ''}）`
    )
    assert(outcome.groupRows.length >= 4, `报告只有 ${outcome.groupRows.length} 个分组，应当有 4 个`)
    assert(groupSize(outcome, 'CDP 痕迹') > 0, 'CDP 痕迹分组是空的')
  })

  check(`Profile ${profile}：四个分组都有检测项`, () => {
    for (const name of ['CDP 痕迹', '自动化标记', '指纹一致性', '运行环境']) {
      assert(groupSize(outcome, name) > 0, `分组「${name}」一项都没有`)
    }
  })

  check(`Profile ${profile}：指纹明细有内容`, () => {
    assert(outcome.fingerprint.length >= 8, `指纹只有 ${outcome.fingerprint.length} 项`)
    const ua = outcome.fingerprint.find((row) => row[0] === 'UA')
    assert(ua && ua[1] && ua[1] !== '—', 'UA 没取到')
  })

  if (profile === 'L') {
    check('Profile L：探针检出了 Runtime 痕迹（检不出就是探针失效）', () => {
      const fails = failsIn(outcome, 'CDP 痕迹')
      assert(fails.length > 0, 'L 下 Runtime.enable 明明开着，却一项失败都没有')
      console.log('      检出: ' + fails.map((row) => row[1]).join(' / '))
    })
    check('Profile L：推荐切到 H', () => {
      assert(/建议 Profile H/.test(outcome.recommend), `推荐结果不对: ${outcome.recommend}`)
    })
  } else {
    check('Profile H：CDP 痕迹零失败（§12 隐蔽性）', () => {
      const fails = failsIn(outcome, 'CDP 痕迹')
      assert(fails.length === 0, '仍有失败项: ' + fails.map((row) => row[1] + '=' + row[2]).join(' / '))
    })
    check('Profile H：自动化标记零失败', () => {
      const fails = failsIn(outcome, '自动化标记')
      assert(fails.length === 0, '仍有失败项: ' + fails.map((row) => row[1] + '=' + row[2]).join(' / '))
    })
    check('Profile H：推荐保持 L 能力（无痕迹）', () => {
      assert(/建议 Profile L/.test(outcome.recommend), `推荐结果不对: ${outcome.recommend}`)
    })
    check('Profile H：注入 + 信标回传通道可用（§3.5 雏形）', () => {
      assert(outcome.ok, '报告没回来，说明信标回传通道没通')
    })
  }

  check(`Profile ${profile}：能力矩阵与 Profile 一致`, () => {
    const runtime = outcome.capability.find((text) => text.startsWith('Runtime'))
    assert(runtime, '能力矩阵里没有 Runtime 项')
    const on = /开启/.test(runtime)
    assert((profile === 'L') === on, `Profile ${profile} 下 Runtime 能力显示为「${runtime}」`)
  })

  // 窗口/探针日志：失败时必打（这类失败都是启动期竞态，光看断言看不出原因），
  // --dump 时也打，方便确认平时走的到底是哪条路（比如窗口是第一把就摆正，还是重试过）
  const windowLog = run.log
    .split('\n')
    .filter((line) => /\[window\]|\[probe\]|\[fetch\]/.test(line))
  const profileFailed = results.some((row) => !row.ok && row.name.startsWith(`Profile ${profile}`))
  if (windowLog.length && (profileFailed || DUMP)) {
    console.log('  应用日志:\n' + windowLog.map((line) => '    ' + line).join('\n'))
  }
}

console.log('\n== 结果 ==')
const failed = results.filter((item) => !item.ok)
console.log(`  ${results.length - failed.length}/${results.length} 通过`)
for (const item of failed) console.log(`  \u2717 ${item.name}: ${item.message}`)
process.exit(failed.length === 0 ? 0 : 1)
