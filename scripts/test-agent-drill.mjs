#!/usr/bin/env node
/**
 * 「agent 真的能拿它干活吗」—— 纯 MCP 的端到端演练。
 *
 * 整场演练**只走 `mcp/server.mjs` 的 stdio JSON-RPC**：不 import 本项目任何内部模块、
 * 不走主进程 IPC、不直接连调试端口。也就是说，这里跑的每一步，外部 agent 都能跑。
 *
 * 演练的是一次真实排查：
 *   探路（状态/能力/工具清单）→ 查请求 → 拉详情与 body → 读脚本与控制台 →
 *   看 DOM → 截图 → 模拟点击 → 写规则拦截 → 让页面重载 → 验证拦截生效 →
 *   跑探针 → 看会话 → 切 Profile（H 上验证 evaluate 被拒，再切回）→ 收尾清理。
 *
 * 判据都落在「页面侧/库里的真值」上，不是「调用没报错」：
 *   - evaluate 读到的标题必须等于受控页的标题；
 *   - 拦掉的那条 XHR 必须真的不再 200；
 *   - 截图的字节数必须和落盘文件一致（MCP 的 image 块确实是那张图）。
 *
 *   node scripts/test-agent-drill.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startOrigin } from './test-origin.mjs'
import { McpClient } from './mcp-client.mjs'
import { makeChecker, sleep } from './app-harness.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const MCP = join(ROOT, 'mcp', 'server.mjs')
const CDP_PORT = Number(process.env['DRILL_CDP_PORT'] ?? 9488)
const API_PORT = Number(process.env['DRILL_API_PORT'] ?? 9495)
const DATA_DIR = process.env['DRILL_DATA_DIR'] ?? join(ROOT, `.userdata/drill-${Date.now()}`)

const { check, assert, results, report } = makeChecker()

/** 工具调用流水：记下来才能说清「这一趟 agent 到底调了多少次」 */
const calls = []
let mcp = null
async function call(name, args) {
  calls.push(name)
  return mcp.callJson(name, args)
}

console.log('== agent 演练（纯 MCP，stdio） ==')
mkdirSync(DATA_DIR, { recursive: true })
const origin = await startOrigin(0)
const PAGE = `http://127.0.0.1:${origin.port}/`
console.log(`受控页面: ${PAGE}\n数据目录: ${DATA_DIR}\n`)

/** 起一个应用实例。抽成函数是为了后面能真的重启一次（agent 侧不能因此失联） */
function launchApp() {
  const child = spawn(
    ELECTRON,
    ['out/main/index.js', '--no-sandbox', `--remote-debugging-port=${CDP_PORT}`],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        MONITOR_DATA_DIR: DATA_DIR,
        MONITOR_URL: PAGE,
        MONITOR_PROFILE: 'L',
        MONITOR_UI_TAB: 'list',
        MONITOR_AUTO_QUIT_MS: '0',
        MONITOR_API_PORT: String(API_PORT),
        MONITOR_CAPTURE_BODIES: '1',
        MONITOR_CAPTURE_SCRIPTS: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }
  )
  child.stdout.on('data', (chunk) => (appLog += String(chunk)))
  child.stderr.on('data', (chunk) => (appLog += String(chunk)))
  return child
}

let appLog = ''
let app = launchApp()

try {
  /* ------------------------------------------------ 0. agent 的接入方式 */

  console.log('== 探路 ==')
  // 发现端点：读应用写在数据目录里的 control.json（真 agent 也是这么找的）
  const infoPath = join(DATA_DIR, 'control.json')
  let info = null
  for (let i = 0; i < 120 && !info; i++) {
    await sleep(500)
    if (!existsSync(infoPath)) continue
    try {
      const parsed = JSON.parse(readFileSync(infoPath, 'utf8'))
      if (parsed?.port && parsed?.token) info = parsed
    } catch {
      /* 还没写完 */
    }
  }
  check('从 control.json 发现控制服务（agent 的发现路径）', () => {
    assert(info, `没等到 ${infoPath}`)
    assert(info.host === '127.0.0.1', `host=${info.host}`)
  })

  // MCP server 只给它数据目录 —— 地址与 token 由它自己去读，和 agent 的处境一样
  mcp = McpClient.spawn(process.execPath, [MCP, `--data-dir=${DATA_DIR}`], { cwd: ROOT })
  const init = await mcp.initialize('agent-drill')
  check('MCP 握手成功，server 自报家门', () => {
    assert(init?.serverInfo?.name === 'chromium-monitor', `serverInfo=${JSON.stringify(init?.serverInfo)}`)
    assert(init?.capabilities?.tools, '没有声明 tools 能力')
  })

  const list = await mcp.send('tools/list', {})
  const names = (list?.tools ?? []).map((tool) => tool.name)
  check('工具清单完整（每个都有 description 与 inputSchema）', () => {
    assert(names.length >= 25, `只有 ${names.length} 个工具：${names.join(',')}`)
    for (const tool of list.tools) {
      assert(typeof tool.description === 'string' && tool.description.length > 10, `${tool.name} 没有 description`)
      assert(tool.inputSchema?.type === 'object', `${tool.name} 的 inputSchema 不对`)
    }
    console.log(`      ${names.length} 个工具：${names.join(' · ')}`)
  })

  let status = null
  for (let i = 0; i < 60; i++) {
    status = await call('monitor_status', {})
    if (status?.state === 'connected' && status?.requestCount > 0) break
    await sleep(500)
  }
  check('monitor_status：连上了，而且真的在采流量', () => {
    assert(status?.state === 'connected', `state=${status?.state}`)
    assert(status.requestCount > 0, `requestCount=${status.requestCount}`)
    assert(status.profile === 'L', `profile=${status.profile}`)
    assert(status.control?.enabled === true, 'control 没开')
  })

  const caps = await call('monitor_capabilities', {})
  check('monitor_capabilities：能力矩阵能读到（截图 / DOM / 输入都在）', () => {
    assert(caps?.runtime === true, `runtime=${caps?.runtime}`)
    assert(caps?.screenshot === true, `screenshot=${caps?.screenshot}`)
    assert(caps?.dom === 'full', `dom=${caps?.dom}`)
  })

  /* ------------------------------------------------ 1. 查这条流量 */

  console.log('\n== 查流量 ==')
  const xhrs = await call('monitor_requests', { resourceType: 'XHR', limit: 20, order: 'time_desc' })
  check('monitor_requests：按资源类型过滤查得到 XHR', () => {
    assert(xhrs?.rows?.length > 0, `total=${xhrs?.total}`)
    assert(xhrs.total >= xhrs.rows.length, 'total 比 rows 还小')
    console.log(`      ${xhrs.total} 条 XHR，最新一条 ${xhrs.rows[0].url}`)
  })

  const target = xhrs.rows.find((row) => row.url.includes('/api/xhr-get')) ?? xhrs.rows[0]
  const detail = await call('monitor_request', { seq: target.seq })
  check('monitor_request：拿到详情（头 / 时序 / 发起链都在）', () => {
    assert(detail?.request?.seq === target.seq, `seq 对不上：${detail?.request?.seq}`)
    assert(detail.request.url === target.url, 'URL 与列表里那条对不上')
    assert(typeof detail.request.req_headers === 'string' && detail.request.req_headers.length > 0, '没有请求头')
    assert(detail.request.initiator_type, '详情里没有 initiator_type')
  })

  // body：拿一条有 body_hash 的请求，用 monitor_body 按 hash 取正文
  const withBody = (await call('monitor_requests', { urlPattern: '/api/xhr-get', limit: 5 })).rows[0]
  const body = await call('monitor_body', { hash: withBody.body_hash ?? detail.request.body_hash, withData: true })
  check('monitor_body：按 hash 取到响应体正文', () => {
    assert(body, '没有返回')
    assert(body.size > 0, `size=${body.size}`)
    assert(body.stored === true, `stored=${body.stored}`)
    assert((body.b64 ?? '').length > 0 || body.text !== undefined, '既没有 b64 也没有 text')
  })

  const live = await call('monitor_fetch_body', { seq: withBody.seq })
  check('monitor_fetch_body：现捞接口可用（拿不到也如实报状态）', () => {
    assert(typeof live?.ok === 'boolean', `ok=${live?.ok}`)
    assert(typeof live?.state === 'string', `state=${live?.state}`)
    console.log(`      现捞结果：ok=${live.ok} state=${live.state}`)
  })

  const scripts = await call('monitor_scripts', { limit: 5 })
  check('monitor_scripts：脚本清单有内容', () => {
    assert(scripts?.rows?.length > 0, `total=${scripts?.total}`)
  })
  const source = await call('monitor_script_source', { hash: scripts.rows[0].hash })
  check('monitor_script_source：能取到源码', () => {
    assert(source?.source?.length > 0, `size=${source?.size}`)
  })

  const consoleRows = await call('monitor_console', {})
  check('monitor_console：控制台回流接口可用（可能是空的）', () => {
    assert(Array.isArray(consoleRows), `类型=${typeof consoleRows}`)
  })

  const title = await call('monitor_evaluate', { expression: 'document.title' })
  check('monitor_evaluate：求值拿到页面自己的标题（与受控页一致）', () => {
    assert(title?.ok !== false, `ok=${title?.ok} err=${title?.error}`)
    assert(title?.value === '监控容器验收页', `value=${JSON.stringify(title?.value)}`)
  })

  const timeline = await call('monitor_timeline', { limit: 20 })
  check('monitor_timeline：瀑布图数据可用', () => {
    assert(timeline?.length > 0, `rows=${timeline?.length}`)
  })

  /* ------------------------------------------------ 2. 看页面 */

  console.log('\n== 看页面 ==')
  const tree = await call('monitor_dom_tree', {})
  check('monitor_dom_tree：拿到真实 DOM 树', () => {
    const labels = (tree?.rows ?? []).map((row) => row.label).join(' ')
    assert(/html/.test(labels) && /body/.test(labels), `树里没有 html/body：${labels.slice(0, 120)}`)
  })

  const inspect = await call('monitor_dom_inspect', { selector: 'body' })
  check('monitor_dom_inspect：元素详情（outerHTML + 盒模型）', () => {
    assert(inspect?.ok !== false, `ok=${inspect?.ok} err=${inspect?.error}`)
    assert(inspect.outerHTML.includes('<body'), `outerHTML=${String(inspect.outerHTML).slice(0, 80)}`)
    assert(inspect.box, '没有盒模型')
  })

  const highlight = await call('monitor_dom_highlight', { nodeId: inspect.node?.nodeId, on: true })
  check('monitor_dom_highlight：页面高亮可用', () => {
    assert(highlight?.ok === true, `ok=${highlight?.ok} err=${highlight?.error}`)
  })

  const shot = await mcp.call('monitor_screenshot', { format: 'png' })
  const shotMeta = JSON.parse(shot.content.find((block) => block.type === 'text').text)
  const shotImage = shot.content.find((block) => block.type === 'image')
  check('monitor_screenshot：落盘 + 顺手带回 image 块（同一张图）', () => {
    assert(shotMeta.ok === true, `ok=${shotMeta.ok} err=${shotMeta.error}`)
    assert(existsSync(shotMeta.path), `文件不在：${shotMeta.path}`)
    assert(statSync(shotMeta.path).size === shotMeta.bytes, '落盘大小与元数据不一致')
    assert(shotImage, '没有 image 块')
    assert(Buffer.from(shotImage.data, 'base64').length === shotMeta.bytes, 'image 块与落盘不是同一张图')
    console.log(`      ${shotMeta.width}×${shotMeta.height} · ${shotMeta.bytes}B → ${shotMeta.path}`)
  })

  const clicked = await call('monitor_input', { kind: 'click', selector: 'body', seed: 5 })
  check('monitor_input：说「点 body」就能点（不需要坐标）', () => {
    assert(clicked?.ok === true, `ok=${clicked?.ok} err=${clicked?.error}`)
    assert(clicked.points > 1, `轨迹点=${clicked.points}`)
  })

  /* ------------------------------------------------ 3. 干预：拦一条请求 */

  console.log('\n== 干预：写规则并验证生效 ==')
  const saved = await call('monitor_rules_set', {
    rules: {
      version: 1,
      rules: [
        {
          id: 'drill-block-xhr',
          name: '演练：拦掉 /api/xhr-get',
          enabled: true,
          priority: 100,
          match: { urlPattern: '**/api/xhr-get*' },
          stage: 'request',
          action: { kind: 'block' }
        }
      ],
      fixtures: {},
      injections: []
    }
  })
  check('monitor_rules_set：规则写进去了（没有非法项）', () => {
    assert((saved?.invalid ?? []).length === 0, `invalid=${JSON.stringify(saved?.invalid)}`)
  })

  const readBack = await call('monitor_rules_get', {})
  check('monitor_rules_get：读回来就是刚写的那条', () => {
    const rule = (readBack?.rules ?? []).find((item) => item.id === 'drill-block-xhr')
    assert(rule, `规则集合里没有它：${(readBack?.rules ?? []).map((r) => r.id).join(',')}`)
    assert(rule.action?.kind === 'block', `action=${JSON.stringify(rule.action)}`)
  })

  const navigated = await call('monitor_navigate', { url: PAGE })
  check('monitor_navigate：页面真的重载了（拿到落地 URL 与标题）', () => {
    assert(navigated?.ok === true, `ok=${navigated?.ok} err=${navigated?.error}`)
    assert(navigated.url?.startsWith(PAGE), `落地 URL=${navigated.url}`)
    assert(navigated.title === '监控容器验收页', `title=${navigated.title}`)
  })

  // 重载后那条 XHR 再发一次 —— 这次必须被拦掉
  let blockedRow = null
  for (let i = 0; i < 40 && !blockedRow; i++) {
    await sleep(250)
    const rows = (await call('monitor_requests', { urlPattern: '/api/xhr-get', limit: 10 })).rows ?? []
    blockedRow = rows.find((row) => row.seq > target.seq && (row.failed || row.status === null)) ?? null
  }
  check('拦截真的生效：重载后那条 XHR 不再成功（failed 有值 / 没状态码）', () => {
    assert(blockedRow, '重载后没有找到被拦下的那条请求')
    console.log(`      seq ${blockedRow.seq} status=${blockedRow.status} failed=${blockedRow.failed}`)
  })

  const stats = await call('monitor_rules_stats', {})
  check('monitor_rules_stats：命中与拦截计数对得上', () => {
    assert(stats?.blocked >= 1, `blocked=${stats?.blocked}`)
    assert(stats?.matched >= 1, `matched=${stats?.matched}`)
  })

  /* ------------------------------------------------ 4. 自检与会话 */

  console.log('\n== 自检与会话 ==')
  const probe = await call('monitor_probe', {})
  check('monitor_probe：探针真的跑出了报告', () => {
    assert(probe?.ok === true, `ok=${probe?.ok} err=${probe?.error}`)
    assert(probe.report?.checks?.length > 0, '报告里没有检测项')
    console.log(
      `      pass ${probe.report.summary.pass} / warn ${probe.report.summary.warn} / fail ${probe.report.summary.fail}`
    )
  })

  // Profile L 开着 Runtime（console 采集与 evaluate 都要它），页面上量 console 耗时
  // 就能看出来 —— 探针**必须**报出来。报不出来说明探针失效，那才是真的坏消息。
  check('monitor_probe：L 下如实报出 Runtime 痕迹（检不出就是探针失效）', () => {
    const fails = (probe.report.checks ?? []).filter(
      (item) => item.status === 'fail' && item.group === 'CDP 痕迹'
    )
    assert(
      fails.length > 0,
      `L 下 Runtime.enable 明明开着，探针却零失败：${JSON.stringify(probe.report.summary)}`
    )
    console.log(
      '      检出: ' +
        fails.map((item) => `${item.label}=${JSON.stringify(item.value)}`).join(' / ')
    )
  })

  const sessions = await call('monitor_sessions', {})
  check('monitor_sessions：会话与存储分区看得到', () => {
    assert(sessions?.instances?.length >= 1, `instances=${sessions?.instances?.length}`)
    assert(sessions.instances.filter((item) => item.live).length === 1, 'live 实例不是唯一')
    assert(sessions.storage, '没有存储分区')
  })

  // 规则先清掉，免得切 Profile 之后还带着（规则是落盘文件，跨会话存续）
  const cleared = await call('monitor_rules_set', { rules: { version: 1, rules: [], fixtures: {}, injections: [] } })
  check('monitor_rules_set：能清空规则（写进去的能拿掉）', () => {
    assert((cleared?.invalid ?? []).length === 0, `invalid=${JSON.stringify(cleared?.invalid)}`)
  })

  /* ------------------------------------------------ 5. 切 Profile */

  console.log('\n== 切 Profile（收工重启） ==')
  const toH = await call('monitor_switch_profile', { profile: 'H' })
  check('monitor_switch_profile：切到 H 成功（真重启）', () => {
    assert(toH?.ok === true, `ok=${toH?.ok} err=${toH?.error}`)
    assert(toH.profile === 'H', `profile=${toH.profile}`)
  })

  let hStatus = null
  for (let i = 0; i < 60; i++) {
    hStatus = await call('monitor_status', {})
    if (hStatus?.state === 'connected' && hStatus?.profile === 'H') break
    await sleep(500)
  }
  const hCaps = await call('monitor_capabilities', {})
  check('H 起来后照样在采流量，而且能力矩阵跟着变', () => {
    assert(hStatus?.profile === 'H', `profile=${hStatus?.profile}`)
    assert(hCaps?.runtime === false, `H 下 runtime 应该是 false，实际 ${hCaps?.runtime}`)
    assert(hCaps?.dom === 'ondemand', `H 下 dom=${hCaps?.dom}`)
  })

  const hEval = await call('monitor_evaluate', { expression: '1+1' })
  check('H 下 evaluate 被明确拒绝（红线不是嘴上说的）', () => {
    assert(hEval?.ok === false, `ok=${hEval?.ok} value=${JSON.stringify(hEval?.value)}`)
    assert(/Runtime/.test(hEval.error ?? ''), `错误信息：${hEval.error}`)
  })

  const backL = await call('monitor_switch_profile', { profile: 'L' })
  check('再切回 L 也成功', () => {
    assert(backL?.ok === true, `ok=${backL?.ok} err=${backL?.error}`)
    assert(backL.profile === 'L', `profile=${backL.profile}`)
  })

  const cleared2 = await call('monitor_clear', {})
  check('monitor_clear：清采集缓冲可用', () => {
    assert(cleared2?.ok !== false, `回包=${JSON.stringify(cleared2).slice(0, 120)}`)
  })

  /* ------------------------------------------------ 6. 应用重启（agent 不能失联） */

  console.log('\n== 应用重启：同一个 MCP 连接要能自己接回来 ==')
  // 应用重启会换 port 与 token（control.json 重写）。MCP server 是长活进程，
  // 缓存的端点必然失效 —— 它必须自己重新发现，而不是让 agent 永久 401。
  app.kill()
  await sleep(1200)
  const whileDown = await mcp.call('monitor_status', {})
  check('应用不在时：MCP 如实报错，不假装成功', () => {
    assert(whileDown?.isError === true, `回包=${JSON.stringify(whileDown).slice(0, 160)}`)
  })

  app = launchApp()
  let recovered = null
  for (let i = 0; i < 90; i++) {
    await sleep(500)
    try {
      recovered = await call('monitor_status', {})
      if (recovered?.state === 'connected') break
    } catch {
      /* 还没起来，继续等 */
    }
  }
  check('应用重启后：同一个 MCP 连接自动重新发现端口/token，接着能用', () => {
    assert(recovered?.state === 'connected', `state=${recovered?.state}`)
    assert(recovered.profile === 'L', `profile=${recovered?.profile}`)
    assert(recovered.requestCount > 0, `requestCount=${recovered?.requestCount}`)
  })

  const afterRestart = await call('monitor_requests', { limit: 3 })
  check('重启后照常查得到流量（新实例的库）', () => {
    assert((afterRestart?.rows ?? []).length > 0, `total=${afterRestart?.total}`)
  })

  /* ------------------------------------------------ 7. 掉线后的健壮性 */

  console.log('\n== 出错也不能断连接 ==')
  const badTool = await mcp.call('no_such_tool', {})
  check('未知工具回 isError', () => {
    assert(badTool?.isError === true, JSON.stringify(badTool).slice(0, 120))
  })
  const badArgs = await mcp.call('monitor_request', { seq: 999999 })
  check('查不存在的 seq 不会把连接搞死', () => {
    assert(badArgs !== undefined, '没有回包')
  })
  const after = await mcp.send('tools/list', {})
  check('出错之后连接照常可用', () => {
    assert((after?.tools ?? []).length >= 25, `工具数=${(after?.tools ?? []).length}`)
  })

  console.log(`\n一趟演练共调用工具 ${calls.length} 次`)
} catch (err) {
  console.log(`\n演练中断：${err.message}`)
  results.push({ name: '主流程', ok: false, message: err.message })
} finally {
  try {
    mcp?.close()
  } catch {
    /* 已经退了 */
  }
  try {
    app.kill()
  } catch {
    /* 已经退了 */
  }
  try {
    origin.close()
  } catch {
    /* 已经关了 */
  }
  await sleep(1000)
  if (process.env['DRILL_KEEP'] !== '1') {
    try {
      rmSync(DATA_DIR, { recursive: true, force: true })
    } catch {
      /* Windows 上偶尔删不掉 */
    }
  }
}

const ok = report()
if (!ok && appLog) {
  console.log('\n应用日志尾部：')
  console.log(appLog.split('\n').slice(-25).join('\n'))
}
process.exit(ok ? 0 : 1)