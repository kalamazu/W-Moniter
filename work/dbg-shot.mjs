import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sleep } from '../scripts/app-harness.mjs'
import { startOrigin } from '../scripts/test-origin.mjs'

const ROOT = 'F:/code/chrome'
const DATA_DIR = 'F:/code/chrome/.userdata/smoke-shot'
mkdirSync(DATA_DIR, { recursive: true })
const origin = await startOrigin(0)
const PAGE = `http://127.0.0.1:${origin.port}/`
const launchedAt = Date.now()
const app = spawn(join(ROOT, 'node_modules/electron/dist/electron.exe'), ['out/main/index.js', '--no-sandbox', '--remote-debugging-port=9508'], {
  cwd: ROOT,
  env: { ...process.env, MONITOR_DATA_DIR: DATA_DIR, MONITOR_URL: PAGE, MONITOR_PROFILE: 'L', MONITOR_AUTO_QUIT_MS: '0', MONITOR_API_PORT: '9499', MONITOR_CAPTURE_BODIES: '1', MONITOR_CAPTURE_SCRIPTS: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
})
let log = ''
app.stdout.on('data', (c) => (log += String(c)))
app.stderr.on('data', (c) => (log += String(c)))
const infoPath = join(DATA_DIR, 'control.json')
let info = null
for (let i = 0; i < 120 && !info; i++) {
  await sleep(500)
  if (!existsSync(infoPath)) continue
  try {
    const parsed = JSON.parse(readFileSync(infoPath, 'utf8'))
    if (parsed?.port && parsed?.token && (parsed.startedAt ?? 0) >= launchedAt - 2000) info = parsed
  } catch {}
}
const auth = { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' }
const base = `http://127.0.0.1:${info.port}`
for (let i = 0; i < 60; i++) {
  const s = await (await fetch(base + '/status', { headers: auth })).json()
  if (s.state === 'connected' && s.requestCount > 0) break
  await sleep(500)
}
for (const label of ['第一次', '第二次', '导航后']) {
  if (label === '导航后') await fetch(base + '/navigate', { method: 'POST', headers: auth, body: JSON.stringify({ url: PAGE }) })
  const res = await fetch(base + '/screenshot', { method: 'POST', headers: auth, body: JSON.stringify({ format: 'png' }) })
  const body = await res.json()
  console.log(`${label}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`)
}
const lines = log.split('\n').filter((l) => /shot|screenshot|error/i.test(l))
console.log('--- 应用日志 ---')
console.log(lines.slice(-12).join('\n'))
app.kill()
origin.close()
await sleep(500)
process.exit(0)