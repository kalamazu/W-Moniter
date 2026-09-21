#!/usr/bin/env node
/**
 * 打包版验收：dist/win-unpacked/ChromiumMonitor.exe 里的**实时分析面**能不能用。
 *
 * 源码跑得通不等于产物跑得通（资源要真的进包、渲染层的四个新面板要在 bundle 里）。
 * 所以这里起真 exe、指到受控 origin、只用 HTTP API + CDP 从外部验：
 *   事件流 / WebSocket / 接口画像 / 调用图 / 关联 / 契约回归 / 导出 / 导出下载口 / SSE，
 * 再从渲染进程读栏头下拉框，确认四个新面板真的在。
 *
 *   node work/verify-packaged-analysis.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startOrigin } from '../scripts/test-origin.mjs'
import { openCdp, waitControlTarget } from '../scripts/app-harness.mjs'
import { ROOT } from '../scripts/app-harness.mjs'

const EXE = join(ROOT, 'dist', 'win-unpacked', 'ChromiumMonitor.exe')
const ORIGIN_PORT = 8831
const CDP_PORT = 9735
const API_PORT = 9736

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

if (!existsSync(EXE)) {
  console.log(`FAIL 没有打包产物：${EXE}（先 npm run dist:win）`)
  process.exit(1)
}

const dataDir = mkdtempSync(join(tmpdir(), 'pkgrt-'))
const quitFile = join(dataDir, 'quit')
const origin = await startOrigin(ORIGIN_PORT)
const BASE = `http://127.0.0.1:${origin.port}`
console.log(`打包版：${EXE}`)
console.log(`数据目录：${dataDir}`)
console.log(`受控 origin：${BASE}`)

const app = spawn(EXE, ['--no-sandbox', `--remote-debugging-port=${CDP_PORT}`], {
  detached: true,
  stdio: 'ignore',
  env: {
    ...process.env,
    MONITOR_DATA_DIR: dataDir,
    MONITOR_URL: `${BASE}/`,
    MONITOR_PROFILE: 'L',
    MONITOR_AUTO_QUIT_MS: '240000',
    MONITOR_QUIT_FILE: quitFile,
    MONITOR_CAPTURE_BODIES: '1',
    MONITOR_API_PORT: String(API_PORT)
  }
})
app.unref()

async function waitFor(label, fn, timeoutMs = 60000, intervalMs = 400) {
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
    if (Date.now() > deadline) throw new Error(`等不到 ${label}（最后：${JSON.stringify(last)?.slice(0, 200)}）`)
    await sleep(intervalMs)
  }
}
let endpoint = null
async function api(method, path, body) {
  const url = new URL(path, `http://127.0.0.1:${endpoint.port}`)
  const headers = { authorization: `Bearer ${endpoint.token}` }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await res.text()
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = { _raw: text.slice(0, 200) }
  }
  return { status: res.status, body: parsed }
}

try {
  const infoPath = join(dataDir, 'control.json')
  endpoint = await waitFor(
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
    120000,
    500
  )
  console.log(`控制服务：127.0.0.1:${endpoint.port}`)

  await waitFor(
    '打包版连上内核并有流量',
    async () => {
      const res = await api('GET', '/status')
      return res.body?.state === 'connected' && (res.body?.requestCount ?? 0) > 30
    },
    120000,
    500
  )

  console.log('\n== 打包版：实时分析面 ==')

  await check('GET /health：打包版的控制服务活着', async () => {
    const res = await fetch(`http://127.0.0.1:${endpoint.port}/health`)
    const body = await res.json()
    assert(res.status === 200 && body.ok === true && body.upstream === true, JSON.stringify(body).slice(0, 160))
  })

  await check('GET /events：事件流水 + 增量游标', async () => {
    const res = await api('GET', '/events?limit=20&order=asc')
    assert(res.status === 200, `status=${res.status}`)
    assert(Array.isArray(res.body.rows) && res.body.rows.length > 0, `rows=${res.body.rows?.length}`)
    assert(typeof res.body.nextSince === 'number', `nextSince=${res.body.nextSince}`)
    const nav = res.body.rows.find((row) => row.kind === 'navigation')
    assert(nav, `没有导航事件：${JSON.stringify(res.body.rows.map((r) => r.kind))}`)
  })

  await check('GET /events/stats：按 kind 分组', async () => {
    const res = await api('GET', '/events/stats')
    assert(res.status === 200 && typeof res.body.total === 'number' && res.body.total > 0, JSON.stringify(res.body).slice(0, 160))
  })

  await check('GET /ws/connections：连接汇总（这次没有 WS，如实为空数组）', async () => {
    const res = await api('GET', '/ws/connections')
    assert(res.status === 200 && Array.isArray(res.body.rows), JSON.stringify(res.body).slice(0, 160))
  })

  await check('GET /endpoints：接口画像聚出了端点', async () => {
    const res = await api('GET', '/endpoints?limit=20&sort=calls')
    assert(res.status === 200 && Array.isArray(res.body.endpoints), JSON.stringify(res.body).slice(0, 160))
    assert(res.body.endpoints.length > 0, '一个端点都没有')
    assert(res.body.endpoints[0].calls >= 1, `第一个端点 calls=${res.body.endpoints[0].calls}`)
  })

  const epList = await api('GET', '/endpoints?limit=20&sort=calls')
  await check('GET /endpoints/detail：端点详情带响应结构', async () => {
    const key = epList.body.endpoints[0].key
    const res = await api('GET', `/endpoints/detail?key=${encodeURIComponent(key)}&sampleLimit=2`)
    assert(res.status === 200 && res.body.found === true, JSON.stringify(res.body).slice(0, 200))
    assert(Array.isArray(res.body.responseFields), '没有 responseFields 段')
  })

  await check('GET /graph：调用图（节点 / 边 / 功能簇）', async () => {
    const res = await api('GET', '/graph?maxRows=20000')
    assert(res.status === 200, `status=${res.status}`)
    assert(Array.isArray(res.body.nodes) && res.body.nodes.length > 0, `nodes=${res.body.nodes?.length}`)
    assert(Array.isArray(res.body.edges) && res.body.edges.length > 0, `edges=${res.body.edges?.length}`)
    assert(Array.isArray(res.body.clusters) && res.body.clusters.length > 0, '一个功能簇都没有')
  })

  await check('GET /relations：四类关联都在', async () => {
    const res = await api('GET', '/relations?limit=10&maxRows=20000')
    assert(res.status === 200, `status=${res.status}`)
    for (const key of ['sharedBodies', 'redirectChains', 'domainLinks', 'sharedParams']) {
      assert(Array.isArray(res.body[key]), `${key} 不是数组`)
    }
  })

  await check('POST /contracts + diff：契约回归这一路通', async () => {
    const snap = await api('POST', '/contracts', { label: 'pkg-baseline', sampleLimit: 3 })
    assert(snap.status === 200 && snap.body.id > 0, JSON.stringify(snap.body).slice(0, 200))
    const list = await api('GET', '/contracts?limit=50')
    assert(Array.isArray(list.body.rows) && list.body.rows.some((row) => row.id === snap.body.id), '列表里没有刚存的快照')
    assert(list.body.total === list.body.rows.length, `total=${list.body.total} vs ${list.body.rows.length}`)
    const one = await api('GET', `/contracts/${snap.body.id}`)
    assert(one.status === 200 && one.body.found === true, JSON.stringify(one.body).slice(0, 160))
    const diff = await api('GET', `/contracts/${snap.body.id}/diff?sampleLimit=3`)
    assert(diff.status === 200 && diff.body.summary, JSON.stringify(diff.body).slice(0, 200))
    assert(diff.body.summary.removedEndpoints === 0, `报了 ${diff.body.summary.removedEndpoints} 个端点消失`)
    const gone = await api('DELETE', `/contracts/${snap.body.id}`)
    assert(gone.status === 200 && gone.body.deleted === 1, JSON.stringify(gone.body).slice(0, 160))
  })

  const har = await api('POST', '/export/har', { includeBodies: true, maxRows: 500 })
  await check('POST /export/har：HAR 真的落到磁盘（DevTools 能打开的形状）', async () => {
    assert(har.status === 200 && har.body.path && existsSync(har.body.path), JSON.stringify(har.body).slice(0, 200))
    assert(har.body.entries > 0, `entries=${har.body.entries}`)
    const doc = JSON.parse(readFileSync(har.body.path, 'utf8'))
    assert(doc.log?.version === '1.2', `version=${doc.log?.version}`)
    assert(doc.log.entries.length === har.body.entries, 'entries 数与文件对不上')
  })

  await check('POST /export/jsonl：行数与报告一致', async () => {
    const res = await api('POST', '/export/jsonl', { includeBodies: true, maxRows: 500 })
    assert(res.status === 200 && res.body.path && existsSync(res.body.path), JSON.stringify(res.body).slice(0, 200))
    const lines = readFileSync(res.body.path, 'utf8').split('\n').filter(Boolean)
    assert(lines.length === res.body.lines, `报告 ${res.body.lines} 行 vs 实际 ${lines.length} 行`)
  })

  await check('POST /export/bodies：资源镜像 + manifest', async () => {
    const res = await api('POST', '/export/bodies', { maxRows: 500 })
    assert(res.status === 200 && res.body.manifest && existsSync(res.body.manifest), JSON.stringify(res.body).slice(0, 200))
    assert(res.body.files > 0, `files=${res.body.files}`)
  })

  await check('GET /exports/download：取回导出文件（只认纯文件名）', async () => {
    const name = String(har.body.path).split(/[\\/]/).pop()
    const okRes = await fetch(`http://127.0.0.1:${endpoint.port}/exports/download?name=${encodeURIComponent(name)}`, {
      headers: { authorization: `Bearer ${endpoint.token}` }
    })
    assert(okRes.status === 200, `status=${okRes.status}`)
    const buf = Buffer.from(await okRes.arrayBuffer())
    assert(buf.length === har.body.bytes, `${buf.length} vs ${har.body.bytes}`)
    const badRes = await fetch(`http://127.0.0.1:${endpoint.port}/exports/download?name=..%2F..%2Fcontrol.json`, {
      headers: { authorization: `Bearer ${endpoint.token}` }
    })
    assert(badRes.status === 400, `越界路径应该 400，实际 ${badRes.status}`)
  })

  await check('GET /events/stream：SSE 真推得动事件', async () => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10000)
    try {
      const res = await fetch(`http://127.0.0.1:${endpoint.port}/events/stream?interval=400&since=0`, {
        headers: { authorization: `Bearer ${endpoint.token}` },
        signal: ctrl.signal
      })
      assert(res.status === 200, `status=${res.status}`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let text = ''
      while (!text.includes('event: events') && text.length < 300000) {
        const chunk = await reader.read()
        if (chunk.done) break
        text += decoder.decode(chunk.value, { stream: true })
      }
      await reader.cancel()
      assert(text.includes('event: events'), `没收到事件帧：${text.slice(0, 160)}`)
    } finally {
      clearTimeout(timer)
    }
  })

  /* 渲染层：四个新面板必须在打包后的 bundle 里 */
  const target = await waitControlTarget(CDP_PORT, 60000)
  const cdp = await openCdp(target.webSocketDebuggerUrl)
  const evaluate = async (expression) => {
    const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? '求值异常')
    return res.result.value
  }
  // 每一栏各有一个 .pane-pick（默认两栏），所以按「栏」读，再逐栏比对候选清单
  const readsPicks = () =>
    evaluate(
      "Array.from(document.querySelectorAll('.pane-pick')).map((s) => Array.from(s.options).map((o) => o.textContent))"
    )
  const picks = await waitFor(
    '栏头下拉框挂上',
    async () => {
      const list = await readsPicks()
      return Array.isArray(list) && list.length > 0 && list[0].length > 0 ? list : null
    },
    30000,
    500
  )
  await check(`渲染层：十五个面板都在（${picks.length} 栏，每栏 ${picks[0].length} 项）`, async () => {
    for (const name of ['事件流', 'WebSocket', '接口画像', '调用图', '站点资源']) {
      assert(picks[0].includes(name), `下拉框里少了「${name}」：${picks[0].join('/')}`)
    }
    assert(picks[0].length === 15, `第一栏面板数=${picks[0].length}`)
    for (const [index, list] of picks.entries()) {
      assert(list.length === 15, `第 ${index + 1} 栏的候选数=${list.length}`)
      assert(list.join('|') === picks[0].join('|'), `第 ${index + 1} 栏与第一栏的候选清单不一致`)
    }
  })
  cdp.close()
} catch (err) {
  console.log(`\n验收中断：${err.message}`)
  results.push({ name: '主流程', ok: false, message: err.message })
} finally {
  // 体面收工：写 quit 文件让应用自己关（顺带收掉它拉起的 Chrome）
  try {
    writeFileSync(quitFile, 'quit')
  } catch {
    /* 没有就算了 */
  }
  await sleep(4000)
  try {
    origin.close()
  } catch {
    /* 已经关了 */
  }
}

const passed = results.filter((item) => item.ok).length
console.log(`\n== 打包版结果 ==\n  ${passed}/${results.length} 通过`)
process.exit(results.every((item) => item.ok) ? 0 : 1)