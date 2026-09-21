// agent 面：/status 里要能看到窗口吸附状态，并且要能跟着开关走
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, makeChecker, sleep } from '../scripts/app-harness.mjs'
import { startOrigin } from '../scripts/test-origin.mjs'

const { check, assert, report } = makeChecker()
const dataDir = mkdtempSync(join(tmpdir(), 'dockapi-'))
const origin = await startOrigin(0)
const app = await launchApp({ url: 'http://127.0.0.1:' + origin.port + '/', dataDir, port: 9715, tab: 'list', extraEnv: {} })
await app.waitConnected(1)

const info = JSON.parse(readFileSync(join(dataDir, 'control.json'), 'utf8'))
const status = async () => {
  const res = await fetch(`http://127.0.0.1:${info.port}/status`, { headers: { authorization: `Bearer ${info.token}` } })
  const body = await res.json()
  return body?.data ?? body
}
const before = await status()
check('HTTP /status 里带上了 dock（agent 不用为这个单开接口）', () => {
  assert(before.dock, '没看到 dock 字段：' + JSON.stringify(Object.keys(before)))
  assert(before.dock.available === true, 'available 应为 true')
  assert(before.dock.enabled === false, '干净目录上 enabled 应为 false')
})

await app.evaluate('window.monitor.setDock(true)')
await sleep(600)
const after = await status()
check('开了吸附之后 /status 立刻反映出来', () => {
  assert(after.dock.enabled === true, 'enabled 应为 true')
  assert(after.dock.attached === true, 'attached 应为 true：' + JSON.stringify(after.dock))
  console.log('    dock = ' + JSON.stringify(after.dock))
})

await app.close()
await sleep(500)
process.exit(report() ? 0 : 1)