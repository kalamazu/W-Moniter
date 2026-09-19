import { readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, sleep } from '../scripts/app-harness.mjs'
import { startOrigin } from '../scripts/test-origin.mjs'

const origin = await startOrigin(0)
const PAGE = `http://127.0.0.1:${origin.port}/`
const dataDir = 'F:/code/chrome/.userdata/dbg-extra'
mkdirSync(dataDir, { recursive: true })
const app = await launchApp({
  url: PAGE,
  dataDir,
  port: 9499,
  profile: 'L',
  extraEnv: { MONITOR_TRACE: 'requestId=' }
})
await sleep(12000)
await app.close()
const log = readFileSync(join(dataDir, 'app.log'), 'utf8')
const lines = log.split('\n').filter((line) => line.includes('[trace]'))
console.log(lines.join('\n') || '(?? trace ?)')
origin.close()