#!/usr/bin/env node
/**
 * §7.1 面板 #2「请求详情」的发起链（initiator 调用栈）验收。
 *
 * 判据不是「有个字段」，而是**能让它指向一个我们认识的函数**：
 *   1) 页面里跑一个名字独特的函数，由它发起 fetch —— 落库的调用栈第一帧必须就是这个名字，
 *      函数名对不上就说明栈抓错了（抓到别人的、或者只存了个空壳）；
 *   2) initiator_type 要按 CDP 的分类落下来（页面脚本发起 = script），
 *      并且**过滤条件真的能用它筛**（script 查得到、parser 查不到它）；
 *   3) 页面上其它 XHR 的帧里必须带 URL —— 只证明「有栈」不够，还得证明「栈里有位置」；
 *   4) 直接开库看列：initiator_stack 是合法 JSON、initiator_type 非空（落盘这一环不能只是内存里好看）；
 *   5) 面板 UI 路径也走一遍：自动选中那条请求 →「发起链」tab → 屏幕上真的出现那个函数名。
 *
 *   node scripts/test-detail.mjs
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startOrigin } from './test-origin.mjs'
import { launchApp, makeChecker, sleep } from './app-harness.mjs'

const CDP_PORT = Number(process.env['DETAIL_CDP_PORT'] ?? 9487)
const SHOT_DIR = process.env['DETAIL_SHOT_DIR'] ?? null
/** 认这条请求用的独特标记。URL 里有它，函数名里也有它 */
const PROBE = 'initiator-probe'
const PROBE_FN = 'probeInitiatorFetch'

const { check, assert, report } = makeChecker()

const dataDir = mkdtempSync(join(tmpdir(), 'monitor-detail-'))
if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true })
const origin = await startOrigin(0)
const url = `http://127.0.0.1:${origin.port}/`
const dbPath = join(dataDir, 'monitor.db')
console.log(`受控页面: ${url}`)
console.log(`数据目录: ${dataDir}\n`)

/** 在控制窗口里跑一段用得到 api 的异步代码 */
const runOn = (app, body) => app.evaluate(`(async () => { const api = window.monitor; ${body} })()`)

/** 直接开库取一条请求的原始列。绕过存储进程看真实落盘结果 */
function rawRow(seq) {
  const db = new DatabaseSync(dbPath)
  try {
    return db.prepare('SELECT initiator_type, initiator_stack FROM requests WHERE seq = ?').get(seq)
  } finally {
    db.close()
  }
}

let app = null
try {
  app = await launchApp({
    url,
    dataDir,
    port: CDP_PORT,
    tab: 'list',
    shotDir: SHOT_DIR,
    // 面板开局按 URL 子串自动选中 —— 那条请求要等我们下面自己去发
    extraEnv: { MONITOR_UI_SELECT: PROBE }
  })
  await app.waitConnected(1)

  /* ------------------------------------------- 页面里发一个「有名字」的请求 */

  console.log('== 采集：函数名能不能对上 ==')
  const fired = await runOn(
    app,
    `return await api.evaluate("(async () => { window.__initiatorProbe = async function ${PROBE_FN}(){ const r = await fetch('/api/perf-report?from=${PROBE}'); return r.status }; return await window.__initiatorProbe() })()")`
  )
  check('页面侧真的发出了这条请求（evaluate 拿到状态码）', () => {
    assert(fired?.ok !== false, `evaluate 失败：${JSON.stringify(fired).slice(0, 200)}`)
    assert(fired?.value === 200, `状态码=${JSON.stringify(fired?.value)}`)
  })

  // 等它入库（采集是异步的）
  let probe = null
  for (let i = 0; i < 60 && !probe; i++) {
    const page = await runOn(app, `return await api.queryRequests({ search: '${PROBE}' }, 10, 0, 'time_desc')`)
    probe = page?.rows?.find((row) => row.url.includes(PROBE)) ?? null
    if (!probe) await sleep(250)
  }

  check('列表里能按 URL 找到它，且 initiator_type 是 script', () => {
    assert(probe, `库里没有 ${PROBE} 这条请求`)
    assert(probe.initiator_type === 'script', `initiator_type=${probe.initiator_type}`)
    assert(probe.method === 'GET', `method=${probe.method}`)
  })

  assert(probe, `没等到 ${PROBE} 这条请求入库（页面发了但采集没跟上）`)
  const detail = await runOn(app, `return await api.getDetail(${probe.seq})`)
  const initiator = detail?.request?.initiator_stack ? JSON.parse(detail.request.initiator_stack) : null

  check('详情里的调用栈第一帧就是我们那个函数（名字逐字一致）', () => {
    assert(initiator, `详情没有 initiator_stack：${JSON.stringify(detail?.request ?? {}).slice(0, 200)}`)
    assert(initiator.type === 'script', `initiator.type=${initiator.type}`)
    assert(Array.isArray(initiator.frames) && initiator.frames.length >= 1, `帧数=${initiator.frames?.length}`)
    const top = initiator.frames[0]
    assert(top.functionName === PROBE_FN, `第一帧函数名=${top.functionName}（期望 ${PROBE_FN}）`)
    console.log(`      栈：${initiator.frames.slice(0, 4).map((f) => f.functionName).join(' ← ')}`)
  })

  check('调用栈里带位置信息（行号/列号是数字，不是占位）', () => {
    const top = initiator.frames[0]
    assert(Number.isInteger(top.lineNumber) && top.lineNumber >= 0, `lineNumber=${top.lineNumber}`)
    assert(Number.isInteger(top.columnNumber) && top.columnNumber >= 0, `columnNumber=${top.columnNumber}`)
  })

  // 页面上那些 XHR 的帧里必须有 URL —— 证明我们不是只存了个空壳
  const pageScripted = await runOn(app, `return await api.queryRequests({ initiatorType: 'script' }, 5, 0, 'time_desc')`)
  let frameWithUrl = null
  for (const row of pageScripted?.rows ?? []) {
    const item = await runOn(app, `return await api.getDetail(${row.seq})`)
    const info = item?.request?.initiator_stack ? JSON.parse(item.request.initiator_stack) : null
    const hit = info?.frames?.find((frame) => frame.url)
    if (hit) {
      frameWithUrl = { seq: row.seq, url: hit.url, fn: hit.functionName, line: hit.lineNumber }
      break
    }
  }
  check('页面自己发起的请求，栈帧里带着脚本 URL 与位置', () => {
    assert(frameWithUrl, '翻了 5 条 script 发起的请求，没有一帧带 URL')
    console.log(`      seq ${frameWithUrl.seq} → ${frameWithUrl.fn || '(anonymous)'} @ ${frameWithUrl.url}:${frameWithUrl.line}`)
  })

  /* ------------------------------------------------------------ 落盘与过滤 */

  console.log('\n== 落盘与过滤 ==')
  const raw = rawRow(probe.seq)
  check('数据库里这一列真的写进去了（合法 JSON + 类型非空）', () => {
    assert(raw, `库里没有 seq=${probe.seq}`)
    assert(raw.initiator_type === 'script', `落盘的 initiator_type=${raw.initiator_type}`)
    const parsed = JSON.parse(raw.initiator_stack)
    assert(parsed.frames?.length >= 1, `落盘的帧数=${parsed.frames?.length}`)
    assert(parsed.frames[0].functionName === PROBE_FN, `落盘的第一帧=${parsed.frames[0].functionName}`)
  })

  const byScript = await runOn(app, `return await api.queryRequests({ initiatorType: 'script' }, 500, 0, 'time_desc')`)
  const byParser = await runOn(app, `return await api.queryRequests({ initiatorType: 'parser' }, 500, 0, 'time_desc')`)
  check('按 initiatorType 过滤真的生效（script 查得到、parser 查不到它）', () => {
    const inScript = (byScript?.rows ?? []).some((row) => row.seq === probe.seq)
    const inParser = (byParser?.rows ?? []).some((row) => row.seq === probe.seq)
    assert(inScript, 'script 过滤里没有这条请求')
    assert(!inParser, 'parser 过滤里居然有这条请求（fetch 不是解析器发起的）')
    assert(byScript.total > 0, 'script 这条过滤一条都没有，过滤可能整个失效了')
  })

  /* ------------------------------------------------------------ 面板 UI */

  console.log('\n== 面板（UI 路径）==')
  const ui = await app.evaluate(`(async () => {
    const frame = () => new Promise((r) => setTimeout(r, 60))
    let text = ''
    for (let i = 0; i < 120; i++) {
      await frame()
      const detail = document.querySelector('.detail')
      if (detail && detail.innerText.includes('/api/perf-report')) break
    }
    const tab = Array.from(document.querySelectorAll('.detail .tab')).find((b) => b.textContent.includes('发起链'))
    if (!tab) return { ok: false, reason: '详情面板里没有「发起链」tab', tabs: Array.from(document.querySelectorAll('.detail .tab')).map((b) => b.textContent) }
    tab.click()
    for (let i = 0; i < 60; i++) {
      await frame()
      const box = document.querySelector('.detail .initiator')
      text = box ? box.innerText : ''
      if (text.includes('发起类型')) break
    }
    return {
      ok: text.includes('发起类型'),
      text: text.replace(/\\s+/g, ' ').slice(0, 400),
      frames: document.querySelectorAll('.detail .initiator-frames li').length,
      hasFn: text.includes('${PROBE_FN}')
    }
  })()`)
  await app.shot('detail-initiator.png')
  check('面板：自动选中那条请求，「发起链」tab 里能看到函数名与类型', () => {
    assert(ui.ok, `UI 没出来：${JSON.stringify(ui).slice(0, 300)}`)
    assert(ui.hasFn, `面板文字里没有 ${PROBE_FN}：${ui.text}`)
    assert(ui.frames >= 1, `面板里帧数=${ui.frames}`)
    console.log('      ' + ui.text.slice(0, 200))
  })
} catch (err) {
  console.log(`\n验收中断：${err.message}`)
  results.push({ name: '主流程', ok: false, message: err.message })
} finally {
  try {
    await app?.close()
  } catch {
    /* 已经退了 */
  }
  try {
    origin.close()
  } catch {
    /* 已经关了 */
  }
  await sleep(500)
  if (process.env['DETAIL_KEEP'] !== '1') {
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch {
      /* Windows 上偶尔删不掉 */
    }
  }
}

const ok = report()
process.exit(ok ? 0 : 1)