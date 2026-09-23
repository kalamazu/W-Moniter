#!/usr/bin/env node
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startOrigin } from '../test-origin.mjs'
import { launchApp, makeChecker, sleep } from '../app-harness.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const dataDir = mkdtempSync(join(tmpdir(), 'monitor-extension-probe-'))
const extensionDir = join(dataDir, 'state-probe')
const origin = await startOrigin(0)
const { check, assert, report } = makeChecker()
let app
try {
  cpSync(join(root, 'fixtures', 'extensions', 'state-probe'), extensionDir, { recursive: true })
  writeFileSync(join(extensionDir, 'config.js'), `self.MONITOR_REPORT_URL = ${JSON.stringify(`http://127.0.0.1:${origin.port}/extension-report`)}\n`)
  app = await launchApp({ url: `http://127.0.0.1:${origin.port}/dom-probe.html`, dataDir, port: 9552,
    extraEnv: { MONITOR_TEST_EXTENSION_DIR: extensionDir,
      ...(process.env['EXTENSION_BROWSER_PATH'] ? { CHROME_PATH: process.env['EXTENSION_BROWSER_PATH'] } : {}) } })
  await app.waitConnected(1)
  for (let n = 0; n < 30 && !origin.extensionReports.length; n += 1) await sleep(200)
  if (!origin.extensionReports.length) {
    await app.evaluate("window.monitor.suspendWorkspace('default')")
    await app.evaluate("window.monitor.openWorkspace('default')")
    for (let n = 0; n < 60 && !origin.extensionReports.length; n += 1) await sleep(200)
  }
  const first = origin.extensionReports[0]
  check('controlled extension loads and reports management inventory', () => {
    assert(first && !first.error, JSON.stringify(first))
    assert(first.self?.enabled && first.version === '1.0.0', JSON.stringify(first))
    assert(first.permissions?.includes('management') && first.permissions?.includes('storage'))
    assert(first.all?.some(item => item.id === first.extensionId && item.enabled), JSON.stringify(first.all))
  })
  const status = await app.evaluate('window.monitor.getStatus()')
  check('CDP target sees running extension but is not complete inventory', () => {
    assert(status.targets?.some(target => String(target.url).includes(`chrome-extension://${first.extensionId}`)), JSON.stringify(status.targets))
  })
  await app.evaluate("window.monitor.suspendWorkspace('default')")
  await app.evaluate("window.monitor.openWorkspace('default')")
  for (let n = 0; n < 100 && !origin.extensionReports.some(item => item.starts > first.starts); n += 1) await sleep(200)
  check('extension storage survives browser restart', () => assert(origin.extensionReports.some(item => item.starts > first.starts), JSON.stringify(origin.extensionReports)))
  console.log('EXTENSION_CAPABILITY ' + JSON.stringify({ extensionId: first.extensionId, version: first.version,
    managementCount: first.all.length, targetObserved: true, restartStarts: origin.extensionReports.at(-1)?.starts,
    enableDisable: 'not_attempted_without_user_approval' }))
} catch (error) { check('extension capability probe', () => { throw error }) }
finally {
  if (process.env['EXTENSION_DEBUG'] === '1' && existsSync(join(dataDir, 'app.log'))) {
    console.log('APP_LOG_TAIL ' + readFileSync(join(dataDir, 'app.log'), 'utf8').slice(-5000))
    console.log('ORIGIN_EXTENSION_REQUESTS ' + JSON.stringify(origin.requests.filter(row => row.path.includes('extension'))))
  }
  if (app) await app.close()
  await origin.close()
  if (process.env['EXTENSION_KEEP_DATA'] !== '1' && existsSync(dataDir) && resolve(dataDir).startsWith(resolve(tmpdir()) + sep)) rmSync(dataDir, { recursive: true, force: true })
  else console.log('EXTENSION_DATA_DIR ' + dataDir)
}
process.exit(report() ? 0 : 1)
