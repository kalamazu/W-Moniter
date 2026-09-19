#!/usr/bin/env node
/**
 * 实验二：把「不可信」和「名字不匹配」拆开，看 spki pin 到底放行哪一类。
 *   A 不带开关          基线
 *   B 只 pin SPKI       （证书 CN=monitor.local，无 SAN，访问 127.0.0.1 —— 名字也不匹配）
 *   C 认证 + pin SPKI   （证书带 SAN=IP:127.0.0.1，只测「不可信」这一类）
 *   D --ignore-certificate-errors  兜底
 */
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:https'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = 'F:/code/chrome'
const CHROME = process.env['CHROME_PATH'] ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const dir = join(ROOT, 'work', 'spki')
mkdirSync(dir, { recursive: true })
const PORT = 8443
const OSSL = { stdio: 'ignore', env: { ...process.env, OPENSSL_CONF: 'F:\\\\Miniconda3\\\\Library\\\\ssl\\\\openssl.cnf' } }

const gen = (name, subj, ext) => {
  const key = join(dir, name + '.key')
  const pem = join(dir, name + '.pem')
  const args = ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', pem,
    '-days', '3650', '-nodes', '-subj', subj]
  if (ext) args.push('-addext', ext)
  execFileSync('openssl', args, OSSL)
  return { key, pem }
}
const spkiOf = (pem) => {
  const c = new X509Certificate(readFileSync(pem))
  return createHash('sha256').update(c.publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
}

const noSan = gen('nosan', '/CN=monitor.local', null)
const withSan = gen('withsan', '/CN=127.0.0.1', 'subjectAltName=IP:127.0.0.1')
console.log('nosan  SPKI', spkiOf(noSan.pem))
console.log('withsan SPKI', spkiOf(withSan.pem))

const PAGE = '<!doctype html><html><head><title>MITM-OK</title></head><body>MITM-OK</body></html>'
const servers = []
let boundPort = 0
const which = { nosan: 0, withsan: 0 }
for (const [name, pair] of [['nosan', noSan], ['withsan', withSan]]) {
  const s = createServer({ key: readFileSync(pair.key), cert: readFileSync(pair.pem) }, (_q, r) => {
    r.writeHead(200, { 'content-type': 'text/html' }); r.end(PAGE)
  })
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  which[name] = s.address().port
  boundPort = s.address().port
  if (which.nosan && which.withsan && which.nosan === which.withsan) { console.error('端口冲突，本机 8443 被占用'); process.exit(2) }
  servers.push(s)
}
console.log('nosan 端口', which.nosan, ' withsan 端口', which.withsan, ' last', boundPort)

const run = (extra, port) => {
  const profile = join(tmpdir(), 'spki-' + Math.random().toString(36).slice(2, 8))
  try {
    const out = execFileSync(CHROME, ['--headless=new', '--dump-dom', '--no-first-run',
      '--user-data-dir=' + profile, ...extra, 'https://127.0.0.1:' + port + '/'],
      { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] })
    const err = (out.match(/ERR_[A-Z_]+/) ?? [null])[0]
    return { ok: out.includes('MITM-OK'), err, len: out.length }
  } catch (e) {
    return { ok: false, err: 'THROWN ' + String(e.message).slice(0, 80), len: 0 }
  } finally { try { rmSync(profile, { recursive: true, force: true }) } catch {} }
}

const cases = [
  ['A 无开关                ', [], which.nosan],
  ['B pin 无 SAN 证书       ', ['--ignore-certificate-errors-spki-list=' + spkiOf(noSan.pem)], which.nosan],
  ['C pin 带 SAN 证书       ', ['--ignore-certificate-errors-spki-list=' + spkiOf(withSan.pem)], which.withsan],
  ['D --ignore-certificate-errors', ['--ignore-certificate-errors'], which.nosan]
]
for (const [name, flags, port] of cases) {
  const r = run(flags, port)
  console.log(name + ' → ' + (r.ok ? 'PASS 页面拿到' : 'FAIL') + '  err=' + r.err + '  bytes=' + r.len)
}
for (const s of servers) s.close()
