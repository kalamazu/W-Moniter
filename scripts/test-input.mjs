#!/usr/bin/env node
/**
 * P6 验收（二）：拟人化输入（§6.4、§7.1 #8）。
 *
 * 判据不是「调用没报错」，而是**页面侧录到的真实事件轨迹**：
 *   1. 事件必须 isTrusted —— 证明走的是浏览器输入管线，不是 JS dispatch（§6.4 的层次选择）。
 *   2. 轨迹要能骗过一个行为检测器：多采样点、弧线、变速、停顿、精确落点。
 *   3. 同一个 seed 必须复现同一条轨迹 —— 不然「通过检测」这件事没法重放。
 *
 * 验收里自带一个检测器，并且**先证明它有判别力**：把「一次跳到位」的假轨迹喂给它，
 * 它必须判成机器。否则「我们的轨迹通过了」这句话没有意义。
 *
 *   node scripts/test-input.mjs
 */

import { spawn } from 'node:child_process'
import { mkdirSync, openSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

const ORIGIN_PORT = Number(process.env['INPUT_ORIGIN_PORT'] ?? 8789)
const CDP_PORT = Number(process.env['INPUT_CDP_PORT'] ?? 9457)
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

/* ------------------------------------------------------------ 行为检测器 */

function cv(values) {
  if (values.length === 0) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  if (mean === 0) return 0
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length
  return Math.sqrt(variance) / mean
}

function analyse(moves) {
  const steps = []
  const gaps = []
  for (let i = 1; i < moves.length; i++) {
    steps.push(Math.hypot(moves[i].x - moves[i - 1].x, moves[i].y - moves[i - 1].y))
    gaps.push(moves[i].t - moves[i - 1].t)
  }
  const path = steps.reduce((a, b) => a + b, 0)
  const first = moves[0] ?? { x: 0, y: 0 }
  const last = moves[moves.length - 1] ?? { x: 0, y: 0 }
  const straight = Math.hypot(last.x - first.x, last.y - first.y)
  return {
    n: moves.length,
    path,
    straight,
    straightness: straight > 0.5 ? path / straight : 1,
    maxStep: steps.length ? Math.max(...steps) : 0,
    maxGap: gaps.length ? Math.max(...gaps) : 0,
    dtCv: cv(gaps),
    speedCv: cv(steps.filter((step) => step > 0.01)),
    pauses: gaps.filter((gap) => gap > 35).length,
    trusted: moves.every((move) => move.trusted !== false),
    last
  }
}

/** 返回判成机器的理由；空数组 = 像人 */
function machineLike(metrics) {
  const reasons = []
  if (metrics.n < 6) reasons.push(`轨迹点太少（${metrics.n} 个）—— 一次跳到位`)
  if (metrics.maxStep > 60) reasons.push(`单步位移 ${metrics.maxStep.toFixed(1)}px 过大`)
  if (metrics.n >= 6 && metrics.dtCv < 0.12) {
    reasons.push(`步进间隔几乎恒定（CV ${metrics.dtCv.toFixed(3)}）—— 像定时器`)
  }
  if (metrics.n >= 6 && metrics.speedCv < 0.1) {
    reasons.push(`步长分布过于均匀（CV ${metrics.speedCv.toFixed(3)}）—— 没有变速`)
  }
  if (metrics.straight > 100 && metrics.straightness < 1.005) {
    reasons.push(`轨迹是直线（路程/直线 ${metrics.straightness.toFixed(4)}）`)
  }
  if (!metrics.trusted) reasons.push('存在 isTrusted=false 的事件 —— 是 JS 派发，不是真实输入')
  return reasons
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

async function waitControlTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      const hit = list.find((t) => t.type === 'page' && String(t.url).includes('index.html'))
      if (hit?.webSocketDebuggerUrl) return hit
    } catch {
      /* 端口还没起来 */
    }
    await sleep(400)
  }
  return null
}

/* ------------------------------------------------------------------ 主流程 */

const dir = join(ROOT, '.userdata', `input-${Date.now().toString(36)}`)
mkdirSync(dir, { recursive: true })

const origin = spawn(process.execPath, ['scripts/test-origin.mjs', String(ORIGIN_PORT)], {
  cwd: ROOT,
  stdio: 'ignore',
  windowsHide: true
})
await sleep(1500)

const logFd = openSync(join(dir, 'app.log'), 'a')
const app = spawn(
  ELECTRON,
  ['out/main/index.js', '--no-sandbox', `--remote-debugging-port=${CDP_PORT}`],
  {
    cwd: ROOT,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      MONITOR_URL: `http://127.0.0.1:${ORIGIN_PORT}/input-probe.html`,
      MONITOR_DATA_DIR: dir,
      MONITOR_PROFILE: 'L',
      MONITOR_UI_TAB: 'env',
      MONITOR_CAPTURE_BODIES: '0',
      MONITOR_CAPTURE_SCRIPTS: '0',
      MONITOR_AUTO_QUIT_MS: '0'
    }
  }
)

const H = 'http://127.0.0.1:' + ORIGIN_PORT

try {
  const target = await waitControlTarget(60000)
  if (!target) throw new Error('等不到控制窗口的调试目标')
  const cdp = await openCdp(target.webSocketDebuggerUrl)

  // 控制窗口刚起来时会重建一次执行上下文（/json/list 会在导航中途就把目标报出来），
  // 那一小段时间里 Runtime.evaluate 会回「Execution context was destroyed」。
  // test-probe.mjs 踩过同一个坑，照它的做法只对这一小类瞬时错误重试。
  const transient = /destroyed|Cannot find context|Target closed/i
  const evaluate = async (expression) => {
    let lastError = null
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await cdp.send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
          timeout: 120000
        })
        if (res.exceptionDetails) {
          throw new Error(res.exceptionDetails.exception?.description ?? '控制窗口求值异常')
        }
        return res.result.value
      } catch (err) {
        lastError = err
        if (!transient.test(err.message)) throw err
        await sleep(1000)
      }
    }
    throw lastError
  }

  // 等受控页面就绪（monitor 侧要先把页面打开）
  let ready = false
  for (let i = 0; i < 40 && !ready; i++) {
    ready = await evaluate(
      `(async () => { const s = await window.monitor.getStatus(); return s.state === 'connected' && s.targets.some((t) => t.type === 'page') })()`
    )
    if (!ready) await sleep(500)
  }
  assert(ready, '控制器没连上')

  // 注入探针页必须真的加载了：控制台里跑一句就知道
  const probeReady = await evaluate(
    `(async () => { let out = null; for (let i = 0; i < 30 && !out?.ok; i++) { out = await window.monitor.evaluate('typeof window.__rec === "object" && document.title'); if (!out.ok || out.value !== '输入验收页') { out = { ok: false }; await new Promise((r) => setTimeout(r, 500)) } } return out })()`
  )
  assert(probeReady?.ok && probeReady.value === '输入验收页', '受控页没就绪: ' + JSON.stringify(probeReady))

  const runInput = (action) => evaluate(`window.monitor.runInput(${JSON.stringify(action)})`)
  // 页面侧求值：必须经控制器的 evaluate 通道打到**被监控页面**里。
  // 直接用上面的 evaluate() 会把表达式丢进控制窗口（React 面板）的 window ——
  // 那里没有 __rec/__resetRec，读输入框读到的也是面板自己的 DOM。
  const pageEval = async (expression) => {
    const res = await evaluate(`window.monitor.evaluate(${JSON.stringify(expression)})`)
    if (!res?.ok) throw new Error(res?.error ?? `页面求值失败: ${expression}`)
    return res.value
  }
  // 事件不是同步到页面的：DevTools 的回执只说明「浏览器收下了」，浏览器还要按渲染进程的
  // 回执节奏排队投递 —— 实测动作返回后 150ms 内还会到 30 多个点。测量前不等页面安静下来，
  // 上一条动作的尾巴就会被算进这一条（症状：轨迹里凭空多个 500px 的跳步、点数对不上）。
  // 这里等的是**测量窗口**，不是放宽判据：下面的断言一条没动。
  const recorderQuiet = async (quietPolls = 6, capMs = 2500) => {
    const t0 = Date.now()
    let last = -1
    let stable = 0
    while (Date.now() - t0 < capMs) {
      const n = await pageEval(
        'window.__rec.moves.length + window.__rec.wheels.length + window.__rec.keys.length + window.__rec.clicks.length'
      )
      if (n === last) {
        stable += 1
        if (stable >= quietPolls) return
      } else {
        stable = 0
      }
      last = n
      await sleep(25)
    }
  }
  const readRec = async () => {
    await recorderQuiet()
    const raw = await pageEval('JSON.stringify(window.__rec)')
    return JSON.parse(raw)
  }
  const resetRec = async () => {
    await recorderQuiet()
    return pageEval('window.__resetRec()')
  }

  console.log('\n== 轨迹（移动） ==')
  await resetRec()
  const moveReport = await runInput({ kind: 'move', x: 900, y: 600, seed: 20260919 })
  const move = analyse((await readRec()).moves)

  check('move：动作成功且有轨迹', () => {
    assert(moveReport.ok, '执行失败: ' + (moveReport.error ?? ''))
    assert(moveReport.points >= 8, `只派发了 ${moveReport.points} 个轨迹点`)
    assert(move.n >= 8, `页面只录到 ${move.n} 个 mousemove`)
  })

  check('move：是真实输入（isTrusted）', () => {
    assert(move.trusted, '录到 isTrusted=false 的事件')
  })

  check('move：精确落点', () => {
    assert(
      Math.abs(move.last.x - 900) < 0.01 && Math.abs(move.last.y - 600) < 0.01,
      `落点 ${move.last.x},${move.last.y}，期望 900,600`
    )
  })

  check('move：轨迹骗得过行为检测器', () => {
    const reasons = machineLike(move)
    assert(reasons.length === 0, reasons.join(' / '))
    console.log(
      `      点 ${move.n} · 路程 ${move.path.toFixed(0)}px / 直线 ${move.straight.toFixed(0)}px` +
        ` · 最大步长 ${move.maxStep.toFixed(1)}px · 间隔CV ${move.dtCv.toFixed(2)}` +
        ` · 步长CV ${move.speedCv.toFixed(2)} · 停顿 ${move.pauses}`
    )
  })

  check('检测器有判别力（一次跳到位的假轨迹必须被判死）', () => {
    const jump = analyse([
      { x: 20, y: 20, t: 0, trusted: true },
      { x: 900, y: 600, t: 6, trusted: true }
    ])
    const reasons = machineLike(jump)
    assert(reasons.length > 0, '检测器把「一次跳到位」判成了人 —— 那前面的通过不算数')
  })

  console.log('\n== 同 seed 复现 ==')
  // 起点必须一样：轨迹是从「当前光标」铺到目标的，起点不同本来就不该是同一条曲线。
  // 所以每次都先用同一个摆位动作把光标放回 (300,200)，再跑被测的那一步。
  const replay = async () => {
    await runInput({ kind: 'move', x: 300, y: 200, seed: 1 })
    await resetRec()
    const report = await runInput({ kind: 'move', x: 900, y: 600, seed: 20260919 })
    return { report, recorded: analyse((await readRec()).moves) }
  }
  const first = await replay()
  const second = await replay()
  check('同一个 seed 复现同一条轨迹', () => {
    assert(
      first.report.points === second.report.points,
      `派发点数不一致：${first.report.points} vs ${second.report.points}`
    )
    assert(
      first.report.pathLength === second.report.pathLength,
      `规划路程不一致：${first.report.pathLength} vs ${second.report.pathLength}`
    )
    assert(
      first.report.maxStep === second.report.maxStep,
      `最大步长不一致：${first.report.maxStep} vs ${second.report.maxStep}`
    )
    // 页面侧看到的点会受合帧影响，允许一两个出入；几何形状必须一致
    assert(
      Math.abs(second.recorded.n - first.recorded.n) <= 2,
      `页面录到的点数不一致：${second.recorded.n} vs ${first.recorded.n}`
    )
    assert(
      Math.abs(second.recorded.path - first.recorded.path) < 3,
      `页面录到的路程不一致：${second.recorded.path.toFixed(2)} vs ${first.recorded.path.toFixed(2)}`
    )
    console.log(
      `      两次都是 ${first.report.points} 个轨迹点 · 规划路程 ${first.report.pathLength}px` +
        ` · 页面录到 ${first.recorded.n} 点 / ${first.recorded.path.toFixed(1)}px`
    )
  })

  console.log('\n== 点击 ==')
  await resetRec()
  const clickReport = await runInput({ kind: 'click', x: 660, y: 322, seed: 7 })
  const clickRec = await readRec()
  check('click：落在目标元素上', () => {
    assert(clickReport.ok, '执行失败: ' + (clickReport.error ?? ''))
    assert(clickRec.clicks.length === 1, `录到 ${clickRec.clicks.length} 次 click`)
    assert(clickRec.clicks[0].target === 'target', `点到了「${clickRec.clicks[0].target}」`)
    assert(clickRec.downs.length === 1 && clickRec.ups.length === 1, 'mousedown/mouseup 不成对')
    assert(clickRec.clicks[0].trusted && clickRec.downs[0].trusted, 'isTrusted 为假')
  })

  check('click：按下与抬起之间有时间差（不是零延迟合成事件）', () => {
    const hold = clickRec.ups[0].t - clickRec.downs[0].t
    assert(hold > 5, `按下到抬起只有 ${hold}ms`)
  })

  console.log('\n== 输入文本 ==')
  // 先点输入框拿到焦点，再打字 —— 这正是人的顺序
  await runInput({ kind: 'click', x: 750, y: 414, seed: 11 })
  await resetRec()
  // 打长一点：只有 6 个间隔时 CV 的抽样误差能和判据本身一样大，那样的通过/失败都是抛硬币
  const TYPE_TEXT = 'monitor human 2026'
  const typeReport = await runInput({ kind: 'type', text: TYPE_TEXT, seed: 42 })
  const typed = await pageEval('document.getElementById("field").value')
  const typeRec = await readRec()
  check('type：文本真的进了输入框', () => {
    assert(typeReport.ok, '执行失败: ' + (typeReport.error ?? ''))
    assert(typed === TYPE_TEXT, `输入框里是「${typed}」`)
    assert(typeRec.keys.length >= 15, `只录到 ${typeRec.keys.length} 个 keydown`)
    assert(typeRec.keys.every((key) => key.trusted), 'keydown 里有 isTrusted=false')
  })

  check('type：按键间隔不是恒定值', () => {
    const gaps = []
    for (let i = 1; i < typeRec.keys.length; i++) gaps.push(typeRec.keys[i].t - typeRec.keys[i - 1].t)
    assert(cv(gaps) > 0.15, `按键节奏 CV=${cv(gaps).toFixed(3)}（${gaps.length} 个间隔），太像脚本`)
  })

  console.log('\n== 选择器定位（agent 路径） ==')
  // agent 说的是「点那个按钮」，不是「点 (660,322)」。坐标写死在调用里，页面一改就失效
  await resetRec()
  const bySelector = await runInput({ kind: 'click', selector: '#target', seed: 13 })
  const selectorRec = await readRec()
  check('click：给选择器就能点中（不用先知道坐标）', () => {
    assert(bySelector.ok, '执行失败: ' + (bySelector.error ?? ''))
    assert(selectorRec.clicks.length === 1, `录到 ${selectorRec.clicks.length} 次 click`)
    assert(selectorRec.clicks[0].target === 'target', `点到了「${selectorRec.clicks[0].target}」`)
  })

  const missSelector = await runInput({ kind: 'click', selector: '#no-such-element' })
  check('选择器不存在时如实报错，不静默点 (0,0)', () => {
    assert(missSelector.ok === false, '不存在的选择器居然成功了')
    assert(/没找到可见元素/.test(missSelector.error ?? ''), `错误信息：${missSelector.error}`)
  })

  await resetRec()
  const typeBySelector = await runInput({ kind: 'type', selector: '#field', text: 'selector', seed: 21 })
  const typedBySelector = await pageEval('document.getElementById("field").value')
  check('type：给选择器会先聚焦再打字（文本真的进框）', () => {
    assert(typeBySelector.ok, '执行失败: ' + (typeBySelector.error ?? ''))
    assert(typedBySelector === 'selector', `输入框里是「${typedBySelector}」`)
  })
  console.log('\n== 滚动 ==')
  await resetRec()
  const scrollReport = await runInput({ kind: 'scroll', x: 640, y: 400, deltaY: 600, seed: 5 })
  const scrollRec = await readRec()
  check('scroll：拆成多次滚轮且总量正确', () => {
    assert(scrollReport.ok, '执行失败: ' + (scrollReport.error ?? ''))
    assert(scrollRec.wheels.length >= 4, `只录到 ${scrollRec.wheels.length} 次 wheel`)
    const total = scrollRec.wheels.reduce((sum, wheel) => sum + wheel.dy, 0)
    assert(Math.abs(total - 600) < 1, `滚轮总量 ${total}，期望 600`)
    assert(scrollRec.wheels.every((wheel) => wheel.trusted), 'wheel 里有 isTrusted=false')
  })

  console.log('\n== 导航后立刻点击（回归：非前台页面的鼠标回执会被压到 5s/次） ==')
  // 旧行为：页面不是前台标签时，Chromium 把每次鼠标事件的回执压到 ~5s，一次 8 点轨迹
  // 要 40s —— 调用方 12s 就超时了。所以判据必须是**墙钟上限**：光看 ok 抓不住这个 bug，
  // 它慢到超时之前一直是「成功」的。
  const navPageUrl = `http://127.0.0.1:${ORIGIN_PORT}/input-probe.html`
  await pageEval(`location.href = ${JSON.stringify(navPageUrl)}`)
  let landed = false
  for (let i = 0; i < 60 && !landed; i++) {
    try {
      landed = (await pageEval('document.title')) === '输入验收页'
    } catch {
      landed = false
    }
    if (!landed) await sleep(250)
  }
  assert(landed, '导航后新文档没起来')
  const afterNavT0 = Date.now()
  const afterNav = await runInput({ kind: 'click', selector: '#target', seed: 31 })
  const afterNavMs = Date.now() - afterNavT0
  // 阈值 10s：正常是 1~3s，退化时是 5s × 轨迹点数（10 点就是 50s），两边都不挨着
  check('导航后立刻点击：真点到，且墙钟 < 10s', () => {
    assert(afterNav.ok, '执行失败: ' + (afterNav.error ?? ''))
    assert(afterNavMs < 10000, `导航后点击花了 ${afterNavMs}ms（轨迹 ${afterNav.points} 点）`)
  })
  console.log(`      导航到落地 + 点击共 ${afterNavMs}ms，轨迹 ${afterNav.points} 点`)

  console.log('\n== 面板（UI 路径） ==')
  const uiReport = await evaluate(`
    (async () => {
      const frame = () => new Promise((r) => setTimeout(r, 60))
      const t0 = performance.now()
      let button = null
      while (performance.now() - t0 < 20000) {
        button = document.querySelector('.input-run-move')
        if (button && !button.disabled) break
        await frame()
      }
      if (!button) return { ok: false, reason: 'no-button' }
      button.click()
      const t1 = performance.now()
      let report = null
      while (performance.now() - t1 < 20000) {
        report = document.querySelector('.input-report')
        if (report && report.textContent.includes('轨迹点')) break
        await frame()
      }
      return { ok: Boolean(report), text: report ? report.textContent.trim() : '' }
    })()
  `)
  check('面板：点「移动」能出轨迹统计', () => {
    assert(uiReport.ok, '面板没出结果: ' + JSON.stringify(uiReport))
    const numbers = (uiReport.text.match(/[0-9]+(\.[0-9]+)?/g) ?? []).map(Number)
    assert(numbers.length >= 3, '统计里没有数字: ' + uiReport.text)
    assert(numbers[0] >= 8, `面板显示轨迹点 ${numbers[0]}，太少`)
    console.log('      ' + uiReport.text.replace(/\s+/g, ' ').slice(0, 120))
  })
} catch (err) {
  console.log(`  \u2717 跑挂了: ${err.message}`)
  results.push({ name: '跑通', ok: false, message: err.message })
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
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* Windows 偶尔删不掉 */
  }
}

console.log('\n== 结果 ==')
const failed = results.filter((item) => !item.ok)
console.log(`  ${results.length - failed.length}/${results.length} 通过`)
for (const item of failed) console.log(`  \u2717 ${item.name}: ${item.message}`)
process.exit(failed.length === 0 ? 0 : 1)