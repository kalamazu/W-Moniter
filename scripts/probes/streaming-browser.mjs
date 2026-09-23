#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { startOrigin } from '../test-origin.mjs'
import { launchApp, makeChecker, sleep } from '../app-harness.mjs'

const mb = Number(process.env['STREAM_BROWSER_MIB'] ?? 100)
if (![100, 1024].includes(mb)) throw new Error('STREAM_BROWSER_MIB must be 100 or 1024')
const { check, assert, report } = makeChecker()
const dataDir = mkdtempSync(join(tmpdir(), 'monitor-stream-browser-'))
const origin = await startOrigin(0)
let app
try {
  app = await launchApp({ url: `http://127.0.0.1:${origin.port}/stream-test.html?mb=${mb}`, dataDir,
    port: Number(process.env['STREAM_BROWSER_CDP_PORT'] ?? 9548),
    ...(process.env['PACKAGED_APP'] ? { executable: process.env['PACKAGED_APP'] } : {}),
    extraEnv: { MONITOR_CAPTURE_BODIES: '1', MONITOR_PROXY: '1' } })
  await app.waitConnected(1)
  for (let n = 0; n < 600 && !origin.streamReports.length; n += 1) await sleep(200)
  const page = origin.streamReports[0]
  const truth = origin.requests.find(row => row.path === '/stream-test-data')
  check('page consumed full response and origin sent all bytes', () => {
    assert(page?.ok && page.bytes === mb * 1024 * 1024, JSON.stringify(page))
    assert(truth?.sentBytes === page.bytes && /^[a-f0-9]{64}$/.test(truth.bodyHash), JSON.stringify(truth))
  })
  let detail = null
  for (let n = 0; n < 150; n += 1) {
    const result = await app.evaluate("window.monitor.queryRequests({search:'/stream-test-data'},10,0,'time_desc')")
    const row = result?.rows?.find(item => String(item.url).includes('/stream-test-data'))
    if (row) detail = await app.evaluate(`window.monitor.getDetail(${row.seq})`)
    if (detail?.request?.body_state === 'stored') break
    await sleep(200)
  }
  check('scoped metadata points at committed content manifest', () => {
    assert(detail?.request?.body_state === 'stored', JSON.stringify(detail?.request))
    assert(detail.request.body_size === page.bytes)
    assert(detail.request.body_hash === truth.bodyHash)
  })
  let mainPeakRssBytes = null
  if (process.platform === 'win32') {
    try { mainPeakRssBytes = Number(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${app.app.pid}).PeakWorkingSet64`], { encoding: 'utf8' }).trim()) } catch {}
  }
  console.log('STREAM_BROWSER ' + JSON.stringify({ mb, hash: truth?.bodyHash, pageBytes: page?.bytes, mainPeakRssBytes }))
} catch (error) { check('streaming browser probe', () => { throw error }) }
finally {
  if (app) await app.close()
  await origin.close()
  if (existsSync(dataDir) && resolve(dataDir).startsWith(resolve(tmpdir()) + sep)) rmSync(dataDir, { recursive: true, force: true })
}
process.exit(report() ? 0 : 1)
