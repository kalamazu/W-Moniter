#!/usr/bin/env node
/**
 * 一次性实验：自签证书 + --ignore-certificate-errors-spki-list 能否让真实内核接受 MITM。
 * A/B：同一张证书、同一个 URL，一次不带这个开关、一次带上。
 *
 *   node work/spki-experiment.mjs
 */
import { execFileSync, spawn } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:https'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = process.env['CHROME_PATH'] ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const dir = join(ROOT, 'work', 'spki')
mkdirSync(dir, { recursive: true })
const keyPath = join(dir, 'ca.key')
const pemPath = join(dir, 'ca.pem')
const PORT = 8443

// 故意不写 SAN、CN 也不是 127.0.0.1 —— 名字对不上的情况才最能说明问题
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', pemPath,
  '-days', '3650', '-nodes', '-subj', '/CN=monitor.local'], {
  stdio: 'ignore',
  env: { ...process.env, OPENSSL_CONF: 'F:\\\\Miniconda3\\\\Library\\\\ssl\\\\openssl.cnf' }
})

const pem = readFileSync(pemPath)
const cert = new X509Certificate(pem)
const spki = cert.publicKey.export({ type: 'spki', format: 'der' })
const spkiHash = createHash('sha256').update(spki).digest('base64')
console.log('cert subject :', cert.subject.replace(/\n/g, ' '))
console.log('SAN          :', cert.subjectAltName ?? '(none)')
console.log('SPKI sha256  :', spkiHash)

const server = createServer({ key: readFileSync(keyPath), cert: pem }, (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><html><head><title>MITM-OK</title></head><body><h1 id="ok">MITM-OK</h1></body></html>')
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
console.log('https origin on 127.0.0.1:' + PORT)

const url = 'https://127.0.0.1:' + PORT + '/'
const runChrome = (extra) => {
  const profile = join(tmpdir(), 'spki-' + Math.random().toString(36).slice(2, 8))
  try {
    const out = execFileSync(CHROME, [
      '--headless=new', '--dump-dom', '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + profile, ...extra, url
    ], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] })
    return out
  } catch (err) {
    return String(err.stdout ?? '') + '|ERR|' + String(err.stderr ?? err.message).slice(0, 300)
  } finally {
    try { rmSync(profile, { recursive: true, force: true }) } catch {}
  }
}

const plain = runChrome([])
const pinned = runChrome(['--ignore-certificate-errors-spki-list=' + spkiHash])
const judge = (out) => out.includes('MITM-OK') ? 'PASS 页面加载成功' : 'FAIL 没拿到页面'
console.log('\n不带开关 : ' + judge(plain) + '   片段=' + JSON.stringify(plain.slice(0, 120)))
console.log('带上开关 : ' + judge(pinned) + '   片段=' + JSON.stringify(pinned.slice(0, 120)))

server.close()
