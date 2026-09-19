
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startOrigin } from '../scripts/test-origin.mjs'
import { DatabaseSync } from 'node:sqlite'

const ROOT = 'F:/code/chrome'
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const origin = await startOrigin(0)
const url = 'http://localhost:' + origin.port + '/'
const dir = mkdtempSync(join(tmpdir(), 'dbdump-app-'))
const quitFile = join(dir, 'quit')
const keyFile = join(mkdtempSync(join(tmpdir(), 'dbdump-key-')), 'k')

const child = spawn(ELECTRON, ['out/main/index.js', '--no-sandbox'], {
  cwd: ROOT, windowsHide: true,
  env: { ...process.env, MONITOR_DATA_DIR: dir, MONITOR_HEADLESS: '1', MONITOR_PROXY: '1', MONITOR_PROXY_KEY: keyFile, MONITOR_QUIT_FILE: quitFile, MONITOR_URL: url, MONITOR_CAPTURE_BODIES: '0' }
})
child.stdout.setEncoding('utf8')
child.stdout.on('data', () => {})
child.stderr.setEncoding('utf8')
child.stderr.on('data', (c) => process.stdout.write('[err] ' + c))

await sleep(18000)
writeFileSync(quitFile, 'quit')
await new Promise((r) => { const t = setTimeout(() => { try { child.kill() } catch {} ; r() }, 25000); child.on('exit', () => { clearTimeout(t); r() }) })
await origin.close()

const db = new DatabaseSync(join(dir, 'monitor.db'))
const rows = db.prepare("SELECT seq, url, method, status, merge_state, proxy_flow_id, upstream_ip, tls_version, ttfb_ms, net_dns_ms, net_connect_ms, net_tls_ms, net_download_ms, proxy_delta_ms, merge_ambiguous, proxy_open FROM requests WHERE url LIKE ? ORDER BY id").all(url.replace(/\/$/, '') + '%')
console.log('rows:', rows.length)
console.log('--- merge_state 分布 ---')
const dist = {}
for (const r of rows) dist[r.merge_state ?? 'null'] = (dist[r.merge_state ?? 'null'] ?? 0) + 1
console.log(JSON.stringify(dist))
console.log('--- 带 DNS/TLS 时序的样本（§12 硬指标要的就是它）---')
const withDns = rows.filter((r) => r.net_dns_ms !== null)
console.log('有 DNS 耗时的行数:', withDns.length, '/', rows.length)
for (const r of withDns.slice(0, 3)) console.log(JSON.stringify(r))
const withTls = rows.filter((r) => r.net_tls_ms !== null)
console.log('有 TLS 耗时的行数:', withTls.length)
for (const r of withTls.slice(0, 2)) console.log(JSON.stringify(r))
console.log('--- 没有 proxy_flow_id 的行 ---')
for (const r of rows) if (!r.proxy_flow_id) console.log(JSON.stringify(r))
db.close()
console.log('done')
