#!/usr/bin/env node
/**
 * MITM 证书实验的服务端：两个本地 https 服务
 *   nosan   18443  证书 CN=monitor.local，无 SAN（名字不匹配 + 不受信）
 *   withsan 18444  证书 CN=127.0.0.1 + SAN=IP:127.0.0.1（只是不受信）
 * 必须跑在独立进程里（同命令内新建的监听端口，chrome.exe 连不上）。
 */
import { createServer } from 'node:https'
import { createHash, X509Certificate } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const dir = join('F:/code/chrome/work/spki')
const PAGE = '<!doctype html><html><head><title>MITM-OK</title></head><body>MITM-OK</body></html>'

const spkiOf = (pem) => createHash('sha256')
  .update(new X509Certificate(readFileSync(pem)).publicKey.export({ type: 'spki', format: 'der' }))
  .digest('base64')

const targets = [['nosan', 18443], ['withsan', 18444]]
for (const [name, port] of targets) {
  const key = join(dir, name + '.key'), pem = join(dir, name + '.pem')
  if (!existsSync(pem)) { console.error('缺证书', pem); process.exit(1) }
  const subject = new X509Certificate(readFileSync(pem)).subject.replace(/\n/g, ' ')
  const s = createServer({ key: readFileSync(key), cert: readFileSync(pem) }, (q, r) => {
    console.log('[HIT]', name, q.headers.host)
    r.writeHead(200, { 'content-type': 'text/html' }); r.end(PAGE)
  })
  s.on('tlsClientError', (e) => console.log('[tlsClientError]', name, e.code))
  await new Promise((r) => s.listen(port, '127.0.0.1', r))
  console.log('READY', name, port, 'SPKI=' + spkiOf(pem), '|', subject)
}
console.log('servers up')
