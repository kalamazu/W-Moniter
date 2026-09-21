#!/usr/bin/env node
/**
 * 打包版验收（站点资源）：dist/win-unpacked/ChromiumMonitor.exe 里能不能真管 cookie 与站点存储。
 *
 * 用户实际双击的是这个 exe，所以「源码跑得通」不算数。这里起真 exe、指到受控 origin，
 * 只用 HTTP API + MCP + 渲染进程那条路从外面验：cookie 罐对账、站点存储扫描、双向写、
 * 无条件删被拒、快照增删、MCP 与 HTTP 逐字一致、站点资源面板真的在打包后的 bundle 里。
 *
 *   node work/verify-packaged-sitedata.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startOrigin } from '../scripts/test-origin.mjs'
import { openCdp, waitControlTarget, ROOT } from '../scripts/app-harness.mjs'
import { McpClient } from '../scripts/mcp-client.mjs'

const EXE = join(ROOT, 'dist', 'win-unpacked', 'ChromiumMonitor.exe')
const ORIGIN_PORT = 8851
const CDP_PORT = 9750
const API_PORT = 9751
const HOST = '127.0.0.1'

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

const dataDir = mkdtempSync(join(tmpdir(), 'pkgsd-'))
const quitFile = join(dataDir, 'quit')
const origin = await startOrigin(ORIGIN_PORT)
const BASE = `http://127.0.0.1:${origin.port}`
const PAGE = `${BASE}/sitedata.html`
console.log(`打包版：${EXE}`)
console.log(`数据目录：${dataDir}`)
console.log(`受控 origin：${BASE}`)

const app = spawn(EXE, ['--no-sandbox', `--remote-debugging-port=${CDP_PORT}`], {
  detached: true,
  stdio: 'ignore',
  env: {
    ...process.env,
    MONITOR_DATA_DIR: dataDir,
    MONITOR_URL: PAGE,
    MONITOR_PROFILE: 'L',
    MONITOR_UI_TAB: 'sites',
    MONITOR_AUTO_QUIT_MS: '300000',
    MONITOR_QUIT_FILE: quitFile,
    MONITOR_CAPTURE_BODIES: '1',
    MONITOR_CAPTURE_SCRIPTS: '1',
    MONITOR_API_PORT: String(API_PORT)
  }
})
app.unref()

async function waitFor(label, fn, timeoutMs = 90000, intervalMs = 400) {
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
async function inPage(expression) {
  const res = await api('POST', '/evaluate', { expression })
  assert(res.status === 200 && res.body?.ok === true, `evaluate 没通：${JSON.stringify(res.body)?.slice(0, 200)}`)
  return res.body.value
}
let mcp = null
let cdp = null
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
      return res.body?.state === 'connected' && (res.body?.requestCount ?? 0) > 0
    },
    120000,
    500
  )

  const phase1 = await waitFor(
    '页面 phase1 回报',
    async () => {
      const hit = origin.requests.find((item) => item.path === '/api/sitedata-report')
      if (!hit) return null
      const info = new URLSearchParams(hit.query ?? '').get('info')
      return info ? JSON.parse(info) : null
    },
    120000,
    400
  )
  console.log(`\n== 打包版：站点资源 ==`)
  await check('受控页面自己确认：六块存储都真写进去了', async () => {
    assert(phase1.storage === 'ok', `storage=${phase1.storage}`)
    assert(phase1.idb === 'ok', `idb=${phase1.idb}`)
    assert(phase1.cache === 'ok', `cache=${phase1.cache}`)
    assert(phase1.sw === 'ok', `sw=${phase1.sw}`)
  })

  /* ------------------------------------------------- A. cookie 罐对账 */
  const jar = await waitFor(
    'sd_js 进罐',
    async () => {
      const res = await api('GET', '/cookies?name=sd_js&limit=20')
      return (res.body?.rows ?? [])[0] ?? null
    },
    60000,
    500
  )
  await check('cookie 罐对账：页面写的 cookie，打包版读得回来（值/域/路径/key 口径）', async () => {
    assert(jar.value === 'C1', `value=${jar.value}`)
    assert(jar.domain === HOST, `domain=${jar.domain}`)
    assert(jar.path === '/', `path=${jar.path}`)
    assert(String(jar.key).includes('|sd_js|'), `key 口径不对：${jar.key}`)
  })

  /* ------------------------------------------------- B. 站点存储：点了才扫 */
  const scan = await api('POST', '/sites/scan', { origin: BASE, cookies: false })
  await check('POST /sites/scan：真去浏览器里扫了一遍并落了库', async () => {
    assert(scan.status === 200, `status=${scan.status}`)
    const origins = scan.body?.origins ?? scan.body?.scanned ?? []
    assert(Array.isArray(origins), `scan 返回形状不对：${JSON.stringify(scan.body).slice(0, 160)}`)
  })

  const detail = await waitFor(
    '受控域明细',
    async () => {
      const res = await api('GET', `/sites/detail?origin=${encodeURIComponent(BASE)}`)
      return res.body?.origin ? res.body : null
    },
    60000,
    600
  )
  await check('GET /sites/detail：localStorage / sessionStorage 的键值逐条对得上', async () => {
    const local = Object.fromEntries((detail.localStorage ?? []).map((item) => [item.key, item.value]))
    const session = Object.fromEntries((detail.sessionStorage ?? []).map((item) => [item.key, item.value]))
    assert(local.sd_alpha === 'A1', `localStorage.sd_alpha=${local.sd_alpha}`)
    assert(local.sd_beta === 'B1', `localStorage.sd_beta=${local.sd_beta}`)
    assert(session.sd_sess === 'S1', `sessionStorage.sd_sess=${session.sd_sess}`)
  })
  await check('GET /sites/detail：IndexedDB / 缓存 / Service Worker 都在册', async () => {
    assert((detail.idb ?? []).some((db) => db.name === 'sd_db'), `idb=${JSON.stringify((detail.idb ?? []).map((d) => d.name))}`)
    assert((detail.caches ?? []).some((cache) => cache.name === 'sd_cache'), `caches=${JSON.stringify((detail.caches ?? []).map((c) => c.name))}`)
    assert((detail.serviceWorkers ?? []).length >= 1, `sw=${JSON.stringify(detail.serviceWorkers)}`)
    assert((detail.usageBytes ?? 0) > 0, `usageBytes=${detail.usageBytes}`)
  })

  /* ------------------------------------------------- C. 双向写 + 删要带条件 */
  const written = await api('POST', '/cookies', { name: 'pkg_site', value: 'PK1', domain: HOST, path: '/' })
  await check('POST /cookies 写的那条，页面 document.cookie 立刻读得到（双向）', async () => {
    assert(written.status === 200 && written.body?.ok === true, `返回=${JSON.stringify(written.body).slice(0, 160)}`)
    const seen = await waitFor(
      '页面里出现 pkg_site',
      async () => {
        const value = await inPage("document.cookie.indexOf('pkg_site=PK1') >= 0")
        return value ? true : null
      },
      30000,
      400
    )
    assert(seen === true, '页面里没读到新写的 cookie')
  })
  await check('DELETE /cookies 一个条件都不给 → 必须被拒（防手滑清空整个罐）', async () => {
    const res = await api('DELETE', '/cookies')
    assert(res.status === 200, `status=${res.status}（应用层拒绝应是 200 + ok:false）`)
    assert(res.body?.ok === false && res.body?.deleted === 0, `返回=${JSON.stringify(res.body).slice(0, 160)}`)
  })
  await check('DELETE /cookies?name= → 删掉之后罐里和页面里都没有了', async () => {
    const res = await api('DELETE', `/cookies?name=pkg_site&domain=${HOST}`)
    assert(res.body?.deleted === 1, `deleted=${res.body?.deleted}`)
    const out = await waitFor(
      '罐里不再有 pkg_site',
      async () => {
        const got = await api('GET', '/cookies?name=pkg_site')
        return (got.body?.rows ?? []).length === 0 ? true : null
      },
      30000,
      500
    )
    assert(out === true, '罐里还有 pkg_site')
    assert((await inPage("document.cookie.indexOf('pkg_site') < 0")) === true, '页面里还有 pkg_site')
  })

  /* ------------------------------------------------- D. 画像 + 快照 */
  await check('GET /cookies/stats：分类之和等于总数（数字自洽）', async () => {
    const res = await api('GET', '/cookies/stats')
    const stats = res.body ?? {}
    assert(stats.total > 0, `total=${stats.total}`)
    assert(stats.session + stats.persistent === stats.total, `session=${stats.session} persistent=${stats.persistent} total=${stats.total}`)
  })
  await check('快照：拍一份 → 列表里有 → 删得掉', async () => {
    const made = await api('POST', '/sites/snapshots', { label: 'pkg-baseline' })
    assert(made.status === 200 && made.body?.id > 0, `拍快照返回=${JSON.stringify(made.body).slice(0, 160)}`)
    const list = await api('GET', '/sites/snapshots')
    assert((list.body?.rows ?? []).some((row) => row.id === made.body.id), '列表里没有刚拍的那份')
    const diff = await api('GET', `/sites/snapshots/${made.body.id}/diff`)
    assert(diff.status === 200 && diff.body?.summary, `diff 返回=${JSON.stringify(diff.body).slice(0, 160)}`)
    const gone = await api('DELETE', `/sites/snapshots/${made.body.id}`)
    assert(gone.body?.deleted === 1, `deleted=${gone.body?.deleted}`)
  })

  /* ------------------------------------------------- E. MCP 与 HTTP 同源 */
  mcp = McpClient.spawn(process.execPath, [join(ROOT, 'mcp', 'server.mjs'), `--url=http://127.0.0.1:${endpoint.port}?token=${endpoint.token}`], {
    cwd: ROOT
  })
  await mcp.initialize('packaged-sitedata')
  await check('MCP monitor_cookies 与 HTTP /cookies 逐字一致', async () => {
    const http = await api('GET', '/cookies?name=sd_js&limit=20')
    const viaMcp = await mcp.callJson('monitor_cookies', { name: 'sd_js', limit: 20 })
    assert(JSON.stringify(viaMcp) === JSON.stringify(http.body), '两条路结果不一致')
  })
  await check('MCP monitor_site_detail 与 HTTP 逐字一致', async () => {
    const http = await api('GET', `/sites/detail?origin=${encodeURIComponent(BASE)}`)
    const viaMcp = await mcp.callJson('monitor_site_detail', { origin: BASE })
    assert(JSON.stringify(viaMcp) === JSON.stringify(http.body), '两条路结果不一致')
  })

  /* ------------------------------------------------- F. 打包后的渲染层 */
  const target = await waitControlTarget(CDP_PORT, 120000)
  cdp = await openCdp(target.webSocketDebuggerUrl)
  const evaluate = async (expression) => {
    const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? '求值异常')
    return res.result.value
  }
  await check('渲染层：站点资源面板真的在打包产物里（?tab=sites 生效 + 左侧域列表有行）', async () => {
    const ok = await waitFor(
      '站点资源面板渲染',
      async () => {
        const out = await evaluate(
          "(() => { const panel = document.querySelector('.sp-panel'); if (!panel) return null; return { panel: true, origins: document.querySelectorAll('.sp-origin').length }; })()"
        )
        return out?.panel ? out : null
      },
      30000,
      500
    )
    assert(ok.panel === true, '面板没渲染出来')
    assert(ok.origins >= 1, `左侧域列表是空的：origins=${ok.origins}`)
  })
  cdp.close()
  cdp = null
} catch (err) {
  console.log(`\n验收中断：${err.message}`)
  results.push({ name: '主流程', ok: false, message: err.message })
} finally {
  try {
    mcp?.close()
  } catch {
    /* 已经退了 */
  }
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
console.log(`\n== 打包版站点资源结果 ==\n  ${passed}/${results.length} 通过`)
process.exit(results.every((item) => item.ok) ? 0 : 1)