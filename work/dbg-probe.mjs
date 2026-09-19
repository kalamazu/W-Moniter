import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, sleep } from '../scripts/app-harness.mjs'
import { startOrigin } from '../scripts/test-origin.mjs'

const origin = await startOrigin(0)
const PAGE = `http://127.0.0.1:${origin.port}/`
const dataDir = 'F:/code/chrome/.userdata/dbg-probe'
mkdirSync(dataDir, { recursive: true })
const app = await launchApp({
  url: PAGE,
  dataDir,
  port: 9502,
  profile: 'L',
  extraEnv: { MONITOR_CAPTURE_BODIES: '1', MONITOR_CAPTURE_SCRIPTS: '1' }
})
await sleep(9000)
const info = JSON.parse(readFileSync(join(dataDir, 'control.json'), 'utf8'))
const res = await fetch(`http://127.0.0.1:${info.port}/probe`, {
  method: 'POST',
  headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
  body: '{}'
})
const raw = await res.text(); console.log('raw head:', raw.slice(0, 600)); const report = JSON.parse(raw).report
console.log('summary:', JSON.stringify(report.summary))
for (const check of report.checks ?? []) {
  if (check.status !== 'pass') {
    console.log(`${check.status} | ${check.id ?? check.key ?? ''} | ${check.name ?? check.title ?? ''}`)
    console.log('    detail: ' + JSON.stringify(check.detail ?? check.message ?? check.value ?? '').slice(0, 400))
  }
}
await app.close()
origin.close()