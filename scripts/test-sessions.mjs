#!/usr/bin/env node
/**
 * §7.1 面板 #9「会话管理」验收。
 *
 * 这个面板最容易做成「UI 自己说自己对」，所以判据一律落到库和进程上：
 *   1) 每实例的请求/body/脚本计数，必须与库里按 inst 的 COUNT(*) 逐条对上；
 *   2) 存储分区的库大小要跟磁盘上的 .db + -wal 对得上，表行数要跟库对上；
 *   3) 切 Profile 是**收工重启**（不是热切）：必须换 inst、库里多一条 instances 行、
 *      旧那行补上 ended_at、新会话照样采得到流量；
 *   4) 面板 UI 路径也走一遍：点「切到 Profile H」按钮，提示文案 + 库里的实例行都要动。
 *
 *   node scripts/test-sessions.mjs
 */

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startOrigin } from './test-origin.mjs'
import { launchApp, makeChecker, sleep } from './app-harness.mjs'

process.removeAllListeners('warning')
process.on('warning', () => {})

const CDP_PORT = Number(process.env['SESSIONS_CDP_PORT'] ?? 9485)
const SHOT_DIR = process.env['SESSIONS_SHOT_DIR'] ?? null

const { check, assert, report } = makeChecker()

const dataDir = mkdtempSync(join(tmpdir(), 'monitor-sessions-'))
const dbPath = join(dataDir, 'monitor.db')
const origin = await startOrigin(0)
const url = `http://127.0.0.1:${origin.port}/dom-probe.html`
console.log(`受控页面: ${url}`)
console.log(`数据目录: ${dataDir}\n`)

const db = () => new DatabaseSync(dbPath)
const countOf = (sql, ...args) => {
  const handle = db()
  try {
    return handle.prepare(sql).get(...args).n
  } finally {
    handle.close()
  }
}
const rowsOf = (sql, ...args) => {
  const handle = db()
  try {
    return handle.prepare(sql).all(...args)
  } finally {
    handle.close()
  }
}
const instanceRows = () => rowsOf('SELECT id, profile, ended_at FROM instances ORDER BY id')

let app = null
try {
  app = await launchApp({ url, dataDir, port: CDP_PORT, tab: 'sessions', shotDir: SHOT_DIR })
  await app.waitConnected(1)
  await sleep(2500)
  await app.shot('sessions-panel.png')

  const overview = await app.evaluate('window.monitor.getSessions()')
  const status = await app.evaluate('window.monitor.getStatus()')
  const beforeInstances = instanceRows()

  console.log('== 会话概览 ==')
  check('实例列表：current 就是那条 live 的，profile/时间/kernel 都在', () => {
    assert(overview.instances.length >= 1, '一条实例记录都没有')
    const live = overview.instances.filter((row) => row.live)
    assert(live.length === 1, `live 标了 ${live.length} 条，应当只有 1 条`)
    assert(overview.current === live[0].id, `current=${overview.current} 不是 live 的 ${live[0].id}`)
    assert(live[0].profile === 'L', '开局 profile 不是 L: ' + live[0].profile)
    assert(live[0].started_at > 0 && live[0].ended_at === null, 'live 实例的时间字段不对')
    assert((live[0].kernel_version ?? '').includes('Chrome'), 'kernel_version 没报出来')
    assert((live[0].url ?? '').includes('/dom-probe.html'), '实例的 url 不对: ' + live[0].url)
  })

  check('每实例计数与库里按 inst 的 COUNT(*) 一致', () => {
    for (const row of overview.instances) {
      const stats = row.stats
      assert(stats, `实例 #${row.id} 没有 stats`)
      const requests = countOf('SELECT COUNT(*) AS n FROM requests WHERE inst = ?', row.id)
      const bodies = countOf(
        "SELECT COUNT(*) AS n FROM requests WHERE inst = ? AND body_state = 'stored'",
        row.id
      )
      const scripts = countOf('SELECT COUNT(*) AS n FROM script_refs WHERE inst = ?', row.id)
      assert(
        stats.requests === requests,
        `实例 #${row.id} 请求数：面板 ${stats.requests} / 库 ${requests}`
      )
      assert(stats.bodies === bodies, `实例 #${row.id} body 数：面板 ${stats.bodies} / 库 ${bodies}`)
      assert(
        stats.scripts === scripts,
        `实例 #${row.id} 脚本数：面板 ${stats.scripts} / 库 ${scripts}`
      )
    }
    assert(overview.instances[0].stats.requests > 0, '一个请求都没数到')
  })

  check('存储分区：库大小对得上磁盘（含 WAL），表行数对得上库', () => {
    assert(overview.storage, '没读到存储分区')
    assert(overview.storage.dbPath === dbPath, `库路径不对：${overview.storage.dbPath}`)
    assert(existsSync(dbPath), '库文件不存在')
    let onDisk = statSync(dbPath).size
    if (existsSync(dbPath + '-wal')) onDisk += statSync(dbPath + '-wal').size
    assert(
      Math.abs(overview.storage.dbBytes - onDisk) <= 4096,
      `库大小：面板 ${overview.storage.dbBytes} / 磁盘 ${onDisk}`
    )
    const tables = Object.fromEntries(overview.storage.tables.map((t) => [t.name, t.rows]))
    for (const name of ['instances', 'requests', 'bodies', 'scripts', 'script_refs', 'events', 'cookies', 'site_origins', 'site_snapshots']) {
      const inDb = countOf(`SELECT COUNT(*) AS n FROM ${name}`)
      assert(tables[name] === inDb, `${name} 行数：面板 ${tables[name]} / 库 ${inDb}`)
    }
    assert(overview.storage.bodyBytes >= 0, 'body 字节数为负')
  })

  check('本次 target 与控制器状态里的一致', () => {
    assert(Array.isArray(overview.targets), 'targets 不是数组')
    assert(
      overview.targets.length === (status.targets ?? []).length,
      `target 数：面板 ${overview.targets.length} / 状态 ${(status.targets ?? []).length}`
    )
    assert(
      overview.targets.some((t) => t.type === 'page' && t.attached),
      '被监控页面没有出现在 target 列表里'
    )
  })

  const uiRows = await app.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('.sessions-table tbody tr'))
    return {
      total: rows.length,
      live: document.querySelectorAll('.sessions .session-live').length,
      current: (document.querySelector('.sessions-bar') || {}).innerText || ''
    }
  })()`)
  check('面板：表格里有当前实例，且只有一行打了 live', () => {
    assert(uiRows.total >= 1, '表格是空的')
    assert(uiRows.live === 1, `live 行有 ${uiRows.live} 条`)
    assert(uiRows.current.includes('#' + overview.current), '顶部没显示当前实例号：' + uiRows.current)
  })

  /* ------------------------------------------------------------ 切 Profile */

  console.log('\n== 切 Profile（收工 → 重启）==')
  const switchH = await app.evaluate("window.monitor.switchProfile('H')")
  await app.waitConnected(1)
  const afterH = await app.evaluate('window.monitor.getStatus()')
  const rowsAfterH = instanceRows()
  const hOverview = await app.evaluate('window.monitor.getSessions()')

  check('切到 H：换进程（新 inst）、profile 变了、库里多一行、旧行收尾了', () => {
    assert(switchH.ok, '切换失败: ' + switchH.error)
    assert(afterH.profile === 'H', 'profile 没变成 H: ' + afterH.profile)
    assert(afterH.inst > status.inst, `inst 没往前走：${status.inst} → ${afterH.inst}`)
    assert(rowsAfterH.length === beforeInstances.length + 1, `instances 多了 ${rowsAfterH.length - beforeInstances.length} 行`)
    const fresh = rowsAfterH[rowsAfterH.length - 1]
    assert(fresh.profile === 'H', '新那行 profile 不是 H')
    const old = rowsAfterH.find((row) => row.id === status.inst)
    assert(old && old.ended_at !== null, '旧实例行没有补 ended_at')
  })

  let hRequests = 0
  for (let i = 0; i < 40 && hRequests === 0; i++) {
    hRequests = countOf('SELECT COUNT(*) AS n FROM requests WHERE inst = ?', afterH.inst)
    if (hRequests === 0) await sleep(500)
  }
  check('切换后照样采得到流量（新 inst 的请求进了库）', () => {
    assert(hRequests > 0, '新实例一条请求都没入库')
    console.log(`      新实例 #${afterH.inst} 已入库 ${hRequests} 条请求`)
  })

  const switchL = await app.evaluate("window.monitor.switchProfile('L')")
  await app.waitConnected(0)
  const afterL = await app.evaluate('window.monitor.getStatus()')
  check('切回 L：再重启一次，实例行继续累加', () => {
    assert(switchL.ok, '切回失败: ' + switchL.error)
    assert(afterL.profile === 'L', 'profile 没回到 L: ' + afterL.profile)
    assert(afterL.inst > afterH.inst, `inst 没继续增长：${afterH.inst} → ${afterL.inst}`)
    assert(instanceRows().length === rowsAfterH.length + 1, 'instances 行数没继续累加')
  })

  /* ------------------------------------------------------------ UI 路径 */

  console.log('\n== 面板（UI 路径）==')
  const uiSwitch = await app.evaluate(`(async () => {
    const frame = () => new Promise((r) => setTimeout(r, 100))
    const tab = Array.from(document.querySelectorAll('.tab')).find((t) => t.textContent.includes('会话'))
    if (tab) tab.click()
    for (let i = 0; i < 80 && !document.querySelector('.sessions-bar'); i++) await frame()
    const bar = document.querySelector('.sessions-bar')
    if (!bar) return { ok: false, reason: '会话面板没渲染出来' }
    const before = document.querySelectorAll('.sessions-table tbody tr').length
    const button = Array.from(bar.querySelectorAll('button')).find((b) => b.textContent.includes('切到 Profile H'))
    if (!button) return { ok: false, reason: '没有「切到 Profile H」按钮' }
    if (button.disabled) return { ok: false, reason: '按钮是灰的（profile 已经是 H？）' }
    button.click()
    let banner = ''
    let after = before
    for (let i = 0; i < 300; i++) {
      await frame()
      banner = (document.querySelector('.sessions .banner') || {}).textContent || ''
      after = document.querySelectorAll('.sessions-table tbody tr').length
      if (banner.includes('已切到') && after > before) break
    }
    return { ok: true, banner, before, after }
  })()`)
  const finalStatus = await app.evaluate('window.monitor.getStatus()')
  check('面板：点按钮能切到 H，提示文案与表格都跟着动', () => {
    assert(uiSwitch.ok, 'UI 切换失败: ' + JSON.stringify(uiSwitch))
    assert(uiSwitch.banner.includes('已切到 Profile H'), '没有提示文案: ' + uiSwitch.banner)
    assert(uiSwitch.after > uiSwitch.before, `表格行数没增加：${uiSwitch.before} → ${uiSwitch.after}`)
    assert(finalStatus.profile === 'H', '切完之后 profile 不是 H: ' + finalStatus.profile)
    assert(instanceRows().length === rowsAfterH.length + 2, '库里没多出这一条实例行')
  })

  await app.shot('sessions-panel-h.png')
} catch (err) {
  console.log(`  \u2717 跑挂了: ${err.message}`)
} finally {
  if (app) await app.close()
  try {
    await origin.close()
  } catch {
    /* 已经关了 */
  }
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* Windows 偶尔删不掉 */
  }
}

const ok = report()
process.exit(ok ? 0 : 1)