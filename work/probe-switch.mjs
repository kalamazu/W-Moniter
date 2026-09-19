#!/usr/bin/env node
/** 切 Profile 前后，instances 表逐秒长什么样 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startOrigin } from '../scripts/test-origin.mjs'
import { launchApp, sleep } from '../scripts/app-harness.mjs'

const dataDir = mkdtempSync(join(tmpdir(), 'probe-switch-'))
const dbPath = join(dataDir, 'monitor.db')
const origin = await startOrigin(0)
const url = 'http://127.0.0.1:' + origin.port + '/dom-probe.html'
const app = await launchApp({ url, dataDir, port: 9487, tab: 'sessions' })
await app.waitConnected(1)
await sleep(2000)

const dump = (tag) => {
  try {
    const db = new DatabaseSync(dbPath)
    const rows = db.prepare('SELECT id, profile, started_at, ended_at FROM instances ORDER BY id').all()
    const reqs = db.prepare('SELECT inst, COUNT(*) n FROM requests GROUP BY inst').all()
    db.close()
    console.log(tag, 'instances=' + JSON.stringify(rows), 'requests=' + JSON.stringify(reqs))
  } catch (e) {
    console.log(tag, 'ERR ' + e.message)
  }
}
dump('before   ')
const st = await app.evaluate('window.monitor.getStatus()')
const sw = await app.evaluate("window.monitor.switchProfile('H')")
console.log('switch →', JSON.stringify(sw))
dump('t=0      ')
for (const t of [1, 2, 3, 5, 8]) {
  await sleep(t === 1 ? 1000 : 1000)
  dump('t=' + String(t).padEnd(8))
}
console.log('status =', JSON.stringify({ state: (await app.evaluate('window.monitor.getStatus()')).state, inst: (await app.evaluate('window.monitor.getStatus()')).inst, was: st.inst }))
await app.close()
await origin.close()
process.exit(0)