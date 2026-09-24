#!/usr/bin/env node
/**
 * 实时分析面验收：事件流 / WebSocket / 接口画像 / 调用图 / 关联 / 导出 / 契约回归。
 *
 * 判据一律外部可观测，不采信引擎自述：
 *   - 受控 origin 自己的 HTTP 请求日志与 WS 双向日志（服务端视角的真值）
 *   - 页面自己回报的东西（/api/rt-report）
 *   - 磁盘上真多出来的文件（下载、导出）
 * 三条入口（HTTP API / MCP / UI）读的必须是同一份数据，所以对同一批数据同时走三条路逐字比对。
 *
 *   node scripts/test-realtime.mjs
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { startOrigin } from './test-origin.mjs'
import { openCdp, waitControlTarget } from './app-harness.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const MCP = join(ROOT, 'mcp', 'server.mjs')
const CLEANUP = join(ROOT, 'scripts', 'cleanup-stray.ps1')

const ORIGIN_PORT = Number(process.env['RT_ORIGIN_PORT'] ?? 8821)
const CDP_PORT = Number(process.env['RT_CDP_PORT'] ?? 9730)
const API_PORT = Number(process.env['RT_API_PORT'] ?? 9731)
const DATA_DIR = process.env['RT_DATA_DIR'] ?? join(ROOT, `.userdata/realtime-${Date.now()}`)
const DOWNLOAD_NAME = 'monitor-rt-download.txt'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const results = []
async function check(name, fn) {
  try {
    await fn()
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
/**
 * 是不是 json-echo 本体。不能直接用 includes('/api/json-echo')：
 * 那样会把 /api/json-echo-b 也算进来（判据就会拿错靶子）
 */
const isEcho = (text) => /\/api\/json-echo(?:[?#]|$)/.test(String(text ?? ''))
function section(title) {
  console.log(`\n== ${title} ==`)
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
async function api(method, path, { query, body } = {}) {
  const url = new URL(path, `http://127.0.0.1:${endpoint.port}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  const headers = { authorization: `Bearer ${endpoint.token}` }
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
      }, 120000)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  async call(name, args) {
    const out = await this.send('tools/call', { name, arguments: args ?? {} })
    if (out?.isError) throw new Error(`MCP ${name} 报错：${JSON.stringify(out.content).slice(0, 200)}`)
    return JSON.parse(out.content[0].text)
  }
}

/** 等到 fn 返回真值。超时把最后一次的结果带上，方便定位 */
async function waitFor(label, fn, timeoutMs = 30000, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs
  let last = null
  for (;;) {
    try {
      const out = await fn()
      if (out) return out
      last = out
    } catch (err) {
      last = `error: ${err.message}`
    }
    if (Date.now() > deadline) throw new Error(`等不到 ${label}（最后：${JSON.stringify(last)?.slice(0, 240)}）`)
    await sleep(intervalMs)
  }
}
console.log('== 实时分析面验收（事件流 / WS / 画像 / 调用图 / 导出 / 契约） ==')

mkdirSync(DATA_DIR, { recursive: true })
const origin = await startOrigin(ORIGIN_PORT)
const BASE = `http://127.0.0.1:${origin.port}`
// 第二个 origin 只用来被「跨域取图」：同域请求会被有意排除（那不算关联），
// 所以「页面 → 域」这条能力必须有个真的别的域才验得动
const peer = await startOrigin(0)
const REAL_PAGE = `${BASE}/realtime.html?peer=${peer.port}`
console.log(`  受控 origin: ${BASE}（peer: http://127.0.0.1:${peer.port}）`)
console.log(`  数据目录: ${DATA_DIR}`)

// 下载落在「数据目录」下：自动化不该往用户下载夹里丢东西
const downloadPath = join(DATA_DIR, 'downloads', DOWNLOAD_NAME)
// 先清掉可能残留的同名文件，否则「文件真的落盘了」这条判据不成立
try {
  rmSync(downloadPath, { force: true })
} catch {
  /* 没有就算了 */
}

const app = spawn(ELECTRON, ['out/main/index.js', '--no-sandbox', `--remote-debugging-port=${CDP_PORT}`], {
  cwd: ROOT,
  env: {
    ...process.env,
    MONITOR_DATA_DIR: DATA_DIR,
    MONITOR_URL: REAL_PAGE,
    MONITOR_PROFILE: 'L',
    MONITOR_UI_TAB: 'events',
    MONITOR_AUTO_QUIT_MS: '0',
    MONITOR_CAPTURE_BODIES: '1',
    MONITOR_CAPTURE_SCRIPTS: '1',
    MONITOR_API_PORT: String(API_PORT)
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: false
})
let appLog = ''
app.stdout.on('data', (chunk) => (appLog += String(chunk)))
app.stderr.on('data', (chunk) => (appLog += String(chunk)))

let mcp = null
let cdp = null

/** 页面自己回报的东西：origin 侧的真值 */
const reports = () => origin.requests.filter((item) => item.path === '/api/rt-report')
const reportOf = (key, value) =>
  reports().find((item) => new URLSearchParams(item.query ?? '').get(key) === value)

try {
  /* ---------------------------------------------------------------- 起场 */
  const infoPath = join(DATA_DIR, 'control.json')
  const info = await waitFor(
    'control.json',
    async () => {
      if (!existsSync(infoPath)) return null
      try {
        const parsed = JSON.parse(readFileSync(infoPath, 'utf8'))
        return parsed?.port && parsed?.token ? parsed : null
      } catch {
        return null
      }
    },
    60000,
    400
  )
  endpoint = info

  await waitFor(
    '控制器连上并有流量',
    async () => {
      const res = await api('GET', '/status')
      return res.body?.state === 'connected' && (res.body?.requestCount ?? 0) > 0
    },
    60000,
    500
  )

  // 页面脚本跑完的最后一步就是回报，看到它就说明 WS / 接口 / 下载三件事都做过了
  await waitFor('页面 phase1 回报', async () => reportOf('phase', '1') ?? null, 60000, 400)

  const phase1 = new URLSearchParams(reportOf('phase', '1').query).get('api')
  const phase1Api = JSON.parse(phase1)

  section('A. 采集：事件流 / WebSocket')

  const conns = await waitFor(
    'WS 帧落库',
    async () => {
      const res = await api('GET', '/ws/connections', { query: { limit: 20 } })
      const row = (res.body?.rows ?? []).find((item) => item.url.includes('/ws-probe'))
      return row && row.frames >= 3 ? row : null
    },
    40000,
    400
  )

  const frames = (await api('GET', '/ws', { query: { requestId: conns.requestId, limit: 100, order: 'asc' } })).body
  const sentTruth = origin.wsLog.filter((item) => item.dir === 'in').map((item) => item.data)
  const recvTruth = origin.wsLog.filter((item) => item.dir === 'out').map((item) => item.data)
  const sentGot = (frames?.rows ?? []).filter((row) => row.direction === 'sent').map((row) => row.payload)
  const recvGot = (frames?.rows ?? []).filter((row) => row.direction === 'received').map((row) => row.payload)

  await check('WS 帧条数与服务端双向日志一致（3 帧：1 发 2 收）', async () => {
    assert(sentTruth.length === 1 && recvTruth.length === 2, `真值异常：${JSON.stringify(origin.wsLog)}`)
    assert(
      frames?.rows?.length === sentTruth.length + recvTruth.length,
      `库里有 ${frames?.rows?.length} 帧，服务端记了 ${sentTruth.length + recvTruth.length} 帧`
    )
    assert(conns.frames === frames.rows.length, `connections 汇总 ${conns.frames} vs 明细 ${frames.rows.length}`)
    assert(conns.sent === 1 && conns.received === 2, `汇总发出/收到 = ${conns.sent}/${conns.received}`)
  })

  await check('页面发出的帧逐字等于服务端收到的（方向没标反）', async () => {
    assert(JSON.stringify(sentGot) === JSON.stringify(sentTruth), `库里 ${JSON.stringify(sentGot)} vs 服务端 ${JSON.stringify(sentTruth)}`)
  })

  await check('服务端推的帧逐字等于库里「收到」的那两条', async () => {
    assert(JSON.stringify(recvGot) === JSON.stringify(recvTruth), `库里 ${JSON.stringify(recvGot)} vs 服务端 ${JSON.stringify(recvTruth)}`)
    assert(recvGot[0] === 'server-push-1', `第一条不是握手后主动推的那条：${recvGot[0]}`)
    assert(recvGot[1] === 'echo:hello-from-page', `第二条不是回声：${recvGot[1]}`)
    assert(phase1Api.ok === true && phase1Api.echo.user === 'amy', `页面侧收到的响应不对：${phase1}`)
  })

  await check('每个 WS 帧都有完整 ContentRef，数据库 payload 只是可检索预览', async () => {
    for (const row of frames.rows) {
      assert(row.captureState === 'stored' && /^[a-f0-9]{64}$/.test(row.contentHash), `帧缺少 ContentRef：${JSON.stringify(row)}`)
      assert(existsSync(join(DATA_DIR, 'content', 'manifests', `${row.contentHash}.json`)), `帧 manifest 不存在：${row.contentHash}`)
    }
  })

  await check('WS 生命周期进了事件流（created / handshake / closed）', async () => {
    const res = await api('GET', '/events', { query: { kinds: 'websocket', limit: 100, order: 'asc' } })
    const names = (res.body?.rows ?? []).map((row) => row.detail?.event)
    assert(names.includes('created'), `没有 created：${names.join(',')}`)
    assert(names.includes('handshake'), `没有 handshake：${names.join(',')}`)
    assert(names.includes('closed'), `没有 closed：${names.join(',')}`)
  })

  await check('导航事件带目标 URL，且 url 与真实导航一致', async () => {
    const res = await api('GET', '/events', { query: { kinds: 'navigation', limit: 100, order: 'asc' } })
    const hit = (res.body?.rows ?? []).find((row) => String(row.url ?? '').includes('/realtime.html'))
    assert(hit, `没有指向 realtime.html 的导航事件：${JSON.stringify((res.body?.rows ?? []).map((r) => r.url))}`)
    assert(hit.detail?.mainFrame === true, `主框架标记不对：${JSON.stringify(hit.detail)}`)
  })

  await check('事件流统计与事件行对得上（同一份数据的两个口径）', async () => {
    const stats = (await api('GET', '/events/stats')).body
    const page = (await api('GET', '/events', { query: { limit: 1 } })).body
    assert(stats.total === page.total, `统计 ${stats.total} vs 查询 ${page.total}`)
    assert(stats.latest === page.latest, `latest 不一致：${stats.latest} vs ${page.latest}`)
    const websocketCount = stats.rows.filter((row) => row.kind === 'websocket').reduce((sum, row) => sum + row.count, 0)
    assert(websocketCount >= 3, `websocket 事件数 ${websocketCount}`)
  })
  /* --------------------------------------------------- 契约基线（phase 1） */

  // 基线必须在「phase1 的回报请求也入库了」之后再取。取早了，/api/rt-report 会晚一步
  // 出现，被误报成「新增端点」—— 那是判据的时序问题，不是回归真的看出了变化
  await waitFor(
    'phase1 的 rt-report 入库',
    async () => {
      const res = await api('GET', '/requests', { query: { urlPattern: '/api/rt-report', limit: 5 } })
      return (res.body?.total ?? 0) >= 1
    },
    20000,
    300
  )

  const baseContract = (await api('POST', '/contracts', { body: { label: 'rt-phase1', sampleLimit: 10 } })).body
  await check('契约快照存下来了，且端点数与画像一致', async () => {
    assert(baseContract?.id > 0, `没有 id：${JSON.stringify(baseContract)}`)
    const profiles = (await api('GET', '/endpoints', { query: { limit: 500 } })).body
    assert(baseContract.endpoints === profiles.matched, `快照 ${baseContract.endpoints} 个端点 vs 画像 ${profiles.matched}`)
    assert(baseContract.truncated === false, '快照被截断了，判据不可信')
  })

  /* ------------------------------------------------ phase 2：新字段 + 下载 */

  section('B. 实时性：增量游标与入库延迟')

  const beforeNav = (await api('GET', '/events', { query: { limit: 1, order: 'desc' } })).body
  const since = beforeNav.latest
  const navStart = Date.now()
  await api('POST', '/navigate', { body: { url: `${REAL_PAGE}&phase=2` } })

  const navEvent = await waitFor(
    'phase2 导航事件入库',
    async () => {
      const res = await api('GET', '/events', { query: { since, kinds: 'navigation', limit: 50, order: 'asc' } })
      const hit = (res.body?.rows ?? []).find((row) => String(row.url ?? '').includes('phase=2'))
      return hit ?? null
    },
    20000,
    200
  )
  const navLatency = Date.now() - navStart

  await check(`增量拉取：since 之后的每一条 id 都更大（导航事件入库用了 ${navLatency}ms）`, async () => {
    assert(navEvent.id > since, `事件 id ${navEvent.id} 不大于 since ${since}`)
    const res = await api('GET', '/events', { query: { since, limit: 500, order: 'asc' } })
    const ids = (res.body?.rows ?? []).map((row) => row.id)
    assert(ids.length > 0, 'since 之后一条都没有')
    assert(ids.every((id) => id > since), `有 id <= since 的行：${JSON.stringify(ids)}`)
    assert(ids.every((id, index) => index === 0 || id > ids[index - 1]), `id 不是严格递增：${JSON.stringify(ids)}`)
  })

  await check(`导航到入库的延迟 ${navLatency}ms（要求 < 3000ms）`, async () => {
    assert(navLatency < 3000, `延迟 ${navLatency}ms 太久了`)
  })

  await check('拿一个已经消费过的游标再问，只会拿到新的（不会重复吐）', async () => {
    const latest = (await api('GET', '/events', { query: { limit: 1, order: 'desc' } })).body.latest
    const empty = (await api('GET', '/events', { query: { since: latest, limit: 50 } })).body
    assert(empty.rows.length === 0, `追平之后还回了 ${empty.rows.length} 条`)
    assert(empty.nextSince === latest, `nextSince ${empty.nextSince} vs latest ${latest}`)
  })

  await waitFor('phase2 页面回报', async () => reportOf('phase', '2') ?? null, 40000, 400)
  const phase2 = new URLSearchParams(reportOf('phase', '2').query).get('api')

  await check('phase2 的响应确实多了 bonus 字段（契约回归的靶子）', async () => {
    const parsed = JSON.parse(phase2)
    assert(parsed.bonus?.deep === true, `页面拿到的响应没有 bonus：${phase2}`)
    assert(JSON.parse(phase1).bonus === undefined, 'phase1 不该有 bonus')
  })

  const downloadEvents = async () =>
    (await api('GET', '/events', { query: { kinds: 'download', limit: 50, order: 'asc' } })).body?.rows ?? []

  await waitFor(
    '下载事件入库',
    async () => {
      const rows = await downloadEvents()
      return rows.some((row) => row.detail?.event === 'begin') ? rows : null
    },
    30000,
    400
  )

  await check('下载被记下来了，文件名与页面点的一致，并且走到了 completed', async () => {
    // 下载是异步的：begin/inProgress 先到、completed 后到。这里等它，而不是拿到 begin 就断言
    const done = await waitFor(
      '下载走到 completed',
      async () => (await downloadEvents()).find((row) => row.detail?.event === 'completed') ?? null,
      20000,
      250
    )
    const rows = await downloadEvents()
    const begin = rows.find((row) => row.detail?.event === 'begin')
    assert(begin, `没有 begin 事件：${JSON.stringify(rows)}`)
    assert(begin.detail.filename === DOWNLOAD_NAME, `filename=${begin.detail.filename}`)
    assert(String(begin.url ?? '').includes('/download.txt'), `url=${begin.url}`)
    assert(done.detail.receivedBytes > 0, `completed 的字节数是 ${done.detail.receivedBytes}`)
    assert(done.detail.captureState === 'stored' && /^[a-f0-9]{64}$/.test(done.detail.artifact?.hash), `下载没有归档为 artifact：${JSON.stringify(done.detail)}`)
    assert(done.detail.artifact.size === done.detail.receivedBytes, '下载 artifact 大小与浏览器完成事件不一致')
    assert(done.id > begin.id, `completed(${done.id}) 排在 begin(${begin.id}) 之前`)
  })

  await check(`下载的文件真的落到了磁盘（${downloadPath}）`, async () => {
    await waitFor('下载文件落盘', async () => (existsSync(downloadPath) ? true : null), 15000, 200)
    assert(existsSync(downloadPath), `文件不存在：${downloadPath}`)
    const text = readFileSync(downloadPath, 'utf8')
    assert(text.includes('monitor-download-payload'), `文件内容不对：${text.slice(0, 60)}`)
    assert(statSync(downloadPath).size > 0, '文件是空的')
  })
  /* ------------------------------------------------------------ 接口画像 */

  section('C. 接口画像 / 调用图 / 关联')

  const endpoints = (await api('GET', '/endpoints', { query: { sort: 'calls', minCalls: 1, limit: 500 } })).body
  const echo = (endpoints?.endpoints ?? []).find((item) => isEcho(item.key))

  await check('json-echo 聚成了一个端点，调用次数与页面真实调用次数一致', async () => {
    assert(echo, `画像里没有 json-echo：${JSON.stringify((endpoints?.endpoints ?? []).map((e) => e.key))}`)
    assert(echo.calls >= 2, `调用次数 ${echo.calls}`)
    assert(echo.distinctUrls >= 2, `不同 URL 数 ${echo.distinctUrls}（phase 1/2 的 query 不同）`)
    assert(echo.statuses.some((item) => item.key === '200'), `状态码分布：${JSON.stringify(echo.statuses)}`)
    assert(echo.mimeTypes.some((item) => item.key.includes('application/json')), `MIME：${JSON.stringify(echo.mimeTypes)}`)
  })

  await check('query 参数被画像出来了（token / page 都见过）', async () => {
    const names = echo.query.map((item) => item.name)
    assert(names.includes('token'), `query 字段：${names.join(',')}`)
    assert(names.includes('page'), `query 字段：${names.join(',')}`)
    const token = echo.query.find((item) => item.name === 'token')
    assert(token.values.includes('tk-1'), `token 的取值：${JSON.stringify(token.values)}`)
    assert(token.required === true, 'token 每次都带，应该判成必有')
  })

  await check('请求体字段被画像出来了（user / n，phase2 的 extra 也在且标成可选）', async () => {
    const names = echo.requestBody.fields.map((item) => item.name)
    assert(echo.requestBody.samples >= 2, `请求体样本 ${echo.requestBody.samples}`)
    assert(names.includes('user') && names.includes('n'), `字段：${names.join(',')}`)
    assert(names.includes('extra'), `phase2 的 extra 没被画像出来：${names.join(',')}`)
    assert(echo.requestBody.kinds.some((item) => item.key.includes('json')), `body 类型：${JSON.stringify(echo.requestBody.kinds)}`)
    const extra = echo.requestBody.fields.find((item) => item.name === 'extra')
    assert(extra.required === false, 'extra 只在 phase2 出现，应该判成可选')
  })

  await check('调用节奏算得出来（间隔是真实毫秒数）', async () => {
    assert(echo.rhythm, '没有 rhythm 段')
    assert(Number.isFinite(echo.rhythm.medianGapMs), `medianGapMs=${echo.rhythm.medianGapMs}`)
    assert(Number.isFinite(echo.rhythm.spanMs), `spanMs=${echo.rhythm.spanMs}`)
  })

  const detail = (await api('GET', '/endpoints/detail', { query: { key: echo.key, sampleLimit: 10, callLimit: 50 } })).body

  await check('端点详情能解出响应结构，字段与真实响应体一致', async () => {
    assert(detail?.found === true, `found=${detail?.found} err=${detail?.error}`)
    const paths = (detail.responseFields ?? []).map((item) => item.path)
    assert(paths.includes('ok'), `路径里没有 ok：${paths.join(',')}`)
    assert(paths.includes('name'), `路径里没有 name：${paths.join(',')}`)
    assert(paths.includes('echo.user'), `路径里没有 echo.user：${paths.join(',')}`)
    assert(paths.includes('items[]'), `数组没展开：${paths.join(',')}`)
    assert(paths.includes('meta.source'), `嵌套对象没展开：${paths.join(',')}`)
    assert(paths.includes('bonus.deep'), `phase2 多出来的字段没进结构：${paths.join(',')}`)
    const bonus = detail.responseFields.find((item) => item.path === 'bonus.deep')
    assert(bonus.optional === true, 'bonus 只在 phase2 出现，应该标成非每次都有')
  })

  await check('端点详情里的最近调用与库里的真实调用对得上', async () => {
    assert(detail.recent?.length >= 2, `样本只有 ${detail.recent?.length} 条`)
    assert(detail.recent.every((call) => call.status === 200), JSON.stringify(detail.recent.map((c) => c.status)))
    const rows = (await api('GET', '/requests', { query: { urlPattern: '/api/json-echo', limit: 50 } })).body
    assert(rows.total >= 2, `库里 json-echo 的请求只有 ${rows.total} 条`)
    const known = new Set(rows.rows.map((row) => row.seq))
    for (const call of detail.recent) assert(known.has(call.seq), `样本里的 seq ${call.seq} 在库里查不到`)
  })

  const graph = (await api('GET', '/graph', { query: { maxRows: 20000, maxNodes: 500 } })).body

  await check('调用图里有指向 json-echo 的边，次数与真实调用一致', async () => {
    const edges = (graph?.edges ?? []).filter((edge) => isEcho(edge.to))
    assert(edges.length >= 1, `没有指向 json-echo 的边：${JSON.stringify((graph?.edges ?? []).slice(0, 5))}`)
    const total = edges.reduce((sum, edge) => sum + edge.count, 0)
    assert(total >= 2, `边的总次数 ${total}`)
    assert(graph.nodes.some((node) => node.kind === 'endpoint' && node.key.includes('/api/json-echo')), '节点里没有这个端点')
    assert(graph.scanned > 0, '一行都没扫')
  })

  await check('调用图给出连通分量（功能簇）', async () => {
    assert(Array.isArray(graph?.clusters), '没有 clusters')
    assert(graph.clusters.length >= 1, '一个簇都没有')
    const biggest = graph.clusters[0]
    assert(biggest.size >= 2, `最大的簇只有 ${biggest.size} 个节点`)
    assert(Array.isArray(biggest.nodes) && biggest.nodes.length === biggest.size, '簇的节点数对不上')
  })

  const relations = (await api('GET', '/relations', { query: { maxRows: 20000, limit: 50 } })).body

  await check('关联分析：共享参数里能看到 token=tk-1', async () => {
    const hit = (relations?.sharedParams ?? []).find((item) => item.name === 'token' && item.value === 'tk-1')
    assert(hit, `没有 token=tk-1：${JSON.stringify((relations?.sharedParams ?? []).slice(0, 5))}`)
    assert(hit.count >= 2, `出现次数 ${hit.count}`)
  })

  await check('关联分析：页面跨域取图被关联成「origin 页面 → peer 域」', async () => {
    const frameHost = `127.0.0.1:${origin.port}`
    const host = `127.0.0.1:${peer.port}`
    const rows = relations?.domainLinks ?? []
    const hit = rows.find((item) => item.frameHost === frameHost && item.host === host)
    assert(hit, `没有 ${frameHost} → ${host} 的关联：${JSON.stringify(rows.slice(0, 5))}`)
    assert(hit.count > 0, '次数是 0')
    // 服务端侧真值：peer 确实收到了那次取图，否则上一条只是「库里有条记录」
    assert(peer.requests.some((item) => item.path === '/img1.png'), 'peer 那边没收到取图请求')
    // 同域请求不该被算成关联，否则「关联」就等于「所有请求」
    assert(
      !rows.some((item) => item.host === frameHost),
      `同域请求被算进了关联：${JSON.stringify(rows.filter((item) => item.host === frameHost))}`
    )
  })

  await check('关联分析：重定向链这一路是通的（本次没有跳转时如实为空）', async () => {
    assert(Array.isArray(relations.redirectChains), '没有 redirectChains 段')
    assert(typeof relations.scanned === 'number' && relations.scanned > 0, '扫描行数不对')
  })
  /* ---------------------------------------------------------------- 导出 */

  section('D. 导出（HAR / JSONL / 资源镜像）')

  const requestTotal = (await api('GET', '/requests', { query: { limit: 1 } })).body.total
  const har = (await api('POST', '/export/har', { body: { query: {}, maxRows: 5000, includeBodies: true } })).body

  await check('HAR 导出：文件在、entry 数与库里请求数一致、字节数与文件大小一致', async () => {
    assert(har?.path && existsSync(har.path), `文件不在：${JSON.stringify(har)}`)
    assert(har.truncated === false, '被截断了，判据不可信')
    assert(har.entries === requestTotal, `HAR ${har.entries} 条 vs 库里 ${requestTotal} 条`)
    assert(har.bytes === statSync(har.path).size, '报告的字节数与文件实际大小不符')
  })

  const harJson = JSON.parse(readFileSync(har.path, 'utf8'))

  await check('HAR 结构合法：pages / entries / timings 都在，正文是真响应', async () => {
    assert(harJson.log?.version === '1.2', `version=${harJson.log?.version}`)
    assert(Array.isArray(harJson.log.entries) && harJson.log.entries.length === har.entries, 'entries 数不对')
    assert(Array.isArray(harJson.log.pages) && harJson.log.pages.length >= 1, '没有 pages')
    // 按 json-echo 的「全集」判：phase1 和 phase2 各 3 次，第一条是 phase1（本来就没有 bonus）。
    // 拿第一条去要 bonus 是判据写错了，不是导出错了
    const echoes = harJson.log.entries.filter((item) => isEcho(item.request?.url))
    assert(echoes.length >= 2, `HAR 里 json-echo 只有 ${echoes.length} 条`)
    const entry = echoes[0]
    assert(entry.response.status === 200, `状态码 ${entry.response.status}`)
    assert(
      String(entry.response.content.text).includes('"name":"json-echo"'),
      `HAR 里的正文不是真响应：${String(entry.response.content.text).slice(0, 80)}`
    )
    assert(
      echoes.some((item) => String(item.response.content.text).includes('"bonus"')),
      'HAR 里没有任何一条 json-echo 的正文带 bonus'
    )
    assert(entry.timings && typeof entry.timings.wait === 'number', '没有 timings.wait')
    assert(typeof entry._monitor?.seq === 'number', '没有 _monitor.seq')
  })

  await check('HAR 的请求头里没有 CDP 伪头（:method 之类，DevTools 打开会直接报错）', async () => {
    const bad = []
    for (const entry of harJson.log.entries) {
      for (const header of entry.request.headers ?? []) if (String(header.name).startsWith(':')) bad.push(header.name)
      for (const header of entry.response.headers ?? []) if (String(header.name).startsWith(':')) bad.push(header.name)
    }
    assert(bad.length === 0, `出现了伪头：${[...new Set(bad)].join(',')}`)
  })

  const jsonl = (await api('POST', '/export/jsonl', { body: { query: {}, maxRows: 100000, includeBodies: true } })).body

  await check('JSONL 导出：行数等于库里的请求数，每行都是合法 JSON 且正文是真的', async () => {
    assert(jsonl?.path && existsSync(jsonl.path), `文件不在：${JSON.stringify(jsonl)}`)
    const lines = readFileSync(jsonl.path, 'utf8').split('\n').filter(Boolean)
    assert(lines.length === jsonl.lines, `报告 ${jsonl.lines} 行 vs 实际 ${lines.length} 行`)
    assert(lines.length === requestTotal, `${lines.length} 行 vs 库里 ${requestTotal} 条`)
    const parsed = lines.map((line) => JSON.parse(line))
    const hits = parsed.filter((row) => isEcho(row.url))
    assert(hits.length >= 2, `JSONL 里 json-echo 只有 ${hits.length} 条`)
    assert(
      hits.some((row) => String(row.responseBody ?? '').includes('"name":"json-echo"')),
      'JSONL 里的正文不是真响应'
    )
    assert(hits.some((row) => String(row.responseBody ?? '').includes('"bonus"')), 'JSONL 里没有带 bonus 的那几次')
  })

  const mirror = (await api('POST', '/export/bodies', { body: { query: {}, maxRows: 20000, includeBodies: true } })).body

  await check('资源镜像：manifest 可解析，落盘的正文与真实响应逐字一致', async () => {
    assert(mirror?.manifest && existsSync(mirror.manifest), `manifest 不在：${JSON.stringify(mirror)}`)
    const manifest = JSON.parse(readFileSync(mirror.manifest, 'utf8'))
    assert(manifest.files === mirror.files, `manifest.files ${manifest.files} vs 报告 ${mirror.files}`)
    assert(mirror.files > 0, '一个文件都没落')
    // 镜像按「正文指纹」分文件：两轮调用的正文不一样，就该是两份文件
    const entries = manifest.entries.filter((item) => item.urls.some((url) => isEcho(url)))
    assert(entries.length >= 2, `manifest 里 json-echo 的响应体只有 ${entries.length} 份`)
    const texts = entries.map((item) => {
      const file = join(mirror.dir, item.file)
      assert(existsSync(file), `文件不在：${file}`)
      return readFileSync(file, 'utf8')
    })
    for (const text of texts) {
      assert(text.includes('"name":"json-echo"'), `落盘的正文不对：${text.slice(0, 80)}`)
    }
    const joined = texts.join('\n')
    assert(joined.includes('"user":"amy"') && joined.includes('"user":"bob"'), `两轮调用的正文没都采到：${joined.slice(0, 160)}`)
    assert(joined.includes('"bonus"'), 'phase2 的 bonus 字段没落盘')
  })

  /* ------------------------------------------------------------ 契约回归 */

  section('E. 契约回归（phase1 基线 vs 现在）')

  const diff = (await api('GET', `/contracts/${baseContract.id}/diff`, { query: { sampleLimit: 10 } })).body

  await check('回归能看出新字段：bonus.deep 被标成「响应结构新增」', async () => {
    assert(diff?.summary, `没有 summary：${JSON.stringify(diff).slice(0, 200)}`)
    assert(diff.summary.newResponseFields.some((item) => item.includes('bonus.deep')), `新字段：${JSON.stringify(diff.summary.newResponseFields)}`)
    const changed = diff.changed.find((item) => item.key.includes('/api/json-echo'))
    assert(changed, `changed 里没有 json-echo：${JSON.stringify(diff.changed.map((i) => i.key))}`)
    assert(changed.response.added.some((item) => item.path === 'bonus.deep'), `response.added=${JSON.stringify(changed.response.added)}`)
    assert(changed.response.removed.length === 0, `不该有消失的字段：${JSON.stringify(changed.response.removed)}`)
  })

  await check('回归能看出新请求字段：extra', async () => {
    assert(diff.summary.newRequestFields.some((item) => item.includes('extra')), `新请求字段：${JSON.stringify(diff.summary.newRequestFields)}`)
  })

  await check('回归不误报：没有端点消失，新增的只可能是下载那条 URL', async () => {
    assert(diff.summary.removedEndpoints === 0, `报了 ${diff.summary.removedEndpoints} 个端点消失：${JSON.stringify(diff.summary.removedEndpointKeys)}`)
    assert(
      diff.added.every((item) => item.key.includes('/download.txt')),
      `冒出了意料之外的新端点：${JSON.stringify(diff.added.map((i) => i.key))}`
    )
    assert(diff.summary.changedEndpoints >= 1, '一个变化都没看出来')
  })

  await check('契约能列出来、能删掉（删掉之后列表里就没有了）', async () => {
    const list = (await api('GET', '/contracts')).body
    assert((list.rows ?? []).some((item) => item.id === baseContract.id), '列表里没有刚存的快照')
    const removed = (await api('DELETE', `/contracts/${baseContract.id}`)).body
    assert(removed?.deleted === 1, `删除返回 ${JSON.stringify(removed)}`)
    const after = (await api('GET', '/contracts')).body
    assert(!(after.rows ?? []).some((item) => item.id === baseContract.id), '删了还在')
  })
  /* -------------------------------------------------------------- 对话框 */

  section('F. JS 对话框：记录 + 应答（不应答页面就卡住）')

  const beforeDialog = (await api('GET', '/events', { query: { limit: 1, order: 'desc' } })).body
  await api('POST', '/navigate', { body: { url: `${BASE}/dialog.html` } })

  const opened = await waitFor(
    '对话框打开事件入库',
    async () => {
      const res = await api('GET', '/events', { query: { since: beforeDialog.latest, kinds: 'dialog', limit: 20, order: 'asc' } })
      return (res.body?.rows ?? []).find((row) => row.detail?.event === 'opened') ?? null
    },
    20000,
    300
  )

  await check('对话框被记下来了（类型与文案都是页面里那一个）', async () => {
    assert(opened.detail.type === 'alert', `type=${opened.detail.type}`)
    assert(opened.detail.message === 'monitor-dialog-probe', `message=${opened.detail.message}`)
    assert(opened.level === 'warn', `level=${opened.level}`)
  })

  await check('页面此刻确实卡住了（外部证据：它还没回报）', async () => {
    assert(!reportOf('dialog', 'dismissed'), '页面已经回报过了 —— 那这条判据就不是在验「卡住」')
  })

  const handled = (await api('POST', '/dialog', { body: { accept: true } })).body

  await check('放行之后页面继续跑（页面自己回报了，origin 侧的真值）', async () => {
    assert(handled?.ok === true, `应答失败：${JSON.stringify(handled)}`)
    await waitFor('页面回报 dialog=dismissed', async () => reportOf('dialog', 'dismissed') ?? null, 15000, 300)
  })

  await check('对话框关闭事件也进了事件流，且排在打开那条之后', async () => {
    const closed = await waitFor(
      '对话框关闭事件入库',
      async () => {
        const res = await api('GET', '/events', { query: { kinds: 'dialog', limit: 50, order: 'asc' } })
        return (res.body?.rows ?? []).find((row) => row.detail?.event === 'closed') ?? null
      },
      15000,
      300
    )
    assert(closed.detail.result === true, `result=${closed.detail.result}`)
    assert(closed.id > opened.id, `closed(${closed.id}) 不在 opened(${opened.id}) 之后`)
  })

  /* -------------------------------------------------- 三条入口读的是同一份 */

  section('G. 三入口一致（HTTP API / MCP）')

  const mcpChild = spawn(process.execPath, [MCP], {
    cwd: ROOT,
    env: { ...process.env, MONITOR_DATA_DIR: DATA_DIR },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  mcp = new Mcp(mcpChild)
  await mcp.send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'rt', version: '0' } })
  mcp.notify('notifications/initialized', {})

  const tools = await mcp.send('tools/list', {})
  await check('MCP 列出了分析层的全部工具', async () => {
    const names = (tools?.tools ?? []).map((tool) => tool.name)
    for (const needed of [
      'monitor_events',
      'monitor_event_stats',
      'monitor_ws_frames',
      'monitor_ws_connections',
      'monitor_endpoints',
      'monitor_endpoint',
      'monitor_graph',
      'monitor_relations',
      'monitor_export_har',
      'monitor_export_jsonl',
      'monitor_collect_resources',
      'monitor_contract_snapshot',
      'monitor_contract_diff',
      'monitor_dialog'
    ]) {
      assert(names.includes(needed), `缺少工具 ${needed}`)
    }
  })

  await check('monitor_events 与 GET /events 逐字一致', async () => {
    let same = false
    let lastBoth = null
    for (let attempt = 0; attempt < 3 && !same; attempt += 1) {
      const http = (await api('GET', '/events', { query: { limit: 5, order: 'asc' } })).body
      const viaMcp = await mcp.call('monitor_events', { limit: 5, order: 'asc' })
      same = JSON.stringify(viaMcp) === JSON.stringify(http)
      lastBoth = { viaMcp, http }
      if (!same) await sleep(600)
    }
    assert(same, `两边不一致：${JSON.stringify(lastBoth).slice(0, 300)}`)
  })

  await check('monitor_endpoints 与 GET /endpoints 逐字一致', async () => {
    const http = (await api('GET', '/endpoints', { query: { sort: 'calls', limit: 20 } })).body
    const viaMcp = await mcp.call('monitor_endpoints', { sort: 'calls', limit: 20 })
    assert(JSON.stringify(viaMcp) === JSON.stringify(http), '两边不一致')
  })

  await check('monitor_ws_frames 与 GET /ws 逐字一致（含 requestId 过滤）', async () => {
    const http = (await api('GET', '/ws', { query: { requestId: conns.requestId, limit: 10, order: 'asc' } })).body
    const viaMcp = await mcp.call('monitor_ws_frames', { requestId: conns.requestId, limit: 10, order: 'asc' })
    assert(JSON.stringify(viaMcp) === JSON.stringify(http), '两边不一致')
  })

  await check('monitor_contract_snapshot 也能存快照（写路径同样一致）', async () => {
    const snap = await mcp.call('monitor_contract_snapshot', { label: 'rt-via-mcp' })
    assert(snap?.id > 0, JSON.stringify(snap).slice(0, 200))
    const list = (await api('GET', '/contracts')).body
    assert(
      (list.rows ?? []).some((item) => item.id === snap.id && item.label === 'rt-via-mcp'),
      `HTTP 侧看不到 MCP 存的快照：${JSON.stringify(list).slice(0, 200)}`
    )
    const viaMcp = await mcp.call('monitor_contracts', {})
    assert(Array.isArray(viaMcp.rows) && viaMcp.rows.length > 0, `MCP 侧不是非空数组：${JSON.stringify(viaMcp).slice(0, 200)}`)
    assert(Array.isArray(list.rows) && list.rows.length > 0, `HTTP 侧不是非空数组：${JSON.stringify(list).slice(0, 200)}`)
    assert(JSON.stringify(viaMcp.rows) === JSON.stringify(list.rows), '契约列表两边不一致')
    assert(viaMcp.total === list.total && list.total === list.rows.length, `total 对不上：${viaMcp.total} / ${list.total} / ${list.rows.length}`)
  })

  await check('SSE 通道推得动事件（GET /events/stream 真有 data 帧）', async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    try {
      const res = await fetch(`http://127.0.0.1:${endpoint.port}/events/stream?interval=200&since=0`, {
        headers: { authorization: `Bearer ${endpoint.token}` },
        signal: controller.signal
      })
      assert(res.status === 200, `status=${res.status}`)
      assert(String(res.headers.get('content-type')).includes('text/event-stream'), 'content-type 不对')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let text = ''
      while (!text.includes('event: events')) {
        const chunk = await reader.read()
        if (chunk.done) break
        text += decoder.decode(chunk.value, { stream: true })
      }
      assert(text.includes('event: events'), `没收到事件帧：${text.slice(0, 200)}`)
      const at = text.indexOf('event: events')
      const payload = JSON.parse(text.slice(text.indexOf('data: ', at) + 6).split('\n')[0])
      assert(Array.isArray(payload.rows) && payload.rows.length > 0, 'data 里没有事件')
      await reader.cancel()
    } finally {
      clearTimeout(timer)
    }
  })
  /* ------------------------------------------------------------------ UI */

  section('H. 界面：四个新面板真的渲染出行')

  const target = await waitControlTarget(CDP_PORT, 30000)
  assert(target, '拿不到控制窗口的调试目标')
  cdp = await openCdp(target.webSocketDebuggerUrl)

  const evaluate = async (expression) => {
    const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? '求值异常')
    return res.result.value
  }

  const uiCount = async (selector, timeoutMs = 25000) => {
    const deadline = Date.now() + timeoutMs
    let last = null
    while (Date.now() < deadline) {
      try {
        const value = await evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
        last = value
        if (typeof value === 'number' && value > 0) return value
      } catch (err) {
        last = `error: ${err.message}`
      }
      await sleep(400)
    }
    throw new Error(`等不到 ${selector} 渲染出行（最后：${last}）`)
  }

  const switchTab = async (tab) => {
    await evaluate(`location.search = '?tab=${tab}'`)
    await sleep(1500)
  }

  await check('事件流面板：游标拉到的行真的画出来了', async () => {
    await switchTab('events')
    const rows = await uiCount('.ev-row')
    assert(rows > 0, `行数 ${rows}`)
    const picked = await evaluate(`document.querySelector('.pane-pick')?.value`)
    assert(picked === 'events', `窗格里选的不是事件流：${picked}`)
  })

  await check('WebSocket 面板：连接与帧都画出来了', async () => {
    await switchTab('ws')
    const connCount = await uiCount('.ws-conn')
    assert(connCount > 0, `连接数 ${connCount}`)
    await evaluate(`document.querySelector('.ws-conn')?.click()`)
    const frameCount = await uiCount('.ws-frame')
    assert(frameCount > 0, `帧数 ${frameCount}`)
  })

  await check('接口画像面板：端点行与详情都画出来了（详情里含响应结构）', async () => {
    await switchTab('endpoints')
    const rows = await uiCount('.ep-row')
    assert(rows > 0, `端点数 ${rows}`)
    await evaluate(
      `Array.from(document.querySelectorAll('.ep-row')).find((el) => el.textContent.includes('json-echo'))?.click()`
    )
    await uiCount('.ep-profile')
    const text = await evaluate(`document.querySelector('.ep-profile')?.textContent ?? ''`)
    assert(text.includes('响应结构'), `详情里没有响应结构段：${text.slice(0, 120)}`)
  })

  await check('调用图面板：边与功能簇都画出来了', async () => {
    await switchTab('graph')
    const edges = await uiCount('.gph-edge')
    assert(edges > 0, `边数 ${edges}`)
    const clusters = await uiCount('.gph-cluster')
    assert(clusters > 0, `簇数 ${clusters}`)
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
    cdp?.close()
  } catch {
    /* 已经断了 */
  }
  try {
    app.kill()
  } catch {
    /* 已经退了 */
  }
  try {
    await origin.close()
  } catch {
    /* 已经关了 */
  }
  try {
    await peer?.close()
  } catch {
    /* 已经关了 */
  }
  try {
    rmSync(downloadPath, { force: true })
  } catch {
    /* 没有就算了 */
  }
  await sleep(1000)
  cleanupStray()
  if (process.env['RT_KEEP'] !== '1') {
    try {
      rmSync(DATA_DIR, { recursive: true, force: true })
    } catch {
      /* Windows 上偶尔删不掉 */
    }
  }
}

const passed = results.filter((item) => item.ok).length
console.log(`\n== 结果 ==\n  ${passed}/${results.length} 通过`)
if (appLog.includes('MONITOR_SUMMARY')) console.log('  应用正常收工')
process.exit(results.every((item) => item.ok) ? 0 : 1)
