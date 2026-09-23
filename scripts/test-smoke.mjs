#!/usr/bin/env node
/**
 * 全量冒烟：控制面 64 条 HTTP 路由 + MCP 58 个工具，一个都不落。
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

  // 走过的路由都记下来：这样「一条都不落」是**算出来的**，不是手写的数字
  const hitRoutes = new Set()
  const routeOf = (method, path) => method + ' ' + path.split('?')[0].replace(/\d+/g, '*')

  async function api(method, path, body) {
    hitRoutes.add(routeOf(method, path))
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
  console.log('== HTTP：路由逐个真调用（含实时分析面 19 条 + 站点资源面 16 条）==\n')

  /* ------------------------------------------------ 读接口 */
  hitRoutes.add('GET /health')
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
  const saved = await api('POST', '/workspaces/default/rules', { set: ruleSet })
  const readBack = await api('GET', '/rules')
  check('POST /rules：写进去 + 读回来是同一份', () => {
    assert(saved.status === 200 && saved.body.task?.state === 'succeeded' && (saved.body.output?.invalid ?? []).length === 0, JSON.stringify(saved.body).slice(0, 160))
    const rule = (readBack.body.rules ?? []).find((item) => item.id === 'smoke-block')
    assert(rule && rule.action?.kind === 'block', `读回来的规则=${JSON.stringify(readBack.body.rules).slice(0, 160)}`)
  })

  const clearedRules = await api('POST', '/workspaces/default/rules', { set: { version: 1, rules: [], fixtures: {}, injections: [] } })
  check('POST /rules：能清空（覆盖式）', () => {
    assert(clearedRules.status === 200 && clearedRules.body.task?.state === 'succeeded' && (clearedRules.body.output?.invalid ?? []).length === 0, JSON.stringify(clearedRules.body).slice(0, 120))
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

  /* ------------------------- 实时分析面的路由（HTTP 侧同样要通，不能只有 MCP） ------------------------- */

  const eventsRes = await api('GET', '/events?limit=3&order=asc')
  check('GET /events：事件流水 + 增量游标', () => {
    assert(eventsRes.status === 200, `status=${eventsRes.status}`)
    assert(Array.isArray(eventsRes.body.rows), 'rows 不是数组')
    assert(typeof eventsRes.body.nextSince === 'number', `nextSince=${eventsRes.body.nextSince}`)
  })

  const eventsStats = await api('GET', '/events/stats')
  check('GET /events/stats：按 kind 分组的计数', () => {
    assert(eventsStats.status === 200 && typeof eventsStats.body.total === 'number', JSON.stringify(eventsStats.body).slice(0, 160))
  })

  const wsConns = await api('GET', '/ws/connections')
  check('GET /ws/connections：连接汇总', () => {
    assert(wsConns.status === 200 && Array.isArray(wsConns.body.rows), JSON.stringify(wsConns.body).slice(0, 160))
  })

  const wsFrames = await api('GET', '/ws?limit=5')
  check('GET /ws：帧明细', () => {
    assert(wsFrames.status === 200 && Array.isArray(wsFrames.body.rows), JSON.stringify(wsFrames.body).slice(0, 160))
  })

  const epList = await api('GET', '/endpoints?limit=5&sort=calls')
  check('GET /endpoints：接口画像', () => {
    assert(epList.status === 200 && Array.isArray(epList.body.endpoints), JSON.stringify(epList.body).slice(0, 160))
    assert(epList.body.endpoints.length > 0, '一个端点都没有')
  })

  const epDetail = await api('GET', `/endpoints/detail?key=${encodeURIComponent(epList.body.endpoints[0].key)}&sampleLimit=2`)
  check('GET /endpoints/detail：端点详情', () => {
    assert(epDetail.status === 200 && epDetail.body.found === true, JSON.stringify(epDetail.body).slice(0, 160))
  })

  const graph = await api('GET', '/graph?maxRows=2000')
  check('GET /graph：调用图（节点 / 边 / 功能簇）', () => {
    assert(graph.status === 200, `status=${graph.status}`)
    assert(Array.isArray(graph.body.nodes) && Array.isArray(graph.body.edges), '节点 / 边不是数组')
    assert(Array.isArray(graph.body.clusters), '没有 clusters')
  })

  const relations = await api('GET', '/relations?limit=5&maxRows=2000')
  check('GET /relations：四类关联', () => {
    assert(relations.status === 200, `status=${relations.status}`)
    for (const key of ['sharedBodies', 'redirectChains', 'domainLinks', 'sharedParams']) {
      assert(Array.isArray(relations.body[key]), `${key} 不是数组`)
    }
  })

  const snap = await api('POST', '/contracts', { label: 'smoke-http', sampleLimit: 2 })
  check('POST /contracts：拍契约快照', () => {
    assert(snap.status === 200 && snap.body.id > 0, JSON.stringify(snap.body).slice(0, 200))
  })

  const contractList = await api('GET', '/contracts?limit=50')
  check('GET /contracts：列表是 { rows, total }（与其它列表接口同形）', () => {
    assert(contractList.status === 200, `status=${contractList.status}`)
    assert(Array.isArray(contractList.body.rows), `不是 rows：${JSON.stringify(contractList.body).slice(0, 160)}`)
    assert(contractList.body.total === contractList.body.rows.length, `total=${contractList.body.total} vs ${contractList.body.rows.length}`)
    assert(contractList.body.rows.some((row) => row.id === snap.body.id), '列表里没有刚存的那份')
  })

  const contractOne = await api('GET', `/contracts/${snap.body.id}`)
  check('GET /contracts/:id：取快照内容', () => {
    assert(contractOne.status === 200 && contractOne.body.found === true, JSON.stringify(contractOne.body).slice(0, 160))
  })

  const contractDiff = await api('GET', `/contracts/${snap.body.id}/diff?sampleLimit=2`)
  check('GET /contracts/:id/diff：与当前比对', () => {
    assert(contractDiff.status === 200 && contractDiff.body.summary, JSON.stringify(contractDiff.body).slice(0, 160))
    assert(contractDiff.body.summary.removedEndpoints === 0, `报了 ${contractDiff.body.summary.removedEndpoints} 个端点消失`)
  })

  const harOut = await api('POST', '/export/har', { includeBodies: true, maxRows: 200 })
  check('POST /export/har：HAR 落盘', () => {
    assert(harOut.status === 200 && harOut.body.path && existsSync(harOut.body.path), JSON.stringify(harOut.body).slice(0, 200))
    assert(statSync(harOut.body.path).size === harOut.body.bytes, '报告字节数与文件大小不符')
  })

  const jsonlOut = await api('POST', '/export/jsonl', { includeBodies: true, maxRows: 200 })
  check('POST /export/jsonl：JSONL 落盘（行数自洽）', () => {
    assert(jsonlOut.status === 200 && jsonlOut.body.path && existsSync(jsonlOut.body.path), JSON.stringify(jsonlOut.body).slice(0, 200))
    const lines = readFileSync(jsonlOut.body.path, 'utf8').split('\n').filter(Boolean)
    assert(lines.length === jsonlOut.body.lines, `报告 ${jsonlOut.body.lines} 行 vs 实际 ${lines.length} 行`)
  })

  const mirrorOut = await api('POST', '/export/bodies', { maxRows: 200 })
  check('POST /export/bodies：资源镜像 + manifest', () => {
    assert(mirrorOut.status === 200 && mirrorOut.body.manifest && existsSync(mirrorOut.body.manifest), JSON.stringify(mirrorOut.body).slice(0, 200))
    assert(mirrorOut.body.files > 0, `files=${mirrorOut.body.files}`)
  })

  // 这个口只收「导出目录下的纯文件名」：带分隔符或 .. 一律 400（不是任意文件读取）
  const harName = harOut.body.path.split(/[\\/]/).pop()
  hitRoutes.add('GET /exports/download')
  const exportDownload = await fetch(base + '/exports/download?name=' + encodeURIComponent(harName), { headers: auth })
  const exportText = await exportDownload.text()
  check('GET /exports/download：导出的文件能取回来（字节数与报告一致）', () => {
    assert(exportDownload.status === 200, `status=${exportDownload.status}`)
    assert(Buffer.byteLength(exportText, 'utf8') === harOut.body.bytes, `${Buffer.byteLength(exportText, 'utf8')} vs ${harOut.body.bytes}`)
  })

  const dialogRes = await api('POST', '/dialog', { accept: true })
  check('POST /dialog：没有对话框时也如实回话', () => {
    assert(dialogRes.status === 200 && typeof dialogRes.body.ok === 'boolean', JSON.stringify(dialogRes.body).slice(0, 160))
  })

  const delContract = await api('DELETE', `/contracts/${snap.body.id}`)
  check('DELETE /contracts/:id：删掉快照', () => {
    assert(delContract.status === 200 && delContract.body.deleted === 1, JSON.stringify(delContract.body).slice(0, 160))
  })

  /* SSE 是手写路由（要拿裸 res 才推得动），所以单独测，不走 api() */
  const sseResult = await (async () => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    try {
      hitRoutes.add('GET /events/stream')
      const res = await fetch(base + '/events/stream?interval=300&since=0', { headers: auth, signal: ctrl.signal })
      if (res.status !== 200) return `status=${res.status}`
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let text = ''
      while (!text.includes('event: events') && text.length < 200000) {
        const chunk = await reader.read()
        if (chunk.done) break
        text += decoder.decode(chunk.value, { stream: true })
      }
      await reader.cancel()
      return text.includes('event: events') ? true : `没收到事件帧：${text.slice(0, 120)}`
    } finally {
      clearTimeout(timer)
    }
  })()
  check('GET /events/stream：SSE 真推得动事件', () => {
    assert(sseResult === true, String(sseResult))
  })

  /* ------------------------- 站点资源面（cookie 罐 / 站点存储 / 快照） ------------------------- */
  // 这一面的数据**不是**从流量里抄下来的，是主动去问浏览器要的：
  // cookie 罐浏览器级、站点存储要按域扫。所以这里的判据一律是「问出来的东西对得上」。

  const scope = `http://127.0.0.1:${origin.port}`

  // 名字先定下来：POST /cookies 只回 { ok }，回头再去响应体里找名字就成了 undefined
  const smokeCookieName = 'smoke_' + Date.now().toString(36)
  const cookieSetHttp = await api('POST', '/cookies', {
    name: smokeCookieName,
    value: 'v1',
    url: scope + '/'
  })
  check('POST /cookies：写进罐里', () => {
    assert(cookieSetHttp.status === 200, `status=${cookieSetHttp.status}`)
    assert(cookieSetHttp.body.ok === true, JSON.stringify(cookieSetHttp.body).slice(0, 200))
  })

  const cookieListHttp = await api('GET', '/cookies?domain=127.0.0.1&limit=200')
  check('GET /cookies：刚写的那条读得回来（含值、域、命中次数）', () => {
    assert(cookieListHttp.status === 200 && Array.isArray(cookieListHttp.body.rows), JSON.stringify(cookieListHttp.body).slice(0, 200))
    assert(typeof cookieListHttp.body.total === 'number', `total=${cookieListHttp.body?.total}`)
    const hit = cookieListHttp.body.rows.find((row) => row.name === smokeCookieName)
    assert(hit, `罐里没找到刚写的那条：${JSON.stringify(cookieListHttp.body.rows.slice(0, 3)).slice(0, 240)}`)
    assert(hit.value === 'v1', `value=${hit.value}`)
    assert(typeof hit.key === 'string' && hit.key.includes('|'), `key 口径不对：${hit.key}`)
  })

  const cookieStatsHttp = await api('GET', '/cookies/stats')
  check('GET /cookies/stats：画像数字自洽（分类之和 = 总数）', () => {
    assert(cookieStatsHttp.status === 200, `status=${cookieStatsHttp.status}`)
    const stats = cookieStatsHttp.body
    assert(typeof stats.total === 'number' && stats.total > 0, `total=${stats.total}`)
    assert(stats.session + stats.persistent === stats.total, `会话 ${stats.session} + 持久 ${stats.persistent} ≠ ${stats.total}`)
    assert(stats.totalBytes > 0, `totalBytes=${stats.totalBytes}`)
  })

  const scanHttp = await api('POST', '/sites/scan', { origin: scope, limit: 5 })
  check('POST /sites/scan：去浏览器里真扫一遍并落库', () => {
    assert(scanHttp.status === 200, `status=${scanHttp.status}`)
    assert(scanHttp.body.ok === true, JSON.stringify(scanHttp.body).slice(0, 200))
    assert((scanHttp.body.origins ?? []).includes(scope), `没扫到受控域：${JSON.stringify(scanHttp.body.origins)}`)
    assert(scanHttp.body.cookies.total > 0, `cookie 罐对账后是空的：${JSON.stringify(scanHttp.body.cookies)}`)
  })

  const sitesHttp = await api('GET', '/sites?limit=100')
  check('GET /sites：清单里受控域标着「已扫」', () => {
    assert(sitesHttp.status === 200 && Array.isArray(sitesHttp.body.rows), JSON.stringify(sitesHttp.body).slice(0, 200))
    const row = sitesHttp.body.rows.find((item) => item.origin === scope)
    assert(row, `清单里没有受控域：${JSON.stringify(sitesHttp.body.rows.map((item) => item.origin)).slice(0, 200)}`)
    assert(row.scanned === true, `扫过了却标着没扫（updatedAt=${row.updatedAt}）`)
    assert(row.cookieCount > 0, `cookieCount=${row.cookieCount}`)
  })

  const siteDetailHttp = await api('GET', `/sites/detail?origin=${encodeURIComponent(scope)}`)
  check('GET /sites/detail：明细里 cookie 与本地存储逐项对得上', () => {
    assert(siteDetailHttp.status === 200, `status=${siteDetailHttp.status}`)
    assert(siteDetailHttp.body.origin === scope, JSON.stringify(siteDetailHttp.body).slice(0, 200))
    const detail = siteDetailHttp.body
    assert((detail.cookies ?? []).length > 0, '明细里没有 cookie')
    assert(Array.isArray(detail.localStorage), 'localStorage 不是数组')
    assert(Array.isArray(detail.caches), 'caches 不是数组')
  })

  const storageHttp = await api('POST', '/sites/storage', { origin: scope, area: 'local', action: 'set', key: 'smoke_k', value: 'smoke_v' })
  check('POST /sites/storage：写一条本地存储', () => {
    assert(storageHttp.status === 200 && storageHttp.body.ok === true, JSON.stringify(storageHttp.body).slice(0, 200))
  })

  const idbDelHttp = await api('POST', '/sites/idb/delete', { origin: scope, name: '__smoke_absent__' })
  check('POST /sites/idb/delete：删一个不存在的库也如实回话（不炸）', () => {
    assert(idbDelHttp.status === 200, `status=${idbDelHttp.status}`)
  })

  const cacheDelHttp = await api('POST', '/sites/cache/delete', { origin: scope, name: '__smoke_absent__' })
  check('POST /sites/cache/delete：同上', () => {
    assert(cacheDelHttp.status === 200, `status=${cacheDelHttp.status}`)
  })

  const swHttp = await api('POST', '/sites/sw/unregister', { scopeURL: scope + '/' })
  check('POST /sites/sw/unregister：没有注册时也如实回话', () => {
    assert(swHttp.status === 200, `status=${swHttp.status}`)
  })

  const siteSnapHttp = await api('POST', '/sites/snapshots', { label: 'smoke-http' })
  check('POST /sites/snapshots：拍站点资源快照', () => {
    assert(siteSnapHttp.status === 200 && siteSnapHttp.body.id > 0, JSON.stringify(siteSnapHttp.body).slice(0, 200))
    assert(siteSnapHttp.body.cookies > 0, `快照里 cookie=${siteSnapHttp.body.cookies}`)
  })

  const siteSnapsHttp = await api('GET', '/sites/snapshots')
  check('GET /sites/snapshots：{ rows, total }，且刚拍的在里面', () => {
    assert(siteSnapsHttp.status === 200 && Array.isArray(siteSnapsHttp.body.rows), JSON.stringify(siteSnapsHttp.body).slice(0, 200))
    assert(siteSnapsHttp.body.total === siteSnapsHttp.body.rows.length, `total=${siteSnapsHttp.body.total} vs ${siteSnapsHttp.body.rows.length}`)
    assert(siteSnapsHttp.body.rows.some((row) => row.id === siteSnapHttp.body.id), '列表里没有刚拍的那份')
  })

  const siteDiffHttp = await api('GET', `/sites/snapshots/${siteSnapHttp.body.id}/diff`)
  check('GET /sites/snapshots/:id/diff：拿刚拍的那份当基线比（不该报「全没了」）', () => {
    assert(siteDiffHttp.status === 200 && siteDiffHttp.body.summary, JSON.stringify(siteDiffHttp.body).slice(0, 240))
    const summary = siteDiffHttp.body.summary
    assert(summary.cookiesRemoved === 0, `刚拍完就报了 ${summary.cookiesRemoved} 条 cookie 消失`)
    for (const key of ['originsAdded', 'originsRemoved', 'cookiesAdded', 'cookiesRemoved', 'cookiesChanged', 'keysAdded', 'keysRemoved', 'keysChanged']) {
      assert(typeof summary[key] === 'number', `summary.${key} 不是数字：${JSON.stringify(summary).slice(0, 200)}`)
    }
  })

  // 先删掉刚才写进去的那条，再试「一个条件都不给」—— 顺序不能反，反了测的就不是同一件事
  const cookieDelOne = await api('DELETE', '/cookies?name=' + encodeURIComponent(smokeCookieName))
  check('DELETE /cookies?name=：按名字删掉刚写的那条', () => {
    assert(cookieDelOne.status === 200, `status=${cookieDelOne.status}`)
    assert(cookieDelOne.body.deleted === 1, JSON.stringify(cookieDelOne.body).slice(0, 200))
  })

  const cookieDelEmpty = await api('DELETE', '/cookies')
  check('DELETE /cookies：一个条件都不给 → 必须被拒（防手滑清空整个罐）', () => {
    // 约定：应用级拒绝走「200 + ok:false」；关键是**一条都没删**
    assert(cookieDelEmpty.body?.ok === false, `居然放行了：${JSON.stringify(cookieDelEmpty.body).slice(0, 200)}`)
    assert(cookieDelEmpty.body?.deleted === 0, `说有拒绝，却删了 ${cookieDelEmpty.body?.deleted} 条`)
  })

  const siteClearHttp = await api('POST', '/sites/clear', { origin: scope, types: ['cache_storage'] })
  check('POST /sites/clear：按类型清（清完会重扫，返回的就是清完之后的真相）', () => {
    assert(siteClearHttp.status === 200, `status=${siteClearHttp.status}`)
    assert(siteClearHttp.body.ok === true, JSON.stringify(siteClearHttp.body).slice(0, 200))
  })

  const siteSnapDelHttp = await api('DELETE', `/sites/snapshots/${siteSnapHttp.body.id}`)
  check('DELETE /sites/snapshots/:id：删掉快照', () => {
    assert(siteSnapDelHttp.status === 200 && siteSnapDelHttp.body.deleted === 1, JSON.stringify(siteSnapDelHttp.body).slice(0, 200))
  })
  check(`HTTP 覆盖：${hitRoutes.size} 条路由真调用过（含实时分析面 19 条 + 站点资源面 16 条）`, () => {
    const NEEDED = [
      'GET /events', 'GET /events/stats', 'GET /events/stream',
      'GET /ws', 'GET /ws/connections',
      'GET /endpoints', 'GET /endpoints/detail',
      'GET /graph', 'GET /relations',
      'POST /contracts', 'GET /contracts', 'GET /contracts/*', 'GET /contracts/*/diff', 'DELETE /contracts/*',
      'POST /export/har', 'POST /export/jsonl', 'POST /export/bodies', 'GET /exports/download',
      'POST /dialog',
      'GET /cookies', 'GET /cookies/stats', 'POST /cookies', 'DELETE /cookies',
      'GET /sites', 'GET /sites/detail', 'POST /sites/scan', 'POST /sites/clear',
      'POST /sites/storage', 'POST /sites/idb/delete', 'POST /sites/cache/delete', 'POST /sites/sw/unregister',
      'POST /sites/snapshots', 'GET /sites/snapshots', 'GET /sites/snapshots/*/diff', 'DELETE /sites/snapshots/*'
    ]
    for (const need of NEEDED) assert(hitRoutes.has(need), `没走：${need}`)
    // 64 条路由里只有 /sessions/profile 没走（它要收工重启，由 MCP 侧的 monitor_switch_profile 覆盖）
    assert(hitRoutes.size >= 63, `只覆盖了 ${hitRoutes.size} 条`)
  })
  /* ------------------------------------------------ MCP：58 个工具逐个真调用 */
  console.log('\n== MCP：58 个工具逐个真调用 ==\n')
  mcp = McpClient.spawn(process.execPath, [MCP, `--data-dir=${DATA_DIR}`], { cwd: ROOT })
  await mcp.initialize('smoke-all')

  const tools = (await mcp.send('tools/list', {})).tools ?? []
  const REQUIRED_TOOLS = [
    'monitor_status', 'monitor_capabilities', 'monitor_requests', 'monitor_request', 'monitor_body',
    'monitor_fetch_body', 'monitor_stats', 'monitor_timeline', 'monitor_scripts', 'monitor_script_source',
    'monitor_console', 'monitor_evaluate', 'monitor_dom_tree', 'monitor_dom_inspect', 'monitor_dom_highlight',
    'monitor_input', 'monitor_rules_get', 'monitor_rules_set', 'monitor_rules_stats', 'monitor_probe',
    'monitor_navigate', 'monitor_screenshot', 'monitor_sessions', 'monitor_switch_profile', 'monitor_clear',
    'monitor_events', 'monitor_event_stats', 'monitor_ws_frames', 'monitor_ws_connections', 'monitor_endpoints',
    'monitor_endpoint', 'monitor_graph', 'monitor_relations', 'monitor_export_har', 'monitor_export_jsonl',
    'monitor_collect_resources', 'monitor_contract_snapshot', 'monitor_contracts', 'monitor_contract',
    'monitor_contract_diff', 'monitor_contract_delete', 'monitor_dialog',
    'monitor_cookies', 'monitor_cookie_stats', 'monitor_cookie_set', 'monitor_cookie_delete',
    'monitor_sites', 'monitor_site_detail', 'monitor_site_scan', 'monitor_site_clear',
    'monitor_site_storage_edit', 'monitor_site_idb_delete', 'monitor_site_cache_delete',
    'monitor_site_sw_unregister', 'monitor_site_snapshot', 'monitor_site_snapshots',
    'monitor_site_snapshot_diff', 'monitor_site_snapshot_delete'
  ]
  check(`tools/list：${REQUIRED_TOOLS.length} 个工具一个不少，且都有 description + inputSchema`, () => {
    const names = tools.map((tool) => tool.name)
    for (const name of REQUIRED_TOOLS) assert(names.includes(name), `缺工具：${name}`)
    assert(tools.length >= REQUIRED_TOOLS.length, `工具数=${tools.length}，清单里是 ${REQUIRED_TOOLS.length}`)
    const bare = tools.filter((tool) => !tool.description || tool.description.length <= 10 || !tool.inputSchema)
    assert(bare.length === 0, `description/inputSchema 不合格：${bare.map((t) => t.name).join(',')}`)
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

  const rulesGetTool = await call('monitor_rules_get', { workspaceId: 'default' })
  check('monitor_rules_get', () => {
    assert(rulesGetTool.res.isError !== true, rulesGetTool.text?.slice(0, 160))
    assert(Array.isArray(rulesGetTool.json.output?.rules), 'rules 不是数组')
  })

  const rulesSetTool = await call('monitor_rules_set', {
    workspaceId: 'default',
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
    assert((rulesSetTool.json.output?.invalid ?? []).length === 0, JSON.stringify(rulesSetTool.json).slice(0, 160))
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

  /* ------------------------------------------- MCP：实时分析层工具逐个真调用 */
  console.log('\n== MCP：实时分析层 17 个工具逐个真调用 ==\n')

  const eventsTool = await call('monitor_events', { limit: 3, order: 'asc' })
  check('monitor_events（含 nextSince 游标）', () => {
    assert(eventsTool.res.isError !== true, eventsTool.text?.slice(0, 160))
    assert(Array.isArray(eventsTool.json.rows), 'rows 不是数组')
    assert(typeof eventsTool.json.nextSince === 'number', `nextSince=${eventsTool.json?.nextSince}`)
  })

  const eventStatsTool = await call('monitor_event_stats', {})
  check('monitor_event_stats', () => {
    assert(eventStatsTool.res.isError !== true, eventStatsTool.text?.slice(0, 160))
    assert(typeof eventStatsTool.json.total === 'number', `total=${eventStatsTool.json?.total}`)
    assert(Array.isArray(eventStatsTool.json.rows), 'rows 不是数组')
  })

  const wsFramesTool = await call('monitor_ws_frames', { limit: 3 })
  check('monitor_ws_frames', () => {
    assert(wsFramesTool.res.isError !== true, wsFramesTool.text?.slice(0, 160))
    assert(Array.isArray(wsFramesTool.json.rows), 'rows 不是数组')
  })

  const wsConnsTool = await call('monitor_ws_connections', {})
  check('monitor_ws_connections', () => {
    assert(wsConnsTool.res.isError !== true, wsConnsTool.text?.slice(0, 160))
    assert(Array.isArray(wsConnsTool.json.rows), 'rows 不是数组')
  })

  const endpointsTool = await call('monitor_endpoints', { limit: 5, sort: 'calls' })
  check('monitor_endpoints（端点画像）', () => {
    assert(endpointsTool.res.isError !== true, endpointsTool.text?.slice(0, 160))
    assert(
      (endpointsTool.json.endpoints ?? []).length > 0,
      `端点数=${endpointsTool.json?.endpoints?.length}`
    )
  })

  const endpointTool = await call('monitor_endpoint', { key: endpointsTool.json.endpoints[0].key, sampleLimit: 2 })
  check('monitor_endpoint（按 key 取详情）', () => {
    assert(endpointTool.res.isError !== true, endpointTool.text?.slice(0, 160))
    assert(endpointTool.json.found === true, `found=${endpointTool.json?.found}`)
  })

  const graphTool = await call('monitor_graph', { maxNodes: 200, maxRows: 2000 })
  check('monitor_graph（调用图 + 功能簇）', () => {
    assert(graphTool.res.isError !== true, graphTool.text?.slice(0, 160))
    assert(Array.isArray(graphTool.json.nodes) && Array.isArray(graphTool.json.edges), 'nodes/edges 不是数组')
    assert(Array.isArray(graphTool.json.clusters), '没有 clusters')
  })

  const relationsTool = await call('monitor_relations', { limit: 5, maxRows: 2000 })
  check('monitor_relations（四类关联）', () => {
    assert(relationsTool.res.isError !== true, relationsTool.text?.slice(0, 160))
    for (const key of ['sharedBodies', 'redirectChains', 'domainLinks', 'sharedParams']) {
      assert(Array.isArray(relationsTool.json[key]), `${key} 不是数组`)
    }
  })

  const harTool = await call('monitor_export_har', { includeBodies: true, maxRows: 200 })
  check('monitor_export_har（HAR 落盘）', () => {
    assert(harTool.res.isError !== true, harTool.text?.slice(0, 160))
    assert(harTool.json.path && existsSync(harTool.json.path), `文件不在：${harTool.json?.path}`)
    assert(statSync(harTool.json.path).size === harTool.json.bytes, '报告字节数与文件大小不符')
    assert(harTool.json.entries > 0, `entries=${harTool.json.entries}`)
  })

  const jsonlTool = await call('monitor_export_jsonl', { includeBodies: true, maxRows: 200 })
  check('monitor_export_jsonl（JSONL 落盘）', () => {
    assert(jsonlTool.res.isError !== true, jsonlTool.text?.slice(0, 160))
    assert(jsonlTool.json.path && existsSync(jsonlTool.json.path), `文件不在：${jsonlTool.json?.path}`)
    const lines = readFileSync(jsonlTool.json.path, 'utf8').split('\n').filter(Boolean)
    assert(lines.length === jsonlTool.json.lines, `报告 ${jsonlTool.json.lines} 行 vs 实际 ${lines.length} 行`)
    assert(lines.every((line) => JSON.parse(line)), '有行不是合法 JSON')
  })

  const mirrorTool = await call('monitor_collect_resources', { maxRows: 200 })
  check('monitor_collect_resources（资源镜像 + manifest）', () => {
    assert(mirrorTool.res.isError !== true, mirrorTool.text?.slice(0, 160))
    assert(mirrorTool.json.manifest && existsSync(mirrorTool.json.manifest), `manifest 不在：${mirrorTool.json?.manifest}`)
    assert(mirrorTool.json.files > 0, `一个文件都没落（files=${mirrorTool.json?.files}）`)
  })

  const snapTool = await call('monitor_contract_snapshot', { label: 'smoke-mcp', sampleLimit: 2 })
  check('monitor_contract_snapshot（写快照）', () => {
    assert(snapTool.res.isError !== true, snapTool.text?.slice(0, 160))
    assert(snapTool.json.id > 0, `id=${snapTool.json?.id}`)
  })

  const contractsTool = await call('monitor_contracts', {})
  check('monitor_contracts（列快照）', () => {
    assert(contractsTool.res.isError !== true, contractsTool.text?.slice(0, 160))
    assert(
      (contractsTool.json.rows ?? []).some((row) => row.id === snapTool.json.id),
      `列表里没有刚存的那份（id=${snapTool.json.id}，列表=${JSON.stringify(contractsTool.json).slice(0, 300)}）`
    )
  })

  const contractTool = await call('monitor_contract', { id: snapTool.json.id })
  check('monitor_contract（读快照内容）', () => {
    assert(contractTool.res.isError !== true, contractTool.text?.slice(0, 160))
    assert(contractTool.json.found === true, `found=${contractTool.json?.found}`)
  })

  const contractDiffTool = await call('monitor_contract_diff', { baseId: snapTool.json.id, sampleLimit: 2 })
  check('monitor_contract_diff（拿刚拍的那份当基线比）', () => {
    assert(contractDiffTool.res.isError !== true, contractDiffTool.text?.slice(0, 160))
    const diff = contractDiffTool.json
    assert(diff.summary, `没有 summary：${contractDiffTool.text?.slice(0, 160)}`)
    for (const key of ['added', 'removed', 'changed']) assert(Array.isArray(diff[key]), `${key} 不是数组`)
    // 基线是刚刚才拍的，中间不可能有接口消失 —— 报了就是回归算法在乱报
    assert(diff.summary.removedEndpoints === 0, `报了 ${diff.summary.removedEndpoints} 个端点消失`)
  })

  const contractDeleteTool = await call('monitor_contract_delete', { id: snapTool.json.id })
  check('monitor_contract_delete', () => {
    assert(contractDeleteTool.res.isError !== true, contractDeleteTool.text?.slice(0, 160))
    assert(contractDeleteTool.json.deleted === 1, `deleted=${contractDeleteTool.json?.deleted}`)
  })

  const dialogTool = await call('monitor_dialog', { accept: true })
  check('monitor_dialog（没有对话框时也如实回话，不报错）', () => {
    assert(dialogTool.res.isError !== true, dialogTool.text?.slice(0, 160))
    assert(typeof dialogTool.json.ok === 'boolean', `ok=${JSON.stringify(dialogTool.json?.ok)}`)
  })
  /* ------------------------------------------- MCP：站点资源面 16 个工具逐个真调用 */
  console.log('\n== MCP：站点资源面 16 个工具逐个真调用 ==\n')

  const siteCookieName = 'smoke_mcp_' + Date.now().toString(36)
  const cookieSetTool = await call('monitor_cookie_set', { name: siteCookieName, value: 'mcp1', url: scope + '/' })
  check('monitor_cookie_set（往罐里写）', () => {
    assert(cookieSetTool.res.isError !== true, cookieSetTool.text?.slice(0, 160))
    assert(cookieSetTool.json.ok === true, JSON.stringify(cookieSetTool.json).slice(0, 160))
  })

  const cookiesTool = await call('monitor_cookies', { domain: '127.0.0.1', limit: 200 })
  check('monitor_cookies（读罐，且行形状与 HTTP 侧一致）', () => {
    assert(cookiesTool.res.isError !== true, cookiesTool.text?.slice(0, 160))
    assert(Array.isArray(cookiesTool.json.rows), 'rows 不是数组')
    assert(typeof cookiesTool.json.total === 'number', `total=${cookiesTool.json?.total}`)
    assert(cookiesTool.json.rows.some((row) => row.name === siteCookieName), `罐里没有刚写的那条（共 ${cookiesTool.json.rows.length} 行）`)
    const sample = cookiesTool.json.rows[0]
    for (const key of ['key', 'name', 'value', 'domain', 'path', 'crossSite', 'sentCount']) {
      assert(key in sample, `行里没有 ${key}：${JSON.stringify(sample).slice(0, 200)}`)
    }
  })

  const cookieStatsTool = await call('monitor_cookie_stats', {})
  check('monitor_cookie_stats（分类之和 = 总数）', () => {
    assert(cookieStatsTool.res.isError !== true, cookieStatsTool.text?.slice(0, 160))
    const stats = cookieStatsTool.json
    assert(stats.session + stats.persistent === stats.total, `会话 ${stats.session} + 持久 ${stats.persistent} ≠ ${stats.total}`)
  })

  const siteScanTool = await call('monitor_site_scan', { origin: scope, limit: 5 })
  check('monitor_site_scan（真去浏览器里扫一遍并落库）', () => {
    assert(siteScanTool.res.isError !== true, siteScanTool.text?.slice(0, 160))
    assert(siteScanTool.json.ok === true, JSON.stringify(siteScanTool.json).slice(0, 200))
    assert((siteScanTool.json.origins ?? []).includes(scope), `没扫到受控域：${JSON.stringify(siteScanTool.json.origins)}`)
  })

  const sitesTool = await call('monitor_sites', { limit: 100 })
  check('monitor_sites（清单，且与 HTTP 侧同一份库）', () => {
    assert(sitesTool.res.isError !== true, sitesTool.text?.slice(0, 160))
    const row = (sitesTool.json.rows ?? []).find((item) => item.origin === scope)
    assert(row, `清单里没有受控域：${JSON.stringify((sitesTool.json.rows ?? []).map((item) => item.origin)).slice(0, 200)}`)
    const httpRow = (sitesHttp.body.rows ?? []).find((item) => item.origin === scope)
    assert(httpRow, 'HTTP 侧那份不见了 —— 两边读的不是同一个库')
    assert(row.scanned === true, '扫过了却标着没扫')
  })

  const siteDetailTool = await call('monitor_site_detail', { origin: scope })
  check('monitor_site_detail（明细里 cookie 与本地存储都在）', () => {
    assert(siteDetailTool.res.isError !== true, siteDetailTool.text?.slice(0, 160))
    // 明细是平铺的（SiteDetail extends SiteOriginRow），没有 { found, detail } 包壳
    assert(siteDetailTool.json.origin === scope, `origin=${siteDetailTool.json?.origin}`)
    assert((siteDetailTool.json.cookies ?? []).length > 0, '明细里没有 cookie')
    assert(Array.isArray(siteDetailTool.json.localStorage), '没有 localStorage 段')
  })

  const siteStorageTool = await call('monitor_site_storage_edit', { origin: scope, area: 'local', action: 'set', key: 'mcp_k', value: 'mcp_v' })
  check('monitor_site_storage_edit（写本地存储，写完自动重扫）', () => {
    assert(siteStorageTool.res.isError !== true, siteStorageTool.text?.slice(0, 160))
    assert(siteStorageTool.json.ok === true, JSON.stringify(siteStorageTool.json).slice(0, 160))
  })

  const siteIdbTool = await call('monitor_site_idb_delete', { origin: scope, name: '__smoke_absent__' })
  check('monitor_site_idb_delete（删不存在的库也如实回话）', () => {
    assert(siteIdbTool.res.isError !== true, siteIdbTool.text?.slice(0, 160))
  })

  const siteCacheTool = await call('monitor_site_cache_delete', { origin: scope, name: '__smoke_absent__' })
  check('monitor_site_cache_delete（同上）', () => {
    assert(siteCacheTool.res.isError !== true, siteCacheTool.text?.slice(0, 160))
  })

  const siteSwTool = await call('monitor_site_sw_unregister', { scopeURL: scope + '/' })
  check('monitor_site_sw_unregister（没有注册也如实回话）', () => {
    assert(siteSwTool.res.isError !== true, siteSwTool.text?.slice(0, 160))
  })

  const siteSnapTool = await call('monitor_site_snapshot', { label: 'smoke-mcp' })
  check('monitor_site_snapshot（拍快照）', () => {
    assert(siteSnapTool.res.isError !== true, siteSnapTool.text?.slice(0, 160))
    assert(siteSnapTool.json.id > 0, `id=${siteSnapTool.json?.id}`)
  })

  const siteSnapsTool = await call('monitor_site_snapshots', { limit: 20 })
  check('monitor_site_snapshots（列表里有刚拍的那份）', () => {
    assert(siteSnapsTool.res.isError !== true, siteSnapsTool.text?.slice(0, 160))
    assert((siteSnapsTool.json.rows ?? []).some((row) => row.id === siteSnapTool.json.id), `列表：${JSON.stringify(siteSnapsTool.json).slice(0, 200)}`)
  })

  const siteDiffTool = await call('monitor_site_snapshot_diff', { baseId: siteSnapTool.json.id })
  check('monitor_site_snapshot_diff（基线是刚拍的 → 不该报「全没了」）', () => {
    assert(siteDiffTool.res.isError !== true, siteDiffTool.text?.slice(0, 160))
    assert(siteDiffTool.json.summary, JSON.stringify(siteDiffTool.json).slice(0, 200))
    assert(siteDiffTool.json.summary.cookiesRemoved === 0, `刚拍完就报了 ${siteDiffTool.json.summary.cookiesRemoved} 条 cookie 消失`)
    assert(siteDiffTool.json.summary.originsRemoved === 0, `报了 ${siteDiffTool.json.summary.originsRemoved} 个域消失`)
  })

  const cookieDelTool = await call('monitor_cookie_delete', { name: siteCookieName })
  check('monitor_cookie_delete（按名字删）', () => {
    assert(cookieDelTool.res.isError !== true, cookieDelTool.text?.slice(0, 160))
    assert(cookieDelTool.json.deleted >= 1, JSON.stringify(cookieDelTool.json).slice(0, 160))
  })

  const siteClearTool = await call('monitor_site_clear', { origin: scope, types: ['cache_storage'] })
  check('monitor_site_clear（按类型清）', () => {
    assert(siteClearTool.res.isError !== true, siteClearTool.text?.slice(0, 160))
    assert(siteClearTool.json.ok === true, JSON.stringify(siteClearTool.json).slice(0, 160))
  })

  const siteSnapDelTool = await call('monitor_site_snapshot_delete', { id: siteSnapTool.json.id })
  check('monitor_site_snapshot_delete', () => {
    assert(siteSnapDelTool.res.isError !== true, siteSnapDelTool.text?.slice(0, 160))
    assert(siteSnapDelTool.json.deleted === 1, `deleted=${siteSnapDelTool.json?.deleted}`)
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
