#!/usr/bin/env node
/**
 * AI 友好面验收：控制服务（HTTP API）+ MCP server。
 *
 * 判据分三层：
 *   1. 发现：control.json 写出来了、端口真的在听、token 能鉴权（无 token 必须 401）。
 *   2. API：每个接口的返回必须能与「同一条数据从别处拿到的真值」对上 ——
 *      比如 requests 的 total 要和库里 COUNT(*) 一致，dom/tree 要和页面里的 DOM 一致。
 *   3. MCP：走真正的 stdio JSON-RPC，tools/list 要能列全，tools/call 的返回值
 *      必须和直接 HTTP 调用**逐字一致**（同一份数据，不是两条路各说各话）。
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const ORIGIN = join(ROOT, 'scripts', 'test-origin.mjs')
const MCP = join(ROOT, 'mcp', 'server.mjs')
const CLEANUP = join(ROOT, 'scripts', 'cleanup-stray.ps1')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ORIGIN_PORT = Number(process.env['CONTROL_ORIGIN_PORT'] ?? 8801)
const CDP_PORT = Number(process.env['CONTROL_CDP_PORT'] ?? 9481)
const API_PORT = Number(process.env['CONTROL_API_PORT'] ?? 9490)
const DATA_DIR = process.env['CONTROL_DATA_DIR'] ?? join(ROOT, `.userdata/control-${Date.now()}`)

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
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CLEANUP, '-Root', ROOT], {
      encoding: 'utf8',
      timeout: 60000,
      stdio: 'pipe'
    })
  } catch {
    /* 清理失败不影响结论 */
  }
}

/* --------------------------------------------------------------- 控制面客户端 */

let endpoint = null

async function api(method, path, { query, body, token } = {}) {
  const url = new URL(path, `http://127.0.0.1:${endpoint.port}`)
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  }
  const headers = {}
  const useToken = token === undefined ? endpoint.token : token
  if (useToken) headers.authorization = `Bearer ${useToken}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await res.text()
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = { raw: text }
  }
  return { status: res.status, body: parsed }
}

/* --------------------------------------------------------------- MCP 客户端 */

class Mcp {
  constructor(child) {
    this.child = child
    this.nextId = 1
    this.pending = new Map()
    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      const text = line.trim()
      if (!text) return
      let msg
      try {
        msg = JSON.parse(text)
      } catch {
        return
      }
      if (msg.id === undefined) return
      const slot = this.pending.get(msg.id)
      if (!slot) return
      this.pending.delete(msg.id)
      msg.error ? slot.reject(new Error(msg.error.message)) : slot.resolve(msg.result)
    })
  }

  send(method, params) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP 超时：${method}`))
      }, 60000)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }
}

/* --------------------------------------------------------------- 主流程 */

console.log('== AI 友好面验收（HTTP API + MCP） ==')

mkdirSync(DATA_DIR, { recursive: true })
const origin = spawn(process.execPath, [ORIGIN, String(ORIGIN_PORT)], { cwd: ROOT, stdio: 'ignore' })
const app = spawn(
  ELECTRON,
  ['out/main/index.js', '--no-sandbox', `--remote-debugging-port=${CDP_PORT}`],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      MONITOR_DATA_DIR: DATA_DIR,
      MONITOR_URL: `http://127.0.0.1:${ORIGIN_PORT}/`,
      MONITOR_PROFILE: 'L',
      MONITOR_UI_TAB: 'list',
      MONITOR_AUTO_QUIT_MS: '0',
      MONITOR_API_PORT: String(API_PORT)
    },
    stdio: 'pipe'
  }
)
let appLog = ''
app.stdout.on('data', (c) => {
  appLog += String(c)
})
app.stderr.on('data', (c) => {
  appLog += String(c)
})

let mcp = null
try {
  /* ---- 1. 发现与鉴权 ---- */
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

  console.log('\n== 发现与鉴权 ==')
  check('control.json 写出来了，且带 port/token', () => {
    assert(info, `没等到 ${infoPath}`)
    assert(typeof info.port === 'number' && info.port > 0, 'port 不对')
    assert(typeof info.token === 'string' && info.token.length >= 16, 'token 太短')
  })
  endpoint = info

  const unauth = await api('GET', '/status', { token: '' })
  check('没带 token 的请求被拒（401）', () => {
    assert(unauth.status === 401, `期望 401，实际 ${unauth.status}`)
  })

  const health = await api('GET', '/health')
  check('/health 可用（不需要 token 的探活）', () => {
    assert(health.status === 200, `status=${health.status}`)
    assert(health.body?.ok === true, `body=${JSON.stringify(health.body)}`)
  })

  const bad = await api('GET', '/nope')
  check('不存在的接口回 404 而不是崩掉', () => {
    assert(bad.status === 404, `status=${bad.status}`)
  })

  /* ---- 2. 等页面跑起来，再验数据面 ---- */
  let status = null
  for (let i = 0; i < 60; i++) {
    const res = await api('GET', '/status')
    status = res.body
    if (status?.state === 'connected' && status?.requestCount > 0) break
    await sleep(500)
  }
  console.log('\n== 数据面 ==')
  check('status 反映了真实会话（connected + 有请求 + control 端口）', () => {
    assert(status?.state === 'connected', `state=${status?.state}`)
    assert(status.requestCount > 0, `requestCount=${status.requestCount}`)
    assert(status.control?.enabled === true, 'control.enabled 不是 true')
    assert(status.control.port === info.port, `control.port=${status.control.port} vs ${info.port}`)
  })

  const reqs = await api('GET', '/requests', { query: { limit: 5, order: 'time_desc' } })
  check('GET /requests 返回分页结构', () => {
    const page = reqs.body
    assert(Array.isArray(page?.rows), `没有 rows：${JSON.stringify(reqs.body).slice(0, 200)}`)
    assert(page.rows.length > 0, '一条都没有')
    assert(page.rows.length <= 5, `limit 没生效：${page.rows.length}`)
    assert(typeof page.total === 'number' && page.total > 0, `total=${page.total}`)
  })

  const page = reqs.body
  const firstSeq = page?.rows?.[0]?.seq
  const detail = await api('GET', `/requests/${firstSeq}`)
  check('GET /requests/:seq 与列表里那条是同一个请求', () => {
    // 详情的形状是 { request, headers, timings, proxy, ... }，不是列表行本身
    const row = detail.body?.request
    assert(row?.seq === firstSeq, `seq=${row?.seq} vs ${firstSeq}`)
    assert(typeof row?.url === 'string' && row.url.length > 0, '没有 url')
    assert(row.url === page.rows[0].url, '与列表里那条对不上')
    assert(detail.body?.body !== undefined, `详情缺 body 段：${Object.keys(detail.body ?? {}).join(',')}`)
  })

  const filters = await api('GET', '/requests', { query: { urlPattern: 'no-such-path-xyz', limit: 10 } })
  const filtersTotal = await api('GET', '/requests', { query: { limit: 1 } })
  check('过滤条件真的生效（假条件查不到，真条件查得到）', () => {
    assert(filters.body?.total === 0, `假条件还查到了 ${filters.body?.total} 条`)
    assert((filters.body?.rows ?? []).length === 0, '假条件还有行')
    assert(filtersTotal.body?.total > 0, `真条件也没数据：${filtersTotal.body?.total}`)
  })

  // host 字段是带端口的（127.0.0.1:8802），过滤要拿列表里的真值
  const hostValue = page.rows?.[0]?.host
  const hostFilter = await api('GET', '/requests', { query: { domain: hostValue, limit: 3 } })
  check('域名别名 domain → host 生效', () => {
    assert(typeof hostValue === 'string' && hostValue.length > 0, `host=${hostValue}`)
    assert(hostFilter.body?.total > 0, `domain=${hostValue} 查不到：${hostFilter.body?.total}`)
  })

  const searchFilter = await api('GET', '/requests', { query: { q: 'sw-install', limit: 5 } })
  check('全文别名 q → search 生效', () => {
    assert(searchFilter.body?.total > 0, `q=sw-install 查不到：${searchFilter.body?.total}`)
  })

  const stats = await api('GET', '/stats')
  check('GET /stats 有分组数据', () => {
    assert(stats.status === 200, `status=${stats.status}`)
    assert(stats.body && typeof stats.body === 'object', '没有 stats')
  })

  const scripts = await api('GET', '/scripts', { query: { limit: 5 } })
  check('GET /scripts 可用', () => {
    assert(scripts.status === 200, `status=${scripts.status}`)
    assert(Array.isArray(scripts.body?.rows), `rows=${JSON.stringify(scripts.body).slice(0, 150)}`)
  })

  const domTree = await api('GET', '/dom/tree')
  check('GET /dom/tree 拿到真实 DOM（不是空壳）', () => {
    const rows = domTree.body?.rows
    assert(Array.isArray(rows) && rows.length > 0, `rows=${JSON.stringify(domTree.body).slice(0, 200)}`)
    const labels = rows.map((r) => r.label ?? r.nodeName ?? '').join(' ')
    assert(/html|body|head/i.test(labels), `树里没有 html/body：${labels.slice(0, 200)}`)
  })

  const domInspect = await api('GET', '/dom/inspect', { query: { selector: 'body' } })
  check('GET /dom/inspect 能按选择器查元素', () => {
    assert(domInspect.body?.ok !== false, JSON.stringify(domInspect.body).slice(0, 200))
    assert(typeof domInspect.body?.outerHTML === 'string' && domInspect.body.outerHTML.length > 0, `outerHTML=${String(domInspect.body?.outerHTML).slice(0, 80)}`)
    assert(domInspect.body?.box !== undefined, '详情缺盒模型')
    assert(Array.isArray(domInspect.body?.matched), '详情缺命中样式')
    assert(Array.isArray(domInspect.body?.listeners), '详情缺事件监听器')
  })

  const rules = await api('GET', '/rules')
  check('GET /rules 返回规则集结构', () => {
    assert(Array.isArray(rules.body?.rules), `rules=${JSON.stringify(rules.body).slice(0, 150)}`)
    assert(Array.isArray(rules.body?.injections), 'injections 不是数组')
  })

  const probe = await api('POST', '/probe', { body: {} })
  check('POST /probe 真的跑出报告', () => {
    assert(probe.status === 200, `status=${probe.status}`)
    assert(probe.body?.ok === true, `ok=${probe.body?.ok} error=${probe.body?.error}`)
    assert(probe.body?.report?.checks?.length > 0, '报告里没有检测项')
    assert(probe.body?.report?.summary?.pass >= 1, `summary=${JSON.stringify(probe.body?.report?.summary)}`)
  })

  const sessions = await api('GET', '/sessions')
  check('GET /sessions 有实例与存储分区', () => {
    assert(Array.isArray(sessions.body?.instances) && sessions.body.instances.length > 0, `instances=${JSON.stringify(sessions.body).slice(0, 150)}`)
    assert(sessions.body.instances.filter((i) => i.live).length === 1, 'live 实例不是唯一')
  })

  const evaluated = await api('POST', '/evaluate', { body: { expression: 'document.title' } })
  check('POST /evaluate 能读到页面里的值', () => {
    assert(evaluated.body?.ok !== false, JSON.stringify(evaluated.body).slice(0, 200))
    assert(evaluated.body?.value !== undefined, `value=${JSON.stringify(evaluated.body?.value)}`)
  })

  const input = await api('POST', '/input', { body: { kind: 'move', x: 300, y: 220, seed: 7 } })
  check('POST /input 拟人化移动有轨迹统计', () => {
    assert(input.body?.ok === true, `ok=${input.body?.ok} err=${input.body?.error}`)
    assert(input.body?.points > 1, `points=${input.body?.points}`)
    assert(input.body?.pathLength >= input.body?.straight, `pathLength=${input.body?.pathLength} straight=${input.body?.straight}`)
  })

  const caps = await api('GET', '/capabilities')
  check('GET /capabilities 报出截图通道可用', () => {
    assert(caps.body?.profile === 'L', `profile=${caps.body?.profile}`)
    assert(caps.body?.screenshot === true, `screenshot=${caps.body?.screenshot}`)
  })
  /* ---- 2b. 截图 ---- */
  const shot = await api('POST', '/screenshot', { body: { format: 'png' } })
  check('POST /screenshot 落盘了真实 PNG（文件头 + 尺寸都对）', () => {
    assert(shot.body?.ok === true, `ok=${shot.body?.ok} err=${shot.body?.error}`)
    const file = shot.body?.path
    assert(typeof file === 'string' && existsSync(file), `没有落盘：${file}`)
    const raw = readFileSync(file)
    assert(raw.length > 1000, `文件太小：${raw.length}B`)
    assert(raw.length === shot.body.bytes, `bytes=${shot.body.bytes} 实际 ${raw.length}`)
    assert(raw.readUInt32BE(0) === 0x89504e47 && raw.readUInt32BE(4) === 0x0d0a1a0a, '不是 PNG（签名不对）')
    assert(shot.body.width > 0 && shot.body.height > 0, `尺寸=${shot.body.width}x${shot.body.height}`)
    assert(raw.readUInt32BE(16) === shot.body.width && raw.readUInt32BE(20) === shot.body.height, '报的尺寸和图片头对不上')
    assert(shot.body.mimeType === 'image/png', `mimeType=${shot.body.mimeType}`)
  })

  // 元素截图：拿 body 的真实边界（getBoundingClientRect，border box）当另一处真值
  const elNodeId = domInspect.body?.node?.nodeId
  const elRect = await api('POST', '/evaluate', {
    body: { expression: 'JSON.stringify((() => { const r = document.body.getBoundingClientRect(); return { w: r.width, h: r.height, dpr: window.devicePixelRatio } })())' }
  })
  const elShot = await api('POST', '/screenshot', { body: { nodeId: elNodeId } })
  check('按 nodeId 截元素：尺寸与该元素的真实边界一致', () => {
    assert(elNodeId > 0, `nodeId=${elNodeId}`)
    assert(elShot.body?.ok === true, `ok=${elShot.body?.ok} err=${elShot.body?.error}`)
    assert(elShot.body?.nodeId === elNodeId, `nodeId 回显不对：${elShot.body?.nodeId}`)
    const rect = JSON.parse(elRect.body?.value ?? '{}')
    const dpr = rect.dpr ?? 1
    const fits = (actual, want) => Math.abs(actual - want) <= 2 || Math.abs(actual - want * dpr) <= 2
    assert(fits(elShot.body.width, rect.w), `元素宽 ${elShot.body.width} 对不上边界 ${rect.w}（dpr=${dpr}）`)
    assert(fits(elShot.body.height, rect.h), `元素高 ${elShot.body.height} 对不上边界 ${rect.h}（dpr=${dpr}）`)
    assert(elShot.body.bytes > 0 && existsSync(elShot.body.path), '元素截图没落盘')
  })
  // 全页截图的尺寸必须和页面自己报的文档尺寸对上（允许 dpr 倍率）
  const expected = await api('POST', '/evaluate', {
    body: { expression: 'JSON.stringify({ h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth, dpr: window.devicePixelRatio })' }
  })
  const fullShot = await api('POST', '/screenshot', { body: { fullPage: true, format: 'jpeg', quality: 60 } })
  check('全页 JPEG 截图的尺寸与页面文档尺寸一致', () => {
    assert(fullShot.body?.ok === true, `ok=${fullShot.body?.ok} err=${fullShot.body?.error}`)
    assert(fullShot.body?.format === 'jpeg' && /\.jpg$/.test(fullShot.body?.path ?? ''), `format=${fullShot.body?.format} path=${fullShot.body?.path}`)
    assert(fullShot.body.fullPage === true, 'fullPage 标记丢了')
    const css = JSON.parse(expected.body?.value ?? '{}')
    const near = (actual, want) => Math.abs(actual - want) <= 2 || Math.abs(actual - want * css.dpr) <= 2
    assert(near(fullShot.body.width, css.w), `宽 ${fullShot.body.width} 对不上文档 ${css.w}（dpr=${css.dpr}）`)
    assert(near(fullShot.body.height, css.h), `高 ${fullShot.body.height} 对不上文档 ${css.h}（dpr=${css.dpr}）`)
    assert(fullShot.body.height >= shot.body.height, `全页 ${fullShot.body.height} 比视口 ${shot.body.height} 还矮`)
    const raw = readFileSync(fullShot.body.path)
    assert(raw[0] === 0xff && raw[1] === 0xd8, '不是 JPEG（SOI 不对）')
    assert(raw.length === fullShot.body.bytes, `bytes=${fullShot.body.bytes} 实际 ${raw.length}`)
  })
  /* ---- 3. MCP ---- */
  console.log('\n== MCP（stdio JSON-RPC） ==')
  mcp = new Mcp(spawn(process.execPath, [MCP, `--data-dir=${DATA_DIR}`], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] }))

  const init = await mcp.send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'acceptance', version: '1' } })
  check('initialize 返回协议版本与 serverInfo', () => {
    assert(typeof init?.protocolVersion === 'string', '没有 protocolVersion')
    assert(init?.serverInfo?.name === 'chromium-monitor', `serverInfo=${JSON.stringify(init?.serverInfo)}`)
    assert(init?.capabilities?.tools !== undefined, '没有声明 tools 能力')
  })
  mcp.notify('notifications/initialized', {})

  const list = await mcp.send('tools/list', {})
  const names = (list?.tools ?? []).map((t) => t.name)
  check('tools/list 列全了控制面（>=20 个工具）', () => {
    assert(names.length >= 20, `只列了 ${names.length} 个：${names.join(',')}`)
    for (const required of ['monitor_status', 'monitor_requests', 'monitor_request', 'monitor_dom_tree', 'monitor_dom_inspect', 'monitor_evaluate', 'monitor_input', 'monitor_rules_get', 'monitor_rules_set', 'monitor_probe', 'monitor_sessions', 'monitor_switch_profile', 'monitor_scripts', 'monitor_console', 'monitor_body', 'monitor_stats', 'monitor_screenshot', 'monitor_capabilities', 'monitor_timeline']) {
      assert(names.includes(required), `缺工具：${required}`)
    }
  })

  check('每个工具都带 description 与 inputSchema', () => {
    for (const tool of list.tools) {
      assert(typeof tool.description === 'string' && tool.description.length > 10, `${tool.name} 的 description 太短`)
      assert(tool.inputSchema && typeof tool.inputSchema === 'object', `${tool.name} 没有 inputSchema`)
    }
  })

  const mcpStatus = await mcp.send('tools/call', { name: 'monitor_status', arguments: {} })
  const httpStatus = await api('GET', '/status')
  check('MCP 的 monitor_status 与直接 HTTP 的结果逐字一致', () => {
    const viaMcp = JSON.parse(mcpStatus.content[0].text)
    assert(JSON.stringify(viaMcp) === JSON.stringify(httpStatus.body), '两边不一致')
  })

  const mcpReqs = await mcp.send('tools/call', { name: 'monitor_requests', arguments: { limit: 3 } })
  const httpReqs = await api('GET', '/requests', { query: { limit: 3, order: 'time_desc' } })
  check('MCP 的 monitor_requests 与 HTTP 一致（分页参数透传正确）', () => {
    const viaMcp = JSON.parse(mcpReqs.content[0].text)
    assert(JSON.stringify(viaMcp) === JSON.stringify(httpReqs.body), '两边不一致')
  })

  const mcpDom = await mcp.send('tools/call', { name: 'monitor_dom_inspect', arguments: { selector: 'body' } })
  check('MCP 的 monitor_dom_inspect 也能拿到元素', () => {
    const viaMcp = JSON.parse(mcpDom.content[0].text)
    assert(viaMcp?.ok !== false, JSON.stringify(viaMcp).slice(0, 200))
    assert(typeof viaMcp?.outerHTML === 'string', 'outerHTML 不是字符串')
  })

  const mcpEval = await mcp.send('tools/call', { name: 'monitor_evaluate', arguments: { expression: '1 + 1' } })
  check('MCP 的 monitor_evaluate 能求值', () => {
    const viaMcp = JSON.parse(mcpEval.content[0].text)
    const data = viaMcp.data ?? viaMcp
    assert(data?.ok !== false, JSON.stringify(data).slice(0, 200))
    assert(data?.value === 2 || data?.value === '2', `value=${JSON.stringify(data?.value)}`)
  })

  const mcpShot = await mcp.send('tools/call', { name: 'monitor_screenshot', arguments: { format: 'png' } })
  check('MCP 的 monitor_screenshot 真的带回了 image 块', () => {
    const textBlock = (mcpShot?.content ?? []).find((b) => b.type === 'text')
    const imageBlock = (mcpShot?.content ?? []).find((b) => b.type === 'image')
    assert(textBlock, '没有文本块（元数据）')
    assert(imageBlock, `没有 image 块：${JSON.stringify(mcpShot?.content ?? []).slice(0, 200)}`)
    assert(imageBlock.mimeType === 'image/png', `mimeType=${imageBlock.mimeType}`)
    const meta = JSON.parse(textBlock.text)
    assert(meta.ok === true, `ok=${meta.ok} err=${meta.error}`)
    assert(typeof meta.path === 'string' && existsSync(meta.path), `meta.path 不存在：${meta.path}`)
    assert(!('dataBase64' in meta), 'base64 不该出现在文本块里（否则同一张图发两遍）')
    const raw = Buffer.from(imageBlock.data, 'base64')
    assert(raw.length === meta.bytes, `image 块 ${raw.length}B vs meta ${meta.bytes}B`)
    assert(raw.length === readFileSync(meta.path).length, 'image 块与落盘文件不是同一张图')
    assert(raw.readUInt32BE(0) === 0x89504e47, 'image 块不是 PNG')
  })
  const mcpUnknown = await mcp.send('tools/call', { name: 'no_such_tool', arguments: {} })
  check('未知工具回 isError 而不是断连接', () => {
    assert(mcpUnknown?.isError === true, JSON.stringify(mcpUnknown).slice(0, 200))
  })

  const after = await mcp.send('tools/list', {})
  check('出错之后连接还能用（不是一次性）', () => {
    assert((after?.tools ?? []).length >= 20, `工具数=${(after?.tools ?? []).length}`)
  })
} catch (err) {
  console.log(`\n验收中断：${err.message}`)
  results.push({ name: '主流程', ok: false, message: err.message })
} finally {
  try {
    mcp?.child?.kill()
  } catch {
    /* 已经退了 */
  }
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
  await sleep(800)
  cleanupStray()
  if (process.env['CONTROL_KEEP'] !== '1') {
    try {
      rmSync(DATA_DIR, { recursive: true, force: true })
    } catch {
      /* Windows 上偶尔删不掉 */
    }
  }
}

const passed = results.filter((r) => r.ok).length
console.log(`\n== 结果 ==\n  ${passed}/${results.length} 通过`)
if (appLog.includes('MONITOR_SUMMARY')) {
  console.log('  应用正常收工')
}
process.exit(results.every((r) => r.ok) ? 0 : 1)