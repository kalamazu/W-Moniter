
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startOrigin } from '../scripts/test-origin.mjs'

const ROOT = 'F:/code/chrome'
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const LOG = join(ROOT, 'work', 'app-smoke.log')
writeFileSync(LOG, '')

const origin = await startOrigin(0)
const url = 'http://localhost:' + origin.port + '/'
const dir = mkdtempSync(join(tmpdir(), 'smoke-app-'))
const quitFile = join(dir, 'quit')
appendFileSync(LOG, 'origin: ' + url + '\ndata: ' + dir + '\n')

const keyFile = join(mkdtempSync(join(tmpdir(), 'smoke-key-')), 'k')
const child = spawn(ELECTRON, ['out/main/index.js', '--no-sandbox'], {
  cwd: ROOT,
  windowsHide: true,
  env: { ...process.env, MONITOR_DATA_DIR: dir, MONITOR_HEADLESS: '1', MONITOR_PROXY: '1', MONITOR_PROXY_KEY: keyFile, MONITOR_QUIT_FILE: quitFile, MONITOR_URL: url }
})
child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
child.stdout.on('data', (c) => appendFileSync(LOG, '[out] ' + c))
child.stderr.on('data', (c) => appendFileSync(LOG, '[err] ' + c))
child.on('exit', (codeNum, sig) => appendFileSync(LOG, 'EXIT ' + codeNum + ' ' + sig + '\n'))

await sleep(20000)
appendFileSync(LOG, 'origin requests: ' + origin.requests.length + '\n')
try { writeFileSync(quitFile, 'quit') } catch (e) { appendFileSync(LOG, 'quitfile err ' + e.message + '\n') }
await new Promise((r) => { const t = setTimeout(() => { try { child.kill() } catch {} ; r() }, 25000); child.on('exit', () => { clearTimeout(t); r() }) })
await origin.close()
appendFileSync(LOG, '=== done ===\n')
process.exit(0)
