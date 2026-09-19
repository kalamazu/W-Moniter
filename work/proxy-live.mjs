#!/usr/bin/env node
/** 真实站点冒烟：代理能不能带 Chrome 上公网 https（沙箱自签 origin 之外的那一半） */
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const SITES = process.argv.slice(2).length ? process.argv.slice(2) : ['https://example.com/', 'https://www.bing.com/']

async function directOk() {
  try {
    const r = await fetch('https://example.com/', { signal: AbortSignal.timeout(8000) })
    return 'HTTP ' + r.status
  } catch (e) { return 'FAIL ' + e.name + ' ' + e.message }
}
console.log('本机直连 example.com:', await directOk())

const proc = spawn(process.execPath, [join(ROOT, 'proxy', 'server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] })
let buf = ''
const pending = new Map()
const flows = []
proc.stdout.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const m = JSON.parse(line)
    if (m.ev) { if (m.ev === 'flow') flows.push(m.data); continue }
    const s = pending.get(m.id); if (s) { pending.delete(m.id); s(m) }
  }
})
proc.stderr.on('data', (d) => console.log('  [proxy-err]', String(d).trim().split('\n')[0]))
const call = (op, args) => new Promise((res, rej) => {
  const id = Math.floor(Math.random() * 1e9)
  pending.set(id, (m) => (m.ok ? res(m.result) : rej(new Error(m.error))))
  proc.stdin.write(JSON.stringify({ id, op, args }) + '\n')
})

const st = await call('start', { port: 0, keyFile: join(ROOT, 'work', 'spki', 'proxy.key') })
console.log('代理端口', st.port)

const runChrome = (url) => new Promise((res) => {
  const prof = join(process.env.TEMP, 'cxlive-' + Math.random().toString(36).slice(2, 9))
  const p = spawn(CHROME, ['--headless=new', '--dump-dom', '--no-first-run', '--user-data-dir=' + prof,
    '--proxy-server=http://127.0.0.1:' + st.port, '--ignore-certificate-errors-spki-list=' + st.spki, url],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  p.stdout.on('data', (d) => { out += d })
  const t = setTimeout(() => { p.kill(); res({ out, to: true }) }, 30000)
  p.on('close', () => { clearTimeout(t); res({ out, to: false }) })
})

for (const url of SITES) {
  flows.length = 0
  const r = await runChrome(url)
  const err = (r.out.match(/ERR_[A-Z_]+/) ?? [])[0]
  const title = (r.out.match(/<title[^>]*>([\s\S]{0,60}?)<\/title>/i) ?? [])[1]
  console.log('\n' + url)
  console.log('  bytes=' + r.out.length + ' title=' + JSON.stringify(title) + ' err=' + (err ?? '-') + (r.to ? ' 超时' : ''))
  for (const f of flows.filter((x) => x.status !== undefined)) {
    console.log('  ' + f.flowId, f.method, f.status, f.url.slice(0, 70), 'lane=' + f.lane, JSON.stringify(f.timings),
      'ALPN=' + (f.upstreamAlpn ?? '-'), 'TLS=' + (f.tlsVersion ?? '-'))
  }
}
proc.kill()
process.exit(0)
