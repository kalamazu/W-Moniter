import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, sleep } from '../scripts/app-harness.mjs'
import { startOrigin } from '../scripts/test-origin.mjs'

const dataDir = mkdtempSync(join(tmpdir(), 'dbg2-'))
const origin = await startOrigin(0)
const app = await launchApp({ url: 'http://127.0.0.1:' + origin.port + '/', dataDir, port: 9722, tab: 'list', extraEnv: {} })
await app.waitConnected(1)
await sleep(2000)
console.log('window.outerWidth =', await app.evaluate('window.outerWidth + "x" + window.outerHeight + " @ " + window.screenX + "," + window.screenY'))
const out = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'F:\\code\\chrome\\work\\dbg-enum.ps1'], { encoding: 'utf8' })
console.log(out.stdout)
await app.close()
await sleep(500)
process.exit(0)