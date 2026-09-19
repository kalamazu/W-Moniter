#!/usr/bin/env node
/**
 * P2 验收：脚本管理。
 *
 * 真值来自受控 origin —— 它自己知道提供了哪些脚本、内容是什么。
 * 判据：
 *   1) 网络加载的脚本全部捕获，源码逐字一致；
 *   2) 内联 <script> 也在（这条 Network 域根本看不到，只有 Debugger 能看到）；
 *   3) 内容相同的 dup1.js / dup2.js 只落一行，seen_count = 2；
 *   4) Worker / Service Worker 里的脚本同样捕获。
 *
 *   node scripts/test-scripts.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { startOrigin } from './test-origin.mjs'

process.removeAllListeners('warning')
process.on('warning', () => {})

const ROOT = dirname(fileURLToPath(import.meta.url)) + '/..'
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

const QUIET_MS = 2500
const MAX_WAIT_MS = 90_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'monitor-scripts-'))
  const dbPath = join(dataDir, 'monitor.db')
  const quitFile = join(dataDir, 'quit')

  const origin = await startOrigin(0)
  const url = `http://127.0.0.1:${origin.port}/`
  console.log(`受控 origin: ${url}`)
  console.log(`数据目录: ${dataDir}\n`)

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
  let summary = null
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    const match = /MONITOR_SUMMARY (\{.*\})/.exec(chunk)
    if (match) summary = match[1]
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => process.stderr.write(chunk))

  // 和采集完整率验收同样的静默判定：origin 和库里都不再动了再收工
  const deadline = Date.now() + MAX_WAIT_MS
  let lastOrigin = -1
  let lastDb = -1
  let quietSince = 0
  while (Date.now() < deadline) {
    await sleep(400)
    let dbCount = 0
    if (existsSync(dbPath)) {
      try {
        const probe = new DatabaseSync(dbPath)
        dbCount = probe.prepare('SELECT COUNT(*) AS n FROM requests').get().n
        probe.close()
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
  console.log(settled ? '\n流量已静默，触发收工…' : '\n等待超时，强制收工…')
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

  if (!existsSync(dbPath)) {
    console.error('\n失败：没有生成数据库文件')
    process.exit(1)
  }

  const db = new DatabaseSync(dbPath)
  const rows = db
    .prepare(
      'SELECT s.hash, s.url, s.size, s.source, s.start_line, r.seen_count FROM scripts s ' +
        'JOIN script_refs r ON r.hash = s.hash ORDER BY s.first_seen'
    )
    .all()
  const reqCount = db.prepare('SELECT COUNT(*) AS n FROM requests').get().n
  db.close()

  console.log('\n================ P2 脚本采集 ================')
  for (const row of rows) {
    const inline = !row.url || row.start_line > 0
    const label = inline
      ? `${row.url ? row.url.replace(/^https?:\/\/[^/]+/, '') : '(无 url)'} @行 ${row.start_line}`
      : row.url.replace(/^https?:\/\/[^/]+/, '')
    console.log(
      `  ${String(row.size).padStart(7)} B  次数 ${String(row.seen_count).padStart(2)}  ${label}`
    )
  }
  console.log(`\n脚本 ${rows.length} 条 / 请求 ${reqCount} 条`)
  if (summary) {
    const parsed = JSON.parse(summary)
    console.log(
      `采集侧 requestCount=${parsed.requestCount}  target=${parsed.targets}  ` +
        `存储 脚本写入 ${parsed.storage?.scriptsStored ?? '-'} / 仅元数据 ${parsed.storage?.scriptsMetaOnly ?? '-'}`
    )
  }
  console.log('')

  const findByUrl = (suffix) => rows.find((row) => (row.url ?? '').endsWith(suffix))

  /* ------------------------------------------------------------ 判据 */

  for (const [suffix, source] of [
    ['/app1.js', 'window.__a1=1'],
    ['/app2.js', 'window.__a2=2'],
    ['/app3.js', 'window.__a3=3'],
    ['/iframe.js', 'window.__iframe=1']
  ]) {
    check(`${suffix} 捕获且源码一致`, () => {
      const row = findByUrl(suffix)
      assert(row, `没找到 ${suffix}`)
      assert(row.source === source, `源码不一致: ${JSON.stringify(row.source)}`)
    })
  }

  check('Worker 脚本捕获', () => {
    const row = findByUrl('/worker.js')
    assert(row, '没找到 /worker.js')
    assert((row.source ?? '').includes('worker-data.json'), 'worker.js 源码内容不对')
  })

  check('Service Worker 脚本捕获', () => {
    const row = findByUrl('/sw.js')
    assert(row, '没找到 /sw.js')
    assert((row.source ?? '').includes('addEventListener'), 'sw.js 源码内容不对')
  })

  check('内联脚本捕获（Network 看不到这条）', () => {
    // 内联脚本的 url 是文档 URL，判据是「起始行不是 0」
    const inline = rows.filter((row) => !row.url || row.start_line > 0)
    assert(inline.length > 0, '一条内联脚本都没有')
    assert(
      inline.some((row) => (row.source ?? '').includes('window.__done')),
      '内联脚本里没有主文档那段代码'
    )
  })

  check('同内容脚本按 hash 去重', () => {
    const dups = rows.filter((row) => (row.url ?? '').includes('/dup'))
    assert(dups.length === 1, `dup 应该只有 1 行，实际 ${dups.length} 行`)
    assert(dups[0].seen_count === 2, `dup 的 seen_count 应为 2，实际 ${dups[0].seen_count}`)
    assert((dups[0].source ?? '').includes('__dup'), 'dup 源码内容不对')
  })

  check('捕获到的脚本都带源码', () => {
    const missing = rows.filter((row) => row.source === null)
    assert(missing.length === 0, `有 ${missing.length} 条没源码: ${missing.map((r) => r.url).join(', ')}`)
  })

  rmSync(dataDir, { recursive: true, force: true })

  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n验收崩溃:', err)
  process.exit(1)
})
