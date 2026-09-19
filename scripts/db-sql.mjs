#!/usr/bin/env node
/**
 * 直接对监控库跑 SQL 的小工具。存储进程的单测之外，
 * 还要能绕过它看真实落盘结果 —— 排查「到底写进去没有」时最省事。
 *
 *   node scripts/db-sql.mjs .userdata/test.db "select count(*) from requests"
 *   node scripts/db-sql.mjs .userdata/test.db "select url, body_state from requests limit 5"
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'

process.removeAllListeners('warning')
process.on('warning', () => {})

const [dbPath, ...sqlParts] = process.argv.slice(2)
const sql = sqlParts.join(' ')

if (!dbPath || !sql) {
  console.error('用法: node scripts/db-sql.mjs <db 路径> "<SQL>"')
  process.exit(1)
}
if (!existsSync(dbPath)) {
  console.error('库不存在: ' + dbPath)
  process.exit(1)
}

const db = new DatabaseSync(dbPath)
try {
  const statement = db.prepare(sql)
  if (/^\s*(select|pragma|with)/i.test(sql)) {
    const rows = statement.all()
    console.log(JSON.stringify(rows, null, 2))
    console.error(`\n${rows.length} 行`)
  } else {
    const info = statement.run()
    console.log(JSON.stringify({ changes: Number(info.changes) }))
  }
} catch (err) {
  console.error('SQL 失败: ' + err.message)
  process.exit(1)
} finally {
  db.close()
}
