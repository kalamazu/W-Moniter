#!/usr/bin/env node
/** 冒烟：Chrome --proxy-server + SPKI pin 走通 MITM，并回读 flow */
import { spawn } from 'node:child_process'
import { createServer as httpsSrv } from 'node:https'
import { createAuthority } from '../proxy/cert.mjs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync, mkdirSync } from 'node:fs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

// ---------- 代理子进程（NDJSON 客户端）
function startProxy() {
  const proc = spawn(process.execPath, [join(ROOT, 'proxy', 'server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map()
  const events = []
  let seq = 0
  let buf = ''
  proc.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      if (msg.ev) { events.push(msg); if (msg.ev === 'log') console.log('  [proxy]', msg.data.level, msg.data.msg) }
      else { const r = pending.get(msg.id); pending.delete(msg.id); r && r(msg) }
    }
  })
  proc.stderr.on('data', (d) => console.log('  [proxy-err]', String(d).trim()))
  const call = (op, args) => new Promise((res, rej) => {
    const id = ++seq
    pending.set(id, (m) => (m.ok ? res(m.result) : rej(new Error(m.error))))
    proc.stdin.write(JSON.stringify({ id, op, args }) + '\n')
  })
  return { proc, call, events }
}

const auth = createAuthority({})
const originCert = auth.forHost('127.0.0.1')
const origin = httpsSrv({ key: originCert.keyPem, cert: originCert.certPem }, (q, r) => {
  console.log('  [origin]', q.method, q.url)
  if (q.url === '/big') {
    const body = '<title>BIG</title>' + 'x'.repeat(3 * 1024 * 1024)
    r.writeHead(200, { 'content-type': 'text/html', 'content-length': String(body.length) })
    return r.end(body)
  }
  r.writeHead(200, { 'content-type': 'text/html' })
  r.end('<title>SMOKE</title>HELLO-ORIGIN')
})
await new Promise((r) => origin.listen(0, '127.0.0.1', r))
const oPort = origin.address().port
console.log('origin https://127.0.0.1:' + oPort)

const px = startProxy()
const st = await px.call('start', { port: 0, keyFile: join(ROOT, 'work', 'spki', 'proxy.key') })
console.log('proxy port', st.port, 'spki', st.spki)
await px.call('setConfig', { upstreamRejectUnauthorized: false })

const runChrome = (url, flags) => new Promise((res) => {
  const prof = join(process.env.TEMP, 'cxp-' + Math.random().toString(36).slice(2, 9))
  const args = ['--headless=new', '--dump-dom', '--no-first-run', '--user-data-dir=' + prof,
    '--proxy-server=http://127.0.0.1:' + st.port, '--proxy-bypass-list=<-loopback>', ...flags, url]
  const p = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  p.stdout.on('data', (d) => { out += d })
  const timer = setTimeout(() => { p.kill(); res({ out, timeout: true }) }, 25000)
  p.on('close', () => { clearTimeout(timer); res({ out, timeout: false }) })
})

console.log('\n--- A: 带 pin ---')
const a = await runChrome('https://127.0.0.1:' + oPort + '/', ['--ignore-certificate-errors-spki-list=' + st.spki])
console.log('  timeout=', a.timeout, 'hasSMOKE=', a.out.includes('SMOKE'), 'len=', a.out.length)
console.log('  err=', (a.out.match(/ERR_[A-Z_]+/) ?? [])[0])
console.log('  dump 原文:', JSON.stringify(a.out.slice(0, 400)))

console.log('\n--- B: 不带 pin（对照组，应该失败） ---')
const b = await runChrome('https://127.0.0.1:' + oPort + '/', [])
console.log('  hasSMOKE=', b.out.includes('SMOKE'), 'err=', (b.out.match(/ERR_[A-Z_]+/) ?? [])[0])

const flows = (await px.call('getFlows', {})).flows
console.log('\n--- flows ---')
for (const f of flows) {
  console.log(' ', f.flowId, f.method, f.status, f.url, 'lane=' + f.lane, 'timings=' + JSON.stringify(f.timings),
    'reqB=' + f.requestBytes, 'respB=' + f.responseBytes, 'bodyRef=' + (f.responseBodyRef ? f.responseBodyRef.size : '-'))
}
if (flows[0] && flows[0].responseBodyRef) {
  console.log('  首个响应体:', Buffer.from(flows[0].responseBodyRef.base64, 'base64').toString('utf8').slice(0, 80))
}
console.log('\nChrome UA 在请求头里:', JSON.stringify((flows[0] ?? {}).requestHeaders ?? {}).includes('Chrome/'))

px.proc.kill(); origin.close(); auth.forHost('x')
try { rmSync(join(ROOT, 'work', 'spki', 'proxy.key'), { force: true }) } catch {}
process.exit(0)
