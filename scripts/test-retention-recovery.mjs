#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startOrigin } from './test-origin.mjs'
import { launchApp, makeChecker, sleep } from './app-harness.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const { check, assert, report } = makeChecker()
const origin = await startOrigin(0)
const base = `http://127.0.0.1:${origin.port}/`
const dirs = []
let running = []

async function waitBig(app, expectedState = 'stored', min = 1) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const page = await app.evaluate("window.monitor.queryRequests({search:'/big'}, 20, 0, 'time_desc')")
    const rows = page?.rows ?? []
    const details = await Promise.all(rows.map(row => app.evaluate(`window.monitor.getDetail(${row.seq})`)))
    const matched = details.filter(detail => detail?.request?.body_state === expectedState)
    if (matched.length >= min) return matched
    await sleep(150)
  }
  throw new Error(`未等到 ${min} 条 ${expectedState} /big 请求`)
}

async function open(dataDir, port, extraEnv = {}) {
  const app = await launchApp({ url: base, dataDir, port, extraEnv: { MONITOR_CAPTURE_BODIES: '1', ...extraEnv } })
  running.push(app)
  await app.waitConnected(4)
  return app
}

async function navigate(dataDir, url) {
  const path = join(dataDir, 'control.json')
  for (let attempt = 0; attempt < 100 && !existsSync(path); attempt += 1) await sleep(100)
  const info = JSON.parse(readFileSync(path, 'utf8'))
  const response = await fetch(`http://127.0.0.1:${info.port}/navigate`, { method: 'POST',
    headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ url }) })
  if (!response.ok) throw new Error(`navigate HTTP ${response.status}: ${await response.text()}`)
}

try {
  const recoveryDir = mkdtempSync(join(tmpdir(), 'monitor-retention-recovery-')); dirs.push(recoveryDir)
  const interrupted = await open(recoveryDir, 9561, { MONITOR_TEST_RETENTION_FAULT_AT: 'after_content_revoke' })
  await navigate(recoveryDir, base)
  const stored = await waitBig(interrupted, 'stored', 2)
  const hash = stored[0].request.body_hash
  check('共享正文在删除前有多条引用', () => {
    assert(hash && stored.every(detail => detail.request.body_hash === hash), JSON.stringify(stored.map(detail => detail.request)))
  })
  const failed = await interrupted.evaluate(`window.monitor.executeAction(${JSON.stringify({ action: 'content.revoke', target: { kind: 'workspace', workspaceId: 'default' }, input: { hash, reason: '中断恢复验收' } })})`)
  check('受控中断发生在正文删除和 SQLite 投影之间', () => {
    assert(failed.task.state === 'failed' && /after_content_revoke/.test(failed.task.error?.message ?? ''), JSON.stringify(failed))
  })
  await interrupted.close(); running = running.filter(item => item !== interrupted)
  const resumed = await open(recoveryDir, 9562)
  const db = new DatabaseSync(join(recoveryDir, 'monitor.db'))
  const originalStates = stored.map(detail => db.prepare('SELECT body_state FROM requests WHERE inst=? AND seq=?').get(detail.request.inst, detail.request.seq))
  db.close()
  const evidenceRows = readFileSync(join(recoveryDir, 'content', 'capture-evidence.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const events = evidenceRows.filter(row => row.seq === stored[0].request.seq)
  const byHash = evidenceRows.filter(row => row.hash === hash)
  const previousValid = evidenceRows.every((row, index) => {
    const { digest, ...entry } = row
    return digest === createHash('sha256').update(JSON.stringify(entry)).digest('hex') && (index === 0 ? row.previous === 'genesis' : row.previous === evidenceRows[index - 1].digest)
  })
  check('重启后幂等补齐共享引用、证据与终态', () => {
    assert(originalStates.length >= 2 && originalStates.every(row => row.body_state === 'retained_deleted'), JSON.stringify(originalStates))
    assert(events.some(row => row.state === 'retained_deleted' && /启动恢复/.test(row.reason ?? '')), JSON.stringify(events))
    assert(byHash.some(row => row.state === 'retention_committed' && /启动恢复/.test(row.reason ?? '')))
    assert(previousValid)
  })
  await resumed.close(); running = running.filter(item => item !== resumed)

  const cancelledDir = mkdtempSync(join(tmpdir(), 'monitor-retention-cancel-')); dirs.push(cancelledDir)
  const beforeDelete = await open(cancelledDir, 9565, { MONITOR_TEST_RETENTION_FAULT_AT: 'after_intent' })
  const beforeRow = (await waitBig(beforeDelete))[0]
  const beforeHash = beforeRow.request.body_hash
  const beforeFailed = await beforeDelete.evaluate(`window.monitor.executeAction(${JSON.stringify({ action: 'content.revoke', target: { kind: 'workspace', workspaceId: 'default' }, input: { hash: beforeHash, reason: '意图中断验收' } })})`)
  assert(beforeFailed.task.state === 'failed')
  await beforeDelete.close(); running = running.filter(item => item !== beforeDelete)
  const afterIntent = await open(cancelledDir, 9566)
  const cancelDb = new DatabaseSync(join(cancelledDir, 'monitor.db'))
  const cancelState = cancelDb.prepare('SELECT body_state FROM requests WHERE inst=? AND seq=?').get(beforeRow.request.inst, beforeRow.request.seq)
  cancelDb.close()
  const cancelRows = readFileSync(join(cancelledDir, 'content', 'capture-evidence.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  check('意图已写但正文尚在时，重启取消意图且保留引用', () => {
    assert(cancelState?.body_state === 'stored', JSON.stringify(cancelState))
    assert(cancelRows.some(row => row.hash === beforeHash && row.state === 'retention_cancelled'), JSON.stringify(cancelRows))
  })
  await afterIntent.close(); running = running.filter(item => item !== afterIntent)

  const timeoutDir = mkdtempSync(join(tmpdir(), 'monitor-body-timeout-')); dirs.push(timeoutDir)
  const timeoutApp = await open(timeoutDir, 9563, { MONITOR_TEST_BODY_FETCH_TIMEOUT: '1', MONITOR_BODY_TIMEOUT_MS: '20' })
  const timeout = (await waitBig(timeoutApp, 'timeout'))[0]
  const timeoutEvidence = await timeoutApp.evaluate(`window.monitor.executeAction(${JSON.stringify({ action: 'capture.evidence', target: { kind: 'workspace', workspaceId: 'default' }, input: { seq: timeout.request.seq } })})`)
  check('受控 CDP body 超时经真实采集链投影为 timeout 证据', () => {
    assert(timeoutEvidence.output.request.state === 'timeout' && timeoutEvidence.output.events.some(row => row.state === 'timeout' && row.phase === 'fetch'), JSON.stringify(timeoutEvidence))
  })
  await timeoutApp.close(); running = running.filter(item => item !== timeoutApp)

  const failureDir = mkdtempSync(join(tmpdir(), 'monitor-content-failure-')); dirs.push(failureDir)
  const failureApp = await open(failureDir, 9564, { MONITOR_TEST_CONTENT_PUT_FAIL: '1' })
  const failure = (await waitBig(failureApp, 'content_error'))[0]
  const failureEvidence = await failureApp.evaluate(`window.monitor.executeAction(${JSON.stringify({ action: 'capture.evidence', target: { kind: 'workspace', workspaceId: 'default' }, input: { seq: failure.request.seq } })})`)
  check('内容盘写失败经真实采集链投影为 content_error 证据', () => {
    assert(failureEvidence.output.request.state === 'content_error' && failureEvidence.output.events.some(row => row.state === 'content_error' && row.phase === 'content'), JSON.stringify(failureEvidence))
  })
  await failureApp.close(); running = running.filter(item => item !== failureApp)
} catch (error) { check('retention recovery flow', () => { throw error }) }
finally {
  for (const app of running) await app.close()
  await origin.close()
  for (const dir of dirs) if (resolve(dir).startsWith(resolve(tmpdir()) + sep)) rmSync(dir, { recursive: true, force: true })
}
process.exit(report() ? 0 : 1)
