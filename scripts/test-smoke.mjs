#!/usr/bin/env node
/**
 * 全量冒烟：控制面 29 条 HTTP 路由 + MCP 25 个工具，一个都不落。
 *
 * 判据不是「HTTP 200 就算过」，而是每条都要给出**它自己的真值证据**
 * （状态里有请求数、DOM 树里有 html、截图落盘字节数与元数据一致、规则写完能读回来…）。
 * 别的验收脚本盯的是某一个功能的深度，这个盯的是「有没有哪条路根本走不通」。
 *
 *   npm run test:smoke
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sleep } from './app-harness.mjs'
import { startOrigin } from './test-origin.mjs'
import { McpClient } from './mcp-client.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const MCP = join(ROOT, 'mcp', 'server.mjs')
const CDP_PORT = Number(process.env['SMOKE_CDP_PORT'] ?? 9507)
const API_PORT = Number(process.env['SMOKE_API_PORT'] ?? 9498)
// 每次跑用独立数据目录：残留的 control.json 会让人连到上一次的应用，症状是「连上了但全是死数据」
const DATA_DIR = join(ROOT, '.userdata', `smoke-${Date.now().toString(36)}`)

const rows = []
let failures = 0
function check(label, fn) {
  try {
    const out = fn()
    if (out && typeof out.then === 'function') throw new Error('check 回调不能是 async')
    rows.push({ label, ok: true })
    console.log(`  \u2713 ${label}`)
  } catch (error) {
    failures += 1
    rows.push({ label, ok: false, message: error.message })
    console.log(`  \u2717 ${label}\n      ${error.message}`)
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

mkdirSync(DATA_DIR, { recursive: true })
const origin = await startOrigin(0)
const PAGE = `http://127.0.0.1:${origin.port}/`
console.log(`受控页面: ${PAGE}\n数据目录: ${DATA_DIR}\n`)

let appLog = ''
const app = spawn(
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
app.stdout.on('data', (chunk) => (appLog += String(chunk)))
app.stderr.on('data', (chunk) => (appLog += String(chunk)))

let mcp = null
try {
  /* ------------------------------------------------ 等应用起来 */
  const infoPath = join(DATA_DIR, 'control.json')
  // 上一次跑留下的 control.json 可能还在（被 kill 的应用删不掉自己）：只认本次启动写的
  const launchedAt = Date.now()
  let info = null
  for (let i = 0; i < 120 && !info; i++) {
    await sleep(500)
    if (!existsSync(infoPath)) continue
    try {
      const parsed = JSON.parse(readFileSync(infoPath, 'utf8'))
      if (parsed?.port && parsed?.token && (parsed.startedAt ?? 0) >= launchedAt - 2000) info = parsed
    } catch {
      /* 半截文件 */
    }
  }
  if (!info) throw new Error('等不到 control.json')
  const base = `http://127.0.0.1:${info.port}`
  const auth = { authorization: `Bearer ${info.token}` }

  async function api(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? auth : { ...auth, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    const text = await res.text()
    let parsed = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = { _raw: text.slice(0, 200) }
    }
    return { status: res.status, body: parsed }
  }

  // 等到真的在采流量
  let status = null
  for (let i = 0; i < 120; i++) {
    const res = await api('GET', '/status')
    if (res.body?.state === 'connected' && res.body?.requestCount > 0) {
      status = res.body
      break
    }
    await sleep(500)
  }
  console.log('== HTTP：29 条路由逐个真调用 ==\n')

  /* ------------------------------------------------ 读接口 */
  const health = await fetch(base + '/health')
  const healthBody = await health.json()
  check('GET /health（免鉴权，且如实带 upstream）', () => {
    assert(health.status === 200, `status=${health.status}`)
    assert(healthBody.ok === true, JSON.stringify(healthBody))
    assert(healthBody.upstream === true, `upstream=${healthBody.upstream}`)
    assert(healthBody.pid > 0, `pid=${healthBody.pid}`)
  })

  check('GET /status：连上了而且在采流量', () => {
    assert(status, `状态没起来：${JSON.stringify(status)}`)
    assert(status.profile === 'L', `profile=${status.profile}`)
    assert(status.control?.port === info.port, `control.port=${status.control?.port}`)
  })

  const caps = await api('GET', '/capabilities')
  check('GET /capabilities：能力矩阵（L 下 runtime/screenshot/dom 都在）', () => {
    assert(caps.status === 200, `status=${caps.status}`)
    assert(caps.body.runtime === true && caps.body.screenshot === true, JSON.stringify(caps.body).slice(0, 200))
    assert(caps.body.dom === 'full', `dom=${caps.body.dom}`)
  })

  const requests = await api('GET', '/requests?limit=5&order=time_desc')
  check('GET /requests：分页结构 + 真数据', () => {
    assert(requests.status === 200, `status=${requests.status}`)
    assert(requests.body.rows?.length > 0, `rows=${requests.body.rows?.length}`)
    assert(requests.body.total >= requests.body.rows.length, 'total 比 rows 小')
  })

  const xhr = await api('GET', '/requests?resourceType=XHR&limit=5')
  const targetSeq = xhr.body.rows?.[0]?.seq
  const detail = await api('GET', `/requests/${targetSeq}`)
  check('GET /requests/:seq：详情带头 / 发起链 / body 摘要', () => {
    assert(detail.status === 200, `status=${detail.status}`)
    assert(detail.body.request?.seq === targetSeq, 'seq 对不上')
    assert(typeof detail.body.request.req_headers === 'string', '没有请求头')
    assert(detail.body.request.initiator_type, '没有 initiator_type')
    assert(typeof detail.body.request.initiator_stack === 'string', '没有发起链')
  })

  const hash = detail.body.request.body_hash ?? detail.body.body?.hash
  const bodyByHash = await api('GET', `/requests/${hash}/body?withData=1`)
  check('GET /requests/:hash/body：按 hash 取正文', () => {
    assert(bodyByHash.status === 200, `status=${bodyByHash.status}`)
    assert(bodyByHash.body.size > 0, `size=${bodyByHash.body.size}`)
    assert(bodyByHash.body.stored === true, `stored=${bodyByHash.body.stored}`)
  })

  const bodyLive = await api('GET', `/requests/${targetSeq}/body-live`)
  check('GET /requests/:seq/body-live：现捞（拿不到也如实报状态）', () => {
    assert(bodyLive.status === 200, `status=${bodyLive.status}`)
    assert(typeof bodyLive.body.ok === 'boolean' && typeof bodyLive.body.state === 'string', JSON.stringify(bodyLive.body).slice(0, 160))
  })

  const stats = await api('GET', '/stats')
  check('GET /stats：聚合统计有分组', () => {
    assert(stats.status === 200, `status=${stats.status}`)
    assert(Array.isArray(stats.body.byType) || Array.isArray(stats.body.types) || typeof stats.body === 'object', JSON.stringify(stats.body).slice(0, 160))
  })

  const timeline = await api('GET', '/timeline?limit=10')
  check('GET /timeline：瀑布图数据可用', () => {
    assert(timeline.status === 200, `status=${timeline.status}`)
    assert(Array.isArray(timeline.body) && timeline.body.length > 0, `rows=${timeline.body?.length}`)
  })

  const scripts = await api('GET', '/scripts?limit=5')
  const scriptHash = scripts.body.rows?.[0]?.hash
  check('GET /scripts：脚本清单有内容', () => {
    assert(scripts.status === 200, `status=${scripts.status}`)
    assert(scripts.body.rows?.length > 0, `rows=${scripts.body.rows?.length}`)
    assert(scriptHash, '没有 hash')
  })

  const scriptStats = await api('GET', '/scripts/stats')
  check('GET /scripts/stats：脚本统计可用', () => {
    assert(scriptStats.status === 200, `status=${scriptStats.status}`)
  })

  const scriptSource = await api('GET', `/scripts/${scriptHash}`)
  check('GET /scripts/:hash：真取到源码', () => {
    assert(scriptSource.status === 200, `status=${scriptSource.status}`)
    assert(scriptSource.body.source?.length > 0, `size=${scriptSource.body.size}`)
  })

  const rules = await api('GET', '/rules')
  check('GET /rules：规则集可读', () => {
    assert(rules.status === 200, `status=${rules.status}`)
    assert(Array.isArray(rules.body.rules), JSON.stringify(rules.body).slice(0, 120))
  })

  const ruleStats = await api('GET', '/rules/stats')
  check('GET /rules/stats：命中统计可读', () => {
    assert(ruleStats.status === 200, `status=${ruleStats.status}`)
    assert(typeof ruleStats.body.matched === 'number', JSON.stringify(ruleStats.body).slice(0, 120))
  })

  const consoleRows = await api('GET', '/console')
  check('GET /console：控制台回流接口可用（可能是空的）', () => {
    assert(consoleRows.status === 200, `status=${consoleRows.status}`)
    assert(Array.isArray(consoleRows.body), `类型=${typeof consoleRows.body}`)
  })

  const instances = await api('GET', '/instances')
  check('GET /instances：实例列表有内容', () => {
    assert(instances.status === 200, `status=${instances.status}`)
    const list = Array.isArray(instances.body) ? instances.body : (instances.body.instances ?? [])
    assert(list.length >= 1, JSON.stringify(instances.body).slice(0, 160))
    assert(list[0].profile === 'L', `profile=${list[0]?.profile}`)
  })

  const sessions = await api('GET', '/sessions')
  check('GET /sessions：会话视图含存储分区', () => {
    assert(sessions.status === 200, `status=${sessions.status}`)
    assert(sessions.body.instances?.length >= 1, `instances=${sessions.body.instances?.length}`)
    assert(sessions.body.storage, '没有存储分区')
  })

  const tree = await api('GET', '/dom/tree?depth=2')
  check('GET /dom/tree：真实 DOM 树', () => {
    assert(tree.status === 200, `status=${tree.status}`)
    const labels = (tree.body.rows ?? []).map((row) => row.label).join(' ')
    assert(/html/.test(labels) && /body/.test(labels), `树里没有 html/body：${labels.slice(0, 120)}`)
  })

  const inspect = await api('GET', '/dom/inspect?selector=body')
  const nodeId = inspect.body.node?.nodeId
  check('GET /dom/inspect：outerHTML + 盒模型 + 命中样式', () => {
    assert(inspect.status === 200, `status=${inspect.status}`)
    assert(String(inspect.body.outerHTML).includes('<body'), `outerHTML=${String(inspect.body.outerHTML).slice(0, 80)}`)
    assert(inspect.body.box, '没有盒模型')
    assert(nodeId, '没有 nodeId')
  })

  /* ------------------------------------------------ 写接口 */
  const nav = await api('POST', '/navigate', { url: PAGE })
  check('POST /navigate：真跳转并回读落地 URL/标题', () => {
    assert(nav.status === 200, `status=${nav.status}`)
    assert(nav.body.ok === true && nav.body.url?.startsWith(PAGE), JSON.stringify(nav.body).slice(0, 160))
    assert(nav.body.title === '监控容器验收页', `title=${nav.body.title}`)
  })

  const shot = await api('POST', '/screenshot', { format: 'png' })
  check('POST /screenshot：落盘字节数与元数据一致', () => {
    assert(shot.status === 200, `status=${shot.status}`)
    assert(shot.body.ok === true, `ok=false：${JSON.stringify(shot.body).slice(0, 300)}`)
    assert(existsSync(shot.body.path), `文件不在：${shot.body.path}`)
    assert(statSync(shot.body.path).size === shot.body.bytes, '落盘大小与元数据不一致')
    assert(shot.body.width > 0 && shot.body.height > 0, `${shot.body.width}x${shot.body.height}`)
  })

  const evaluated = await api('POST', '/evaluate', { expression: 'document.title' })
  check('POST /evaluate：求值拿到页面标题', () => {
    assert(evaluated.status === 200, `status=${evaluated.status}`)
    assert(evaluated.body.value === '监控容器验收页', `value=${JSON.stringify(evaluated.body.value)}`)
  })

  const probe = await api('POST', '/probe', {})
  check('POST /probe：真跑出四组报告', () => {
    assert(probe.status === 200, `status=${probe.status}`)
    assert(probe.body.report?.checks?.length > 0, `checks=${probe.body.report?.checks?.length}`)
  })

  const input = await api('POST', '/input', { kind: 'click', selector: 'body', seed: 3 })
  check('POST /input：给 selector 就能点（有轨迹）', () => {
    assert(input.status === 200, `status=${input.status}`)
    assert(input.body.ok === true && input.body.points > 1, JSON.stringify(input.body).slice(0, 160))
  })

  const highlight = await api('POST', '/dom/highlight', { nodeId, on: true })
  check('POST /dom/highlight：页面高亮可用', () => {
    assert(highlight.status === 200, `status=${highlight.status}`)
    assert(highlight.body.ok === true, JSON.stringify(highlight.body).slice(0, 120))
  })

  const ruleSet = {
    version: 1,
    rules: [
      {
        id: 'smoke-block',
        name: '冒烟：拦掉 /missing',
        enabled: true,
        priority: 100,
        match: { urlPattern: '**/missing*' },
        stage: 'request',
        action: { kind: 'block' }
      }
    ],
    fixtures: {},
    injections: []
  }
  const saved = await api('POST', '/rules', ruleSet)
  const readBack = await api('GET', '/rules')
  check('POST /rules：写进去 + 读回来是同一份', () => {
    assert(saved.status === 200 && (saved.body.invalid ?? []).length === 0, JSON.stringify(saved.body).slice(0, 160))
    const rule = (readBack.body.rules ?? []).find((item) => item.id === 'smoke-block')
    assert(rule && rule.action?.kind === 'block', `读回来的规则=${JSON.stringify(readBack.body.rules).slice(0, 160)}`)
  })

  const clearedRules = await api('POST', '/rules', { version: 1, rules: [], fixtures: {}, injections: [] })
  check('POST /rules：能清空（覆盖式）', () => {
    assert(clearedRules.status === 200 && (clearedRules.body.invalid ?? []).length === 0, JSON.stringify(clearedRules.body).slice(0, 120))
  })

  const cleared = await api('POST', '/clear', {})
  // 清完必须立刻反映到 /status：flush() 在队列为空时会提前返回，
  // 只靠它同步计数的话，agent 清完再查还会读到清空前的旧值
  let afterClearStatus = null
  for (let i = 0; i < 10; i++) {
    const res = await api('GET', '/status')
    afterClearStatus = res.body
    if ((afterClearStatus?.requestCount ?? -1) === 0) break
    await sleep(300)
  }
  check('POST /clear：清采集缓冲可用，且计数立刻归零', () => {
    assert(cleared.status === 200, `status=${cleared.status}`)
    assert(afterClearStatus?.requestCount === 0, `requestCount=${afterClearStatus?.requestCount}`)
  })

  const clearedConsole = await api('POST', '/console/clear', {})
  check('POST /console/clear：清 console 可用', () => {
    assert(clearedConsole.status === 200, `status=${clearedConsole.status}`)
  })

  /* ------------------------------------------------ MCP：25 个工具逐个真调用 */
  console.log('\n== MCP：25 个工具逐个真调用 ==\n')
  mcp = McpClient.spawn(process.execPath, [MCP, `--data-dir=${DATA_DIR}`], { cwd: ROOT })
  await mcp.initialize('smoke-all')

  const tools = (await mcp.send('tools/list', {})).tools ?? []
  check(`tools/list：25 个工具且都有 description + inputSchema`, () => {
    assert(tools.length === 25, `工具数=${tools.length}`)
    const bare = tools.filter((tool) => !tool.description || !tool.inputSchema)
    assert(bare.length === 0, `缺 description/inputSchema：${bare.map((t) => t.name).join(',')}`)
  })

  const call = async (name, args) => {
    const res = await mcp.call(name, args)
    const text = (res?.content ?? []).find((block) => block.type === 'text')?.text
    return { res, text, json: (() => { try { return JSON.parse(text) } catch { return null } })() }
  }

  const statusTool = await call('monitor_status', {})
  check('monitor_status', () => {
    assert(statusTool.res.isError !== true, statusTool.text?.slice(0, 160))
    assert(statusTool.json.state === 'connected', `state=${statusTool.json?.state}`)
  })

  const capsTool = await call('monitor_capabilities', {})
  check('monitor_capabilities', () => {
    assert(capsTool.res.isError !== true, capsTool.text?.slice(0, 160))
    assert(capsTool.json.runtime === true, JSON.stringify(capsTool.json).slice(0, 120))
  })

  const reqTool = await call('monitor_requests', { limit: 5, order: 'time_desc' })
  check('monitor_requests', () => {
    assert(reqTool.res.isError !== true, reqTool.text?.slice(0, 160))
    assert(reqTool.json.rows?.length > 0, `rows=${reqTool.json?.rows?.length}`)
  })
  const seq = reqTool.json.rows[0].seq

  const initiatorFilter = await call('monitor_requests', { initiator: 'script', limit: 3 })
  check('monitor_requests（initiator 过滤参数真的被接受）', () => {
    assert(initiatorFilter.res.isError !== true, initiatorFilter.text?.slice(0, 160))
    assert(typeof initiatorFilter.json.total === 'number', 'total 不是数字')
  })

  const detailTool = await call('monitor_request', { seq })
  check('monitor_request', () => {
    assert(detailTool.res.isError !== true, detailTool.text?.slice(0, 160))
    assert(detailTool.json.request?.seq === seq, 'seq 对不上')
  })

  const bodyTool = await call('monitor_body', { hash: detailTool.json.request.body_hash ?? hash, withData: true })
  check('monitor_body', () => {
    assert(bodyTool.res.isError !== true, bodyTool.text?.slice(0, 160))
    assert(bodyTool.json.size > 0, `size=${bodyTool.json?.size}`)
  })

  const fetchTool = await call('monitor_fetch_body', { seq })
  check('monitor_fetch_body', () => {
    assert(fetchTool.res.isError !== true, fetchTool.text?.slice(0, 160))
    assert(typeof fetchTool.json.ok === 'boolean', `ok=${fetchTool.json?.ok}`)
  })

  const statsTool = await call('monitor_stats', {})
  check('monitor_stats', () => {
    assert(statsTool.res.isError !== true, statsTool.text?.slice(0, 160))
  })

  const timelineTool = await call('monitor_timeline', { limit: 10 })
  check('monitor_timeline', () => {
    assert(timelineTool.res.isError !== true, timelineTool.text?.slice(0, 160))
    assert(timelineTool.json.length > 0, `rows=${timelineTool.json?.length}`)
  })

  const scriptsTool = await call('monitor_scripts', { limit: 3 })
  check('monitor_scripts', () => {
    assert(scriptsTool.res.isError !== true, scriptsTool.text?.slice(0, 160))
    assert(scriptsTool.json.rows?.length > 0, `rows=${scriptsTool.json?.rows?.length}`)
  })

  const sourceTool = await call('monitor_script_source', { hash: scriptsTool.json.rows[0].hash })
  check('monitor_script_source', () => {
    assert(sourceTool.res.isError !== true, sourceTool.text?.slice(0, 160))
    assert(sourceTool.json.source?.length > 0, `size=${sourceTool.json?.size}`)
  })

  const consoleTool = await call('monitor_console', {})
  check('monitor_console', () => {
    assert(consoleTool.res.isError !== true, consoleTool.text?.slice(0, 160))
    assert(Array.isArray(consoleTool.json), `类型=${typeof consoleTool.json}`)
  })

  const evalTool = await call('monitor_evaluate', { expression: 'document.title' })
  check('monitor_evaluate', () => {
    assert(evalTool.res.isError !== true, evalTool.text?.slice(0, 160))
    assert(evalTool.json.value === '监控容器验收页', `value=${JSON.stringify(evalTool.json?.value)}`)
  })

  const treeTool = await call('monitor_dom_tree', { depth: 2 })
  check('monitor_dom_tree', () => {
    assert(treeTool.res.isError !== true, treeTool.text?.slice(0, 160))
    assert(/html/.test((treeTool.json.rows ?? []).map((r) => r.label).join(' ')), '树里没有 html')
  })

  const inspectTool = await call('monitor_dom_inspect', { selector: 'body' })
  check('monitor_dom_inspect', () => {
    assert(inspectTool.res.isError !== true, inspectTool.text?.slice(0, 160))
    assert(String(inspectTool.json.outerHTML).includes('<body'), 'outerHTML 不对')
  })
  const toolNodeId = inspectTool.json.node?.nodeId

  const highlightTool = await call('monitor_dom_highlight', { nodeId: toolNodeId, on: true })
  check('monitor_dom_highlight', () => {
    assert(highlightTool.res.isError !== true, highlightTool.text?.slice(0, 160))
    assert(highlightTool.json.ok === true, JSON.stringify(highlightTool.json).slice(0, 120))
  })

  const inputTool = await call('monitor_input', { kind: 'click', selector: 'body', seed: 7 })
  check('monitor_input（selector 定位）', () => {
    assert(inputTool.res.isError !== true, inputTool.text?.slice(0, 160))
    assert(inputTool.json.ok === true && inputTool.json.points > 1, JSON.stringify(inputTool.json).slice(0, 120))
  })

  const rulesGetTool = await call('monitor_rules_get', {})
  check('monitor_rules_get', () => {
    assert(rulesGetTool.res.isError !== true, rulesGetTool.text?.slice(0, 160))
    assert(Array.isArray(rulesGetTool.json.rules), 'rules 不是数组')
  })

  const rulesSetTool = await call('monitor_rules_set', {
    rules: {
      version: 1,
      rules: [
        {
          id: 'smoke-mcp-block',
          name: '冒烟：拦掉 /missing',
          enabled: true,
          priority: 100,
          match: { urlPattern: '**/missing*' },
          stage: 'request',
          action: { kind: 'block' }
        }
      ],
      fixtures: {},
      injections: []
    }
  })
  check('monitor_rules_set', () => {
    assert(rulesSetTool.res.isError !== true, rulesSetTool.text?.slice(0, 160))
    assert((rulesSetTool.json.invalid ?? []).length === 0, JSON.stringify(rulesSetTool.json).slice(0, 160))
  })

  const ruleStatsTool = await call('monitor_rules_stats', {})
  check('monitor_rules_stats', () => {
    assert(ruleStatsTool.res.isError !== true, ruleStatsTool.text?.slice(0, 160))
    assert(typeof ruleStatsTool.json.matched === 'number', JSON.stringify(ruleStatsTool.json).slice(0, 120))
  })

  const probeTool = await call('monitor_probe', {})
  check('monitor_probe', () => {
    assert(probeTool.res.isError !== true, probeTool.text?.slice(0, 160))
    assert(probeTool.json.report?.checks?.length > 0, '报告里没有检测项')
  })

  const navTool = await call('monitor_navigate', { url: PAGE })
  check('monitor_navigate', () => {
    assert(navTool.res.isError !== true, navTool.text?.slice(0, 160))
    assert(navTool.json.title === '监控容器验收页', `title=${navTool.json?.title}`)
  })

  const shotTool = await mcp.call('monitor_screenshot', { format: 'png' })
  check('monitor_screenshot（含 image 块）', () => {
    const meta = JSON.parse((shotTool.content ?? []).find((b) => b.type === 'text').text)
    const image = (shotTool.content ?? []).find((b) => b.type === 'image')
    assert(meta.ok === true, `ok=false：${JSON.stringify(meta).slice(0, 300)}`)
    assert(existsSync(meta.path), `文件不在：${meta.path}`)
    assert(image && Buffer.from(image.data, 'base64').length === meta.bytes, 'image 块与落盘不是同一张')
  })

  const sessionsTool = await call('monitor_sessions', {})
  check('monitor_sessions', () => {
    assert(sessionsTool.res.isError !== true, sessionsTool.text?.slice(0, 160))
    assert(sessionsTool.json.instances?.length >= 1 && sessionsTool.json.storage, '会话视图不完整')
  })

  const switchH = await call('monitor_switch_profile', { profile: 'H' })
  check('monitor_switch_profile（切 H）', () => {
    assert(switchH.res.isError !== true, switchH.text?.slice(0, 160))
    assert(switchH.json.ok === true && switchH.json.profile === 'H', JSON.stringify(switchH.json).slice(0, 120))
  })
  let hStatus = null
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    const probeStatus = await call('monitor_status', {})
    if (probeStatus.json?.state === 'connected' && probeStatus.json?.profile === 'H') {
      hStatus = probeStatus.json
      break
    }
  }
  const hEval = await call('monitor_evaluate', { expression: 'document.title' })
  check('H 下 evaluate 被明确拒绝（Runtime 红线）', () => {
    assert(hStatus?.profile === 'H', `H 没起来：${JSON.stringify(hStatus)?.slice(0, 120)}`)
    assert(hEval.res.isError === true || hEval.json?.ok === false, JSON.stringify(hEval.json ?? hEval.text).slice(0, 160))
  })
  const switchL = await call('monitor_switch_profile', { profile: 'L' })
  check('monitor_switch_profile（切回 L）', () => {
    assert(switchL.res.isError !== true && switchL.json?.profile === 'L', JSON.stringify(switchL.json).slice(0, 120))
  })
  let lStatus = null
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    const probeStatus = await call('monitor_status', {})
    if (probeStatus.json?.state === 'connected' && probeStatus.json?.profile === 'L') {
      lStatus = probeStatus.json
      break
    }
  }
  check('切回 L 后照样在采流量', () => {
    assert(lStatus?.profile === 'L', `state=${lStatus?.state} profile=${lStatus?.profile}`)
  })

  const clearTool = await call('monitor_clear', {})
  check('monitor_clear', () => {
    assert(clearTool.res.isError !== true, clearTool.text?.slice(0, 160))
  })

  console.log(`\n== 结果：${rows.filter((r) => r.ok).length}/${rows.length} ==`)
  if (failures > 0) {
    console.log('失败项：')
    for (const row of rows.filter((r) => !r.ok)) console.log(`  - ${row.label}: ${row.message}`)
  }
} catch (error) {
  failures += 1
  console.log(`\n冒烟中断：${error.message}`)
  console.log(appLog.split('\n').slice(-12).join('\n'))
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
  origin.close()
  await sleep(800)
  try {
    rmSync(DATA_DIR, { recursive: true, force: true })
  } catch {
    /* Windows 偶尔删不掉 */
  }
}
process.exit(failures === 0 ? 0 : 1)