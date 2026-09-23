#!/usr/bin/env node
/**
 * P1 验收：采集完整率。
 *
 * 真值来自受控 origin 自己的 access log —— 不依赖任何 CDP 机制，
 * 所以它和监控库的差异就是货真价实的漏抓。
 *
 *   node scripts/verify-completeness.mjs
 *
 * 判据（设计文档 §12）：漏抓率 < 1%。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { startOrigin } from './test-origin.mjs'

process.removeAllListeners('warning')
process.on('warning', () => {})

const ROOT = dirname(fileURLToPath(import.meta.url)) + '/..'
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

const LEAK_BUDGET = 0.01
/** 静默判定：连续这么久没有新请求，就认为页面跑完了 */
const QUIET_MS = 2500
const MAX_WAIT_MS = 90_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readEnvValue(text, key) {
  const match = new RegExp(key + '\\s+(\\{.*\\})').exec(text)
  if (!match) return null
  try {
    return JSON.parse(match[1])
  } catch {
    return null
  }
}

function multiset(entries) {
  const counts = new Map()
  for (const key of entries) counts.set(key, (counts.get(key) ?? 0) + 1)
  return counts
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'monitor-verify-'))
  const dbPath = join(dataDir, 'monitor.db')
  const quitFile = join(dataDir, 'quit')
  const outFile = join(dataDir, 'app.log')

  const origin = await startOrigin(0)
  const url = `http://127.0.0.1:${origin.port}/`
  console.log(`受控 origin: ${url}`)
  console.log(`数据目录: ${dataDir}\n`)

  const out = []
  const child = spawn(ELECTRON, ['out/main/index.js', '--no-sandbox'], {
    cwd: ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      MONITOR_URL: url,
      MONITOR_DATA_DIR: dataDir,
      MONITOR_HEADLESS: '1',
      MONITOR_QUIT_FILE: quitFile
    }
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    out.push(chunk)
    process.stdout.write(chunk)
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => process.stderr.write(chunk))

  // 等到 origin 和数据库都不再增长，再让应用收工
  const deadline = Date.now() + MAX_WAIT_MS
  let lastOrigin = -1
  let lastDb = -1
  let quietSince = 0

  while (Date.now() < deadline) {
    await sleep(400)
    let dbCount = 0
    if (existsSync(dbPath)) {
      try {
        const db = new DatabaseSync(dbPath)
        dbCount = db.prepare('SELECT COUNT(*) AS n FROM requests').get().n
        db.close()
      } catch {
        dbCount = lastDb
      }
    }
    if (origin.requests.length !== lastOrigin || dbCount !== lastDb) {
      lastOrigin = origin.requests.length
      lastDb = dbCount
      quietSince = Date.now()
    } else if (quietSince && Date.now() - quietSince >= QUIET_MS) {
      break
    }
  }

  const settled = Date.now() < deadline
  console.log(
    settled
      ? '\n流量已静默，触发收工…'
      : `\n等待超时（${MAX_WAIT_MS}ms），强制收工…`
  )
  writeFileSync(quitFile, 'quit')

  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 25_000)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
  if (!exited) {
    child.kill()
    console.log('应用没有按时退出，已强制结束')
  }
  await origin.close()

  writeFileSync(outFile, out.join(''))

  /* ---------------------------------------------------------- 比对 */

  if (!existsSync(dbPath)) {
    console.error('\n失败：没有生成数据库文件')
    process.exit(1)
  }

  const db = new DatabaseSync(dbPath)
  const rows = db.prepare('SELECT method, url, status, resource_type, body_state FROM requests').all()
  const instance = db.prepare('SELECT * FROM instances ORDER BY id DESC LIMIT 1').get()
  const bodyStats = db
    .prepare(
      'SELECT COUNT(*) AS n, COALESCE(SUM(body_size), 0) AS bytes, ' +
        "SUM(CASE WHEN body_state = 'stored' THEN 1 ELSE 0 END) AS stored FROM requests"
    )
    .get()
  db.close()

  // 只比 origin 自己服务过的路径 —— favicon 之类浏览器自动发起的也算，
  // 因为服务端同样记了账，不去人为豁免任何一条。
  const serverKeys = origin.requests.map((r) => `${r.method} ${r.path}`)
  const cdpKeys = rows.map((r) => {
    let pathname = r.url
    try {
      pathname = new URL(r.url).pathname
    } catch {
      /* 非 http 协议原样比对 */
    }
    return `${r.method} ${pathname}`
  })

  const serverCounts = multiset(serverKeys)
  const cdpCounts = multiset(cdpKeys)

  let missingTotal = 0
  const missing = []
  for (const [key, serverCount] of serverCounts) {
    const cdpCount = cdpCounts.get(key) ?? 0
    if (cdpCount < serverCount) {
      const gap = serverCount - cdpCount
      missingTotal += gap
      missing.push({ key, server: serverCount, cdp: cdpCount, gap })
    }
  }

  let extraTotal = 0
  const extra = []
  for (const [key, cdpCount] of cdpCounts) {
    const serverCount = serverCounts.get(key) ?? 0
    if (cdpCount > serverCount) {
      extraTotal += cdpCount - serverCount
      extra.push({ key, cdp: cdpCount, server: serverCount })
    }
  }

  missing.sort((a, b) => b.gap - a.gap)
  extra.sort((a, b) => b.cdp - a.cdp)

  const serverTotal = serverKeys.length
  const leakRate = serverTotal === 0 ? 1 : missingTotal / serverTotal

  /*
   * 只比「origin 记的 = 库里有的」是不够的。
   *
   * 页面里的 Service Worker 如果被挂在 waitForDebugger 上没放行，它的
   * install 处理器根本不会跑：/api/sw-install、/api/through-sw 谁都没发出，
   * origin 和库里同时是 0，漏抓率照样 0.00% —— 报表全绿，页面其实是半死的。
   * 所以还要盯住「页面本该发出的请求」确实发出去了。
   */
  const REQUIRED_PATHS = ['/api/sw-install', '/api/through-sw', '/worker-data.json']
  const originPaths = new Set(origin.requests.map((r) => r.path))
  const missingRequired = REQUIRED_PATHS.filter((path) => !originPaths.has(path))

  console.log('\n================ P1 采集完整率 ================')
  console.log(`chrome 内核      ${instance?.kernel_version ?? '-'}`)
  console.log(`受控 origin 记录  ${serverTotal} 条`)
  console.log(`监控库记录        ${rows.length} 条`)
  console.log(`漏抓              ${missingTotal} 条  (${(leakRate * 100).toFixed(2)}%)`)
  console.log(`多出（CDP 独有）  ${extraTotal} 条`)
  console.log(`body 落盘         ${bodyStats.stored}/${bodyStats.n} 条，${(bodyStats.bytes / 1024).toFixed(1)} KB`)
  console.log(
    `页面行为覆盖      ${REQUIRED_PATHS.length - missingRequired.length}/${REQUIRED_PATHS.length}` +
      (missingRequired.length ? `  未发出: ${missingRequired.join(', ')}` : '')
  )

  const summary = readEnvValue(out.join(''), 'MONITOR_SUMMARY')
  if (summary) {
    const active = summary.workspaces?.default ?? Object.values(summary.workspaces ?? {})[0] ?? summary
    console.log(
      `\n采集侧            ${active.requestCount} 请求 / target ${active.targets}` +
        `\n存储侧            写入 ${active.storage.rowsWritten}，被约束丢 ${active.storage.rowsIgnored}，` +
        `队列残留 ${active.storage.queueDepth}，丢弃 ${active.storage.droppedRequests}` +
        `\nbody 采集         pause ${active.body.paused}，拿到 ${active.body.captured}` +
        `，超限 ${active.body.tooLarge}，流式跳过 ${active.body.streaming}` +
        `，超时 ${active.body.timeouts}，异常 ${active.body.errors}，未关联 ${active.body.unmatched}` +
        `\nbody 关联         重试 ${active.storage.bodiesRetried}，转收尾 ${active.storage.bodiesParked}` +
        `，收尾补上 ${active.storage.bodiesResolvedAtShutdown}，确认真丢 ${active.storage.bodiesUnmatched}`
    )
  }

  if (missing.length) {
    console.log('\n--- 漏抓明细（前 25） ---')
    for (const item of missing.slice(0, 25)) {
      console.log(`  ${item.key}  origin=${item.server} cdp=${item.cdp}`)
    }
    if (missing.length > 25) console.log(`  …还有 ${missing.length - 25} 组`)
  }
  if (extra.length) {
    console.log('\n--- CDP 独有（前 15） ---')
    for (const item of extra.slice(0, 15)) {
      console.log(`  ${item.key}  cdp=${item.cdp} origin=${item.server}`)
    }
  }

  const leakPass = leakRate < LEAK_BUDGET
  const behaviorPass = missingRequired.length === 0
  const pass = leakPass && behaviorPass
  if (!behaviorPass) {
    console.log(
      '\n提示: 预期请求没发出，通常是某个 target 被 waitForDebuggerOnStart 挂住后' +
        '\n      没有及时放行（Service Worker 尤其容易：对它的 Network.enable 会一直等到' +
        '\n      worker 线程跑起来才回包，先 enable 再放行就是一个死锁）。'
    )
  }
  console.log(
    `\n判据: 漏抓率 < ${(LEAK_BUDGET * 100).toFixed(0)}%` +
      ` 且页面预期请求全部发出  →  ${pass ? '通过' : '未通过'}`
  )
  console.log(`应用日志: ${outFile}`)

  if (pass) {
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch {
      console.log(`（临时目录没删干净，手动清一下: ${dataDir}）`)
    }
  } else {
    console.log(`保留数据目录以便排查: ${dataDir}`)
  }

  process.exit(pass ? 0 : 1)
}

main().catch((err) => {
  console.error('验收脚本崩溃:', err)
  process.exit(1)
})
