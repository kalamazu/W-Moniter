#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startOrigin } from '../test-origin.mjs'
import { makeChecker, openCdp, sleep } from '../app-harness.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const dataDir = mkdtempSync(join(tmpdir(), 'monitor-extension-probe-'))
const profileDir = join(dataDir, 'browser-profile')
const extensionDir = join(dataDir, 'state-probe')
const targetDir = join(dataDir, 'managed-target')
const origin = await startOrigin(0)
const { check, assert, report } = makeChecker()
const browserPath = process.env['EXTENSION_BROWSER_PATH'] ?? process.env['CHROME_PATH']
let browser = null

async function startBrowser(port) {
  if (!browserPath || !existsSync(browserPath)) throw new Error('set EXTENSION_BROWSER_PATH to Chrome for Testing')
  const child = spawn(browserPath, [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    'about:blank'
  ], { stdio: 'ignore', windowsHide: false })
  let version = null
  for (let n = 0; n < 100 && !version; n += 1) {
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() } catch { await sleep(100) }
  }
  if (!version?.webSocketDebuggerUrl) { child.kill(); throw new Error('browser CDP endpoint unavailable') }
  return { child, cdp: await openCdp(version.webSocketDebuggerUrl), port }
}

async function stopBrowser(current) {
  if (!current) return
  try { await current.cdp.send('Browser.close') } catch {}
  current.cdp.close()
  for (let n = 0; n < 50 && current.child.exitCode === null; n += 1) await sleep(100)
  if (current.child.exitCode === null) current.child.kill()
  await sleep(500)
}

async function waitFor(predicate, attempts = 100) {
  for (let n = 0; n < attempts; n += 1) {
    const hit = origin.extensionReports.find(predicate)
    if (hit) return hit
    await sleep(200)
  }
  return null
}

try {
  cpSync(join(root, 'fixtures', 'extensions', 'state-probe'), extensionDir, { recursive: true })
  cpSync(join(root, 'fixtures', 'extensions', 'managed-target'), targetDir, { recursive: true })
  writeFileSync(join(extensionDir, 'config.js'), [
    `self.MONITOR_REPORT_URL = ${JSON.stringify(`http://127.0.0.1:${origin.port}/extension-report`)}`,
    'self.MONITOR_CONTROLLED_TOGGLE = true',
    `self.MONITOR_MANAGED_TARGET_NAME = ${JSON.stringify('Monitor Managed Target')}`,
    `self.MONITOR_CONTROL_REASON = ${JSON.stringify('T-014 explicit controlled acceptance')}`,
    ''
  ].join('\n'))

  browser = await startBrowser(9552)
  const targetLoaded = await browser.cdp.send('Extensions.loadUnpacked', { path: targetDir })
  const controllerLoaded = await browser.cdp.send('Extensions.loadUnpacked', { path: extensionDir })
  const first = await waitFor(item => item.control?.phase === 'disabled_wait_restart')
  const inventory = await browser.cdp.send('Extensions.getExtensions')
  check('CDP loads both controlled unpacked extensions with stable IDs in the temporary profile', () => {
    assert(targetLoaded?.id && controllerLoaded?.id && targetLoaded.id !== controllerLoaded.id, JSON.stringify({ targetLoaded, controllerLoaded }))
    assert(inventory.extensions?.some(item => item.id === targetLoaded.id), JSON.stringify(inventory))
    assert(inventory.extensions?.some(item => item.id === controllerLoaded.id), JSON.stringify(inventory))
  })
  check('management inventory reports version, permissions, and the disabled target', () => {
    assert(first?.self?.enabled && first.version === '1.0.0', JSON.stringify(first))
    assert(first.permissions?.includes('management') && first.permissions?.includes('storage'))
    assert(first.all?.some(item => item.id === targetLoaded.id && item.enabled === false), JSON.stringify(first?.all))
  })
  check('explicit authorization disables only the controlled target and appends audit evidence', () => {
    assert(first?.control?.authorized === true && first.control.targetId === targetLoaded.id && first.control.afterEnabled === false, JSON.stringify(first?.control))
    assert(first.control.audit?.some(item => item.operation === 'setEnabled(false)' && item.authorized === true && item.after === false), JSON.stringify(first.control.audit))
  })

  await stopBrowser(browser)
  browser = await startBrowser(9554)
  const targetReloaded = await browser.cdp.send('Extensions.loadUnpacked', { path: targetDir })
  const controllerReloaded = await browser.cdp.send('Extensions.loadUnpacked', { path: extensionDir })
  const completed = await waitFor(item => item.control?.phase === 'complete')
  const afterInventory = await browser.cdp.send('Extensions.getExtensions')
  check('real browser restart preserves controller state and stable fixture identities', () => {
    assert(completed?.starts > first.starts, JSON.stringify(origin.extensionReports))
    assert(targetReloaded.id === targetLoaded.id && controllerReloaded.id === controllerLoaded.id, JSON.stringify({ targetLoaded, targetReloaded, controllerLoaded, controllerReloaded }))
    assert(completed.control.audit?.some(item => item.operation === 'setEnabled(false)' && item.authorized === true), JSON.stringify(completed.control.audit))
  })
  check('debug reload boundary is explicit and post-restart disable/enable are both observed', () => {
    assert(completed.control.restartObservedDisabled === false && completed.control.forcedReenabledOnLoad === true, JSON.stringify(completed.control))
    assert(completed.control.postRestartDisabledObserved === true && completed.control.afterEnabled === true, JSON.stringify(completed.control))
    assert(completed.control.audit?.some(item => item.operation === 'setEnabled(false):post_restart' && item.after === false), JSON.stringify(completed.control.audit))
    assert(completed.control.audit?.some(item => item.operation === 'setEnabled(true)' && item.before === false && item.after === true), JSON.stringify(completed.control.audit))
  })
  check('re-enabled target and controller remain installed after restart', () => {
    assert(afterInventory.extensions?.some(item => item.id === targetLoaded.id), JSON.stringify(afterInventory))
    assert(afterInventory.extensions?.some(item => item.id === controllerLoaded.id), JSON.stringify(afterInventory))
    assert(completed.all?.some(item => item.id === targetLoaded.id && item.enabled === true), JSON.stringify(completed.all))
  })
  check('controller storage and append-only transition evidence survive restart', () => {
    assert(completed.starts > first.starts && completed.control.audit.length >= 2, JSON.stringify(completed))
  })
  console.log('EXTENSION_CAPABILITY ' + JSON.stringify({ extensionId: controllerLoaded.id, version: first.version,
    managementCount: completed.all.length, targetObserved: true, restartStarts: completed.starts,
    enableDisable: 'verified_controlled_target', targetId: targetLoaded.id,
    restartObservedDisabled: completed.control.restartObservedDisabled,
    forcedReenabledOnLoad: completed.control.forcedReenabledOnLoad,
    postRestartDisabledObserved: completed.control.postRestartDisabledObserved,
    auditEntries: completed.control.audit.length }))
} catch (error) { check('extension capability probe', () => { throw error }) }
finally {
  await stopBrowser(browser)
  await origin.close()
  if (process.env['EXTENSION_KEEP_DATA'] !== '1' && existsSync(dataDir) && resolve(dataDir).startsWith(resolve(tmpdir()) + sep)) rmSync(dataDir, { recursive: true, force: true })
  else console.log('EXTENSION_DATA_DIR ' + dataDir)
}
process.exit(report() ? 0 : 1)
