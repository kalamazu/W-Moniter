#!/usr/bin/env node
/**
 * 站点资源验收：cookie 罐 / 站点存储 / 缓存 / SW / 快照 / 三条入口同源。
 *
 * 这一面最容易被写成「自己说自己对」：写进去、读回来、两边都是我们自己的代码。
 * 所以这里的判据全都往外看：
 *   - 受控 origin 的请求日志（页面自己回报的那份真值）
 *   - 页面上下文里读回来的 document.cookie（浏览器侧的真相）
 *   - 浏览器自己维护的 usable/quota 数字
 * 我们存的、我们扫的、页面上真有的，这三份必须对得上。
 *
 *   node scripts/test-sitedata.mjs
 */
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { startOrigin } from './test-origin.mjs'
import { openCdp, waitControlTarget } from './app-harness.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const MCP = join(ROOT, 'mcp', 'server.mjs')
const CLEANUP = join(ROOT, 'scripts', 'cleanup-stray.ps1')

const ORIGIN_PORT = Number(process.env['SD_ORIGIN_PORT'] ?? 8841)
const CDP_PORT = Number(process.env['SD_CDP_PORT'] ?? 9740)
const API_PORT = Number(process.env['SD_API_PORT'] ?? 9741)
const DATA_DIR = process.env['SD_DATA_DIR'] ?? join(ROOT, `.userdata/sitedata-${Date.now()}`)

const HOST = '127.0.0.1'
let mcp = null
let cdp = null
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
    parsed = { raw: text.slice(0, 200) }
  }
  return { status: res.status, body: parsed }
}

/** 在受控页面里求值（走控制器那条路，不是我们自己去连 CDP） */
async function inPage(expression) {
  const res = await api('POST', '/evaluate', { body: { expression } })
  assert(res.status === 200, `evaluate 没通：${res.status}`)
  assert(res.body?.ok === true, `页面里求值失败：${JSON.stringify(res.body).slice(0, 200)}`)
  return res.body.value
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

/**
 * 跨站面的小服务。绑在 all-interfaces 上，这样 localhost 与 127.0.0.1 都连得上 ——
 * 「跨站」这件事本身就需要两个不同的站点，而受控 origin 只绑了 127.0.0.1。
 */
function startCrossSiteServer() {
  const hits = []
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    hits.push({ path: url.pathname, query: url.search, cookie: req.headers.cookie ?? '', at: Date.now() })
    if (url.pathname === '/crosssite.html') {
      const target = url.searchParams.get('target') ?? ''
      const report = url.searchParams.get('report') ?? ''
      const html =
        '<!doctype html><html><head><meta charset="utf-8"><title>cross</title></head><body>' +
        '<div id="out">running</div>' +
        '<script>' +
        '(async () => {' +
        '  const out = {};' +
        '  try {' +
        '    const res = await fetch(' + JSON.stringify(target) + ", { credentials: 'include', cache: 'no-store' });" +
        '    out.status = res.status;' +
        '  } catch (err) { out.error = String(err); }' +
        '  out.cookie = document.cookie;' +
        '  try { await fetch(' + JSON.stringify(report) + " + '?info=' + encodeURIComponent(JSON.stringify(out)), { cache: 'no-store' }); } catch (err) {}" +
        "  document.getElementById('out').textContent = 'done';" +
        '})()' +
        '<\/script></body></html>'
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end('{"ok":true}')
  })
  return new Promise((resolve) => {
    server.listen(0, () =>
      resolve({
        port: server.address().port,
        hits,
        close: () => new Promise((done) => server.close(() => done()))
      })
    )
  })
}
console.log('== 站点资源验收（cookie 罐 / 站点存储 / 缓存 / SW / 快照 / 三入口同源） ==')

mkdirSync(DATA_DIR, { recursive: true })
const origin = await startOrigin(ORIGIN_PORT)
const BASE = `http://127.0.0.1:${origin.port}`
const PAGE = `${BASE}/sitedata.html`
const cross = await startCrossSiteServer()
console.log(`  受控 origin: ${BASE}`)
console.log(`  跨站 origin: http://localhost:${cross.port}`)
console.log(`  数据目录: ${DATA_DIR}`)

const app = spawn(ELECTRON, ['out/main/index.js', '--no-sandbox', `--remote-debugging-port=${CDP_PORT}`], {
  cwd: ROOT,
  env: {
    ...process.env,
    MONITOR_DATA_DIR: DATA_DIR,
    MONITOR_URL: PAGE,
    MONITOR_PROFILE: 'L',
    MONITOR_UI_TAB: 'sites',
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


try {
  /* ---------------------------------------------------------------- 起场 */
  const infoPath = join(DATA_DIR, 'control.json')
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
    90000,
    400
  )

  await waitFor(
    '控制器连上并有流量',
    async () => {
      const res = await api('GET', '/status')
      return res.body?.state === 'connected' && (res.body?.requestCount ?? 0) > 0
    },
    90000,
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
    90000,
    400
  )

  await check('页面自己确认：六块存储都真写进去了（origin 侧看到的真值）', async () => {
    assert(phase1.storage === 'ok', `localStorage / sessionStorage / cookie：${phase1.storage}`)
    assert(phase1.idb === 'ok', `IndexedDB：${phase1.idb}`)
    assert(phase1.cache === 'ok', `CacheStorage：${phase1.cache}`)
    assert(phase1.sw === 'ok', `Service Worker：${phase1.sw}`)
    assert(phase1.setCookie === 'ok', `带 Set-Cookie 的响应：${phase1.setCookie}`)
  })

  /* ================================================================ A. cookie 罐 */
  section('A. cookie 罐：浏览器是权威，我们只做对账')

  const firstSeen = await waitFor(
    'sd_js 进罐',
    async () => {
      const res = await api('GET', '/cookies', { query: { name: 'sd_js', limit: 20 } })
      return (res.body?.rows ?? [])[0] ?? null
    },
    40000,
    500
  )

  await check('页面 document.cookie 写的那条，罐里读得回来（值 / 域 / 路径逐字一致）', async () => {
    assert(firstSeen.value === 'C1', `value=${firstSeen.value}`)
    assert(firstSeen.domain === HOST, `domain=${firstSeen.domain}`)
    assert(firstSeen.path === '/', `path=${firstSeen.path}`)
    assert(String(firstSeen.key).includes('|sd_js|'), `key 口径不对：${firstSeen.key}`)
    assert(firstSeen.changeCount === 1, `第一次见到就该是 1，实际 ${firstSeen.changeCount}`)
  })

  await check('Set-Cookie 那条：事件流里有 kind=cookie 的 added，且归因到响应 URL', async () => {
    const hit = await waitFor(
      'sd_http 的 cookie 事件',
      async () => {
        const res = await api('GET', '/events', { query: { kinds: 'cookie', limit: 300, order: 'asc' } })
        return (
          (res.body?.rows ?? []).find(
            (row) => row.detail?.name === 'sd_http' && row.detail?.action === 'added'
          ) ?? null
        )
      },
      40000,
      500
    )
    assert(String(hit.url ?? '').includes('/api/sd-set-cookie'), `归因到的 url 不对：${hit.url}`)
    assert(hit.detail.source === 'set-cookie', `source=${hit.detail.source}`)
    assert(hit.detail.value === 'H1', `value=${hit.detail.value}`)
  })

  await check('页面改值 → 罐里跟着变，changeCount 从 1 涨到 2（看得出「被改过」）', async () => {
    await inPage("document.cookie = 'sd_js=C2; path=/'; 'ok'")
    const after = await waitFor(
      'sd_js 变成 C2',
      async () => {
        const res = await api('GET', '/cookies', { query: { name: 'sd_js', limit: 20 } })
        const row = (res.body?.rows ?? [])[0]
        return row && row.value === 'C2' && row.changeCount >= 2 ? row : null
      },
      40000,
      500
    )
    assert(after.changeCount === 2, `changeCount=${after.changeCount}`)
    const events = (await api('GET', '/events', { query: { kinds: 'cookie', limit: 300, order: 'asc' } })).body
    const changed = (events?.rows ?? []).find((row) => row.detail?.name === 'sd_js' && row.detail?.action === 'changed')
    assert(changed, `事件流里没有 sd_js 的 changed：${JSON.stringify((events?.rows ?? []).map((r) => r.detail?.name + ':' + r.detail?.action))}`)
  })

  await check('cookie 画像的分类之和等于总数、总量大于 0（数字自洽）', async () => {
    const stats = (await api('GET', '/cookies/stats')).body
    assert(stats.total > 0, `total=${stats.total}`)
    assert(stats.session + stats.persistent === stats.total, `会话 ${stats.session} + 持久 ${stats.persistent} ≠ ${stats.total}`)
    assert(stats.totalBytes > 0, `totalBytes=${stats.totalBytes}`)
    assert(stats.bySameSite.reduce((sum, row) => sum + row.count, 0) === stats.total, 'SameSite 分组之和 ≠ 总数')
  })

  /* ================================================================ B. 站点存储 */
  section('B. 站点存储：点了才扫，每块逐个对得上')

  const scan = await api('POST', '/sites/scan', { body: { origin: BASE, limit: 5 } })
  await check('POST /sites/scan：扫到受控域，cookie 罐也顺手对了一次账', async () => {
    assert(scan.status === 200, `status=${scan.status}`)
    assert(scan.body?.ok === true, JSON.stringify(scan.body).slice(0, 200))
    assert((scan.body.origins ?? []).includes(BASE), `origins=${JSON.stringify(scan.body.origins)}`)
    assert(scan.body.cookies.total > 0, `cookie 罐对账后是空的：${JSON.stringify(scan.body.cookies)}`)
  })

  const overview = await api('GET', '/sites', { query: { limit: 100 } })
  await check('GET /sites：受控域标着「已扫」，各计数不为零', async () => {
    const row = (overview.body?.rows ?? []).find((item) => item.origin === BASE)
    assert(row, `清单里没有受控域：${JSON.stringify((overview.body?.rows ?? []).map((item) => item.origin)).slice(0, 200)}`)
    assert(row.scanned === true, `扫过了却标着没扫（updatedAt=${row.updatedAt}）`)
    assert(row.cookieCount > 0, `cookieCount=${row.cookieCount}`)
    assert(row.localStorageCount >= 2, `localStorageCount=${row.localStorageCount}`)
    assert(row.idbNames.includes('sd_db'), `idbNames=${JSON.stringify(row.idbNames)}`)
    assert(row.cacheNames.includes('sd_cache'), `cacheNames=${JSON.stringify(row.cacheNames)}`)
    assert(row.swCount >= 1, `swCount=${row.swCount}`)
  })

  const detailRes = await api('GET', '/sites/detail', { query: { origin: BASE } })
  const detail = detailRes.body
  await check('GET /sites/detail：localStorage / sessionStorage 的键值逐条对得上', async () => {
    assert(detailRes.status === 200 && detail?.origin === BASE, JSON.stringify(detail).slice(0, 200))
    const local = new Map((detail.localStorage ?? []).map((row) => [row.key, row.value]))
    const sess = new Map((detail.sessionStorage ?? []).map((row) => [row.key, row.value]))
    assert(local.get('sd_alpha') === 'A1', `sd_alpha=${local.get('sd_alpha')}`)
    assert(local.get('sd_beta') === 'B1', `sd_beta=${local.get('sd_beta')}`)
    assert(sess.get('sd_sess') === 'S1', `sd_sess=${sess.get('sd_sess')}`)
    assert((detail.cookies ?? []).length > 0, '明细里没有 cookie')
  })

  await check('IndexedDB 的库与 object store 结构对得上', async () => {
    const db = (detail.idb ?? []).find((item) => item.name === 'sd_db')
    assert(db, `没有 sd_db：${JSON.stringify((detail.idb ?? []).map((item) => item.name))}`)
    const store = (db.objectStores ?? []).find((item) => item.name === 'items')
    assert(store, `没有 items：${JSON.stringify(db.objectStores)}`)
    assert(store.keyPath === 'id', `keyPath=${store.keyPath}`)
  })

  await check('CacheStorage 里有 sd_cache，缓存条目的 URL 就是取过的那条', async () => {
    const cache = (detail.caches ?? []).find((item) => item.name === 'sd_cache')
    assert(cache, `没有 sd_cache：${JSON.stringify((detail.caches ?? []).map((item) => item.name))}`)
    assert(cache.count >= 1, `count=${cache.count}`)
    assert(
      (cache.entries ?? []).some((entry) => String(entry.url).includes('/api/sd-asset')),
      `条目里没有 /api/sd-asset：${JSON.stringify(cache.entries).slice(0, 240)}`
    )
  })

  await check('Service Worker 注册在册（scope 是站点根）', async () => {
    const live = (detail.serviceWorkers ?? []).filter((item) => !item.isDeleted)
    assert(live.length >= 1, `没有活的注册：${JSON.stringify(detail.serviceWorkers).slice(0, 240)}`)
    assert(
      live.some((item) => String(item.scopeURL ?? '').startsWith(BASE + '/')),
      `scope 不对：${JSON.stringify(live.map((item) => item.scopeURL))}`
    )
  })

  await check('用量与配额读得出来（这条要带 session 才问得到）', async () => {
    assert(typeof detail.usageBytes === 'number' && detail.usageBytes > 0, `usageBytes=${detail.usageBytes}`)
    assert(typeof detail.quotaBytes === 'number' && detail.quotaBytes > 0, `quotaBytes=${detail.quotaBytes}`)
    assert(detail.usageBytes <= detail.quotaBytes, `用量比配额还大：${detail.usageBytes} > ${detail.quotaBytes}`)
  })  /* ================================================================ C. 写与删 */
  section('C. 写与删：从我们这边写，页面读得到；删要带条件')

  await check('POST /cookies 写的 cookie，页面 document.cookie 立刻读得到（双向）', async () => {
    const res = await api('POST', '/cookies', { body: { name: 'sd_written', value: 'W1', url: BASE + '/' } })
    assert(res.status === 200 && res.body?.ok === true, JSON.stringify(res.body).slice(0, 200))
    const seen = await waitFor(
      '页面读到 sd_written=W1',
      async () => {
        const out = await inPage("document.cookie.indexOf('sd_written=W1') >= 0")
        return out === true ? true : null
      },
      20000,
      400
    )
    assert(seen === true, '页面没读到我们写进去的那条')
  })

  await check('DELETE /cookies 一个条件都不给 → 必须被拒（防手滑清空整个罐）', async () => {
    const res = await api('DELETE', '/cookies')
    assert(res.body?.ok === false, `居然放行了：${JSON.stringify(res.body).slice(0, 200)}`)
    assert(res.body?.deleted === 0, `说有拒绝，却删了 ${res.body?.deleted} 条`)
    const jar = await api('GET', '/cookies', { query: { limit: 50 } })
    assert((jar.body?.rows ?? []).length > 0, '整个罐被清空了')
  })

  await check('DELETE /cookies?name=：删掉之后罐里和页面里都没有了', async () => {
    const res = await api('DELETE', '/cookies', { query: { name: 'sd_written' } })
    assert(res.status === 200, `status=${res.status}`)
    assert(res.body?.deleted >= 1, JSON.stringify(res.body).slice(0, 200))
    const left = await api('GET', '/cookies', { query: { name: 'sd_written', limit: 20 } })
    assert((left.body?.rows ?? []).length === 0, `罐里还剩 ${(left.body?.rows ?? []).length} 条`)
    const gone = await inPage("document.cookie.indexOf('sd_written') < 0")
    assert(gone === true, '页面里还读得到已删的 cookie')
  })

  /* ================================================================ D. 快照回归 */
  section('D. 快照：拍一份 → 改点东西 → diff 看得出来')

  const snapBase = await api('POST', '/sites/snapshots', { body: { label: 'sd-before' } })
  const snapId = snapBase.body?.id
  await check('POST /sites/snapshots：拍之前会先扫一遍（cookie 数不为零）', async () => {
    assert(snapBase.status === 200 && snapId > 0, JSON.stringify(snapBase.body).slice(0, 200))
    assert(snapBase.body.cookies > 0, `快照里 cookie=${snapBase.body.cookies}`)
  })

  await check('改动之后的 diff：新增的 localStorage 键与 cookie 都点得出来', async () => {
    await inPage("localStorage.setItem('sd_gamma', 'G1'); 'ok'")
    await inPage("document.cookie = 'sd_delta=D1; path=/'; 'ok'")
    await waitFor(
      'sd_delta 进罐',
      async () => {
        const res = await api('GET', '/cookies', { query: { name: 'sd_delta', limit: 20 } })
        return (res.body?.rows ?? []).length > 0 ? true : null
      },
      40000,
      500
    )
    const scan2 = await api('POST', '/sites/scan', { body: { origin: BASE, limit: 5 } })
    assert(scan2.body?.ok === true, JSON.stringify(scan2.body).slice(0, 200))

    const diff = (await api('GET', `/sites/snapshots/${snapId}/diff`)).body
    assert(diff?.summary, JSON.stringify(diff).slice(0, 240))
    assert(diff.summary.keysAdded >= 1, `keysAdded=${diff.summary.keysAdded}`)
    assert((diff.localStorage?.added ?? []).some((key) => String(key).includes('sd_gamma')), `localStorage.added=${JSON.stringify(diff.localStorage?.added)}`)
    assert(diff.summary.cookiesAdded >= 1, `cookiesAdded=${diff.summary.cookiesAdded}`)
    assert(diff.summary.originsRemoved === 0, `报了 ${diff.summary.originsRemoved} 个域消失`)
  })

  await check('DELETE /sites/snapshots/:id：删掉快照', async () => {
    const res = await api('DELETE', `/sites/snapshots/${snapId}`)
    assert(res.status === 200 && res.body?.deleted === 1, JSON.stringify(res.body).slice(0, 200))
    const list = (await api('GET', '/sites/snapshots')).body
    assert(!(list?.rows ?? []).some((row) => row.id === snapId), '删完还在列表里')
  })

  /* ================================================================ E. 清空 */
  section('E. 清空：清完必须真的空（返回的就是清完之后的真相）')

  await check('POST /sites/clear all：清完重扫，六块都空了', async () => {
    const res = await api('POST', '/sites/clear', { body: { origin: BASE, types: ['all'] } })
    assert(res.status === 200 && res.body?.ok === true, JSON.stringify(res.body).slice(0, 200))
    const after = await waitFor(
      '清完之后的明细',
      async () => {
        const one = await api('GET', '/sites/detail', { query: { origin: BASE } })
        const d = one.body
        if (d?.origin !== BASE) return null
        if ((d.localStorage ?? []).length > 0) return null
        if ((d.caches ?? []).length > 0) return null
        if ((d.serviceWorkers ?? []).filter((item) => !item.isDeleted).length > 0) return null
        if ((d.idb ?? []).length > 0) return null
        return d
      },
      40000,
      500
    )
    assert((after.sessionStorage ?? []).length === 0, `sessionStorage 还剩 ${after.sessionStorage.length} 条`)
    const jar = await api('GET', '/cookies', { query: { domain: HOST, limit: 50 } })
    assert((jar.body?.rows ?? []).length === 0, `cookie 罐里还剩 ${(jar.body?.rows ?? []).length} 条`)
  })

  /* ================================================================ F. 跨站 */
  section('F. 跨站使用：被带去别的站的 cookie 认得出来，也删得掉')

  const crossOk = await (async () => {
    await api('POST', '/cookies', {
      body: { name: 'sd_third', value: 'T1', url: BASE + '/', secure: true, sameSite: 'None' }
    })
    await api('POST', '/cookies', { body: { name: 'sd_home', value: 'H9', url: BASE + '/' } })
    const target = BASE + '/api/sd-asset?from=cross'
    const crossPage = `http://localhost:${cross.port}/crosssite.html?target=${encodeURIComponent(target)}&report=${encodeURIComponent('/report')}`
    const nav = await api('POST', '/navigate', { body: { url: crossPage } })
    assert(nav.status === 200, `navigate 没通：${nav.status}`)
    const hit = await waitFor(
      '跨站页面回报',
      async () => cross.hits.find((item) => item.path === '/report') ?? null,
      40000,
      400
    )
    const info = JSON.parse(new URLSearchParams(hit.query ?? '').get('info') ?? '{}')
    return info
  })()

  await check('跨站的请求真的把 127.0.0.1 的 cookie 带出去了（origin 侧看到 Cookie 头）', async () => {
    const sent = origin.requests.filter(
      (item) => item.path === '/api/sd-asset' && String(item.query ?? '').includes('from=cross')
    )
    assert(sent.length >= 1, `受控 origin 没收到那次跨站请求（页面回报：${JSON.stringify(crossOk).slice(0, 200)}）`)
    const cookieHeader = String(sent[0].cookie ?? '')
    assert(cookieHeader.includes('sd_third=T1'), `带出去的 cookie 里没有 sd_third：${cookieHeader || '(空)'}`)
    // 反向对照：没标 SameSite=None 的那条不该被带出去（浏览器就是这么办的，不是我说的）
    assert(!cookieHeader.includes('sd_home'), `同域的 Lax cookie 不该跨站发出去：${cookieHeader}`)
  })

  await check('罐里把 sd_third 标成「跨站使用过」，同域的 sd_home 没被标', async () => {
    // 「带出去了」这件事要等轮询那趟把它冲进库（5s 一回），所以先等再断言
    const third = await waitFor(
      'sd_third 标成跨站',
      async () => {
        const res = await api('GET', '/cookies', { query: { name: 'sd_third', limit: 20 } })
        const row = (res.body?.rows ?? [])[0]
        return row?.crossSite === true ? row : null
      },
      40000,
      500
    )
    assert(third.sentCount >= 1, `sentCount=${third.sentCount}`)
    assert((third.sentHosts ?? []).includes('localhost'), `sentHosts=${JSON.stringify(third.sentHosts)}`)
    const stats = (await api('GET', '/cookies/stats')).body
    assert(stats.crossSite >= 1, `crossSite=${stats.crossSite}`)
    const home = (await api('GET', '/cookies', { query: { name: 'sd_home', limit: 20 } })).body
    const homeRow = (home?.rows ?? [])[0]
    assert(homeRow && homeRow.crossSite === false, `sd_home 被误标成跨站：${JSON.stringify(homeRow)}`)
  })

  await check('DELETE /cookies?crossSite=1：只删跨站的，本域的留着', async () => {
    const res = await api('DELETE', '/cookies', { query: { crossSite: 1 } })
    assert(res.status === 200, `status=${res.status}`)
    assert(res.body?.deleted >= 1, JSON.stringify(res.body).slice(0, 200))
    const third = await api('GET', '/cookies', { query: { name: 'sd_third', limit: 20 } })
    assert((third.body?.rows ?? []).length === 0, '跨站那条没被删掉')
    const home = await api('GET', '/cookies', { query: { name: 'sd_home', limit: 20 } })
    assert((home.body?.rows ?? []).length === 1, '本域那条被误删了')
  })  /* ================================================================ G. 同源 */
  section('G. 三条入口读的是同一份：HTTP 与 MCP 逐字比对')

  const mcpChild = spawn(process.execPath, [MCP, `--data-dir=${DATA_DIR}`], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] })
  mcp = new Mcp(mcpChild)
  await mcp.send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'sitedata', version: '0' }
  })
  mcp.notify('notifications/initialized', {})

  await check('monitor_cookies 与 GET /cookies 逐字一致', async () => {
    const http = (await api('GET', '/cookies', { query: { limit: 20 } })).body
    const viaMcp = await mcp.call('monitor_cookies', { limit: 20 })
    assert(JSON.stringify(viaMcp) === JSON.stringify(http), `两边不一致：\n  mcp=${JSON.stringify(viaMcp).slice(0, 240)}\n  http=${JSON.stringify(http).slice(0, 240)}`)
  })

  await check('monitor_sites 与 GET /sites 逐字一致', async () => {
    const http = (await api('GET', '/sites', { query: { limit: 50 } })).body
    const viaMcp = await mcp.call('monitor_sites', { limit: 50 })
    assert(JSON.stringify(viaMcp) === JSON.stringify(http), `两边不一致：\n  mcp=${JSON.stringify(viaMcp).slice(0, 240)}\n  http=${JSON.stringify(http).slice(0, 240)}`)
  })

  await check('monitor_site_detail 与 GET /sites/detail 逐字一致', async () => {
    const http = (await api('GET', '/sites/detail', { query: { origin: BASE } })).body
    const viaMcp = await mcp.call('monitor_site_detail', { origin: BASE })
    assert(JSON.stringify(viaMcp) === JSON.stringify(http), '两边不一致')
  })

  await check('monitor_site_scan 走 MCP 也真扫得动', async () => {
    const out = await mcp.call('monitor_site_scan', { origin: BASE, limit: 5 })
    assert(out?.ok === true && (out.origins ?? []).includes(BASE), JSON.stringify(out).slice(0, 200))
  })

  /* ================================================================ H. 面板 */
  section('H. 站点资源面板：库里的东西真画出来了')

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
        if (typeof value === 'number' && value > 0) return value
        last = value
      } catch (err) {
        last = `error: ${err.message}`
      }
      await sleep(400)
    }
    return last
  }

  await check('面板是站点资源那个（URL 的 ?tab=sites 生效）', async () => {
    const picked = await evaluate(`document.querySelector('.pane-pick')?.value`)
    assert(picked === 'sites', `窗格里选的不是站点资源：${picked}`)
  })

  await check('左列表把扫过的域画出来了', async () => {
    const rows = await uiCount('.sp-origin')
    assert(typeof rows === 'number' && rows > 0, `行数 ${rows}`)
  })

  await check('点一个域 → 出现页签与明细（不是空白）', async () => {
    await evaluate(`document.querySelector('.sp-origin')?.click()`)
    const tabs = await uiCount('.sp-tabs .tab')
    assert(tabs > 0, `页签数 ${tabs}`)
    const body = await uiCount('.sp-body')
    assert(body > 0, `明细区没出来：${body}`)
  })

  await check('切到「快照」页签：表格与「拍快照」按钮都在', async () => {
    await evaluate(
      `Array.from(document.querySelectorAll('.sp-tabs .tab')).find((el) => el.textContent.includes('快照'))?.click()`
    )
    const table = await uiCount('.sp-table')
    assert(table > 0, `快照表格没出来：${table}`)
    const hasButton = await evaluate(
      `Array.from(document.querySelectorAll('.sp-bar .tab')).some((el) => el.textContent.includes('拍快照'))`
    )
    assert(hasButton === true, '顶栏没有「拍快照」')
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
    await cross.close()
  } catch {
    /* 已经关了 */
  }
  await sleep(1000)
  cleanupStray()
  if (process.env['SD_KEEP'] !== '1') {
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