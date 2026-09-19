#!/usr/bin/env node
/**
 * 监控容器 · 本地 CA（纯 JS 自签证书，零外部依赖）
 *
 * 为什么不用 openssl：本机只有 miniconda 那份，还得靠 OPENSSL_CONF 指到一个
 * 并不存在的 openssl.cnf，实验里已经翻车过一次。node:crypto 能给密钥和签名，
 * 缺的只是 X.509 的 DER 编码，这里手写一个最小的。
 *
 * 关键设计：**一对密钥，按 host 现签证书**。
 *   - RSA 密钥生成贵（几十~几百 ms），只做一次，还能落盘复用；
 *   - 造证书便宜（一次 sha256 + RSA 签名，亚毫秒），所以可以每个 host 一张、SAN 正确；
 *   - 同一对密钥 => SPKI 恒定 => Chrome 侧只需要 pin 一个 hash。
 *
 * 实测依据（work/spki-experiment2.mjs，Chrome 153）：
 *   A 不带开关              -> ERR_CERT_AUTHORITY_INVALID
 *   B 只 pin SPKI（无 SAN） -> PASS
 *   C pin + 带 SAN          -> PASS
 *   => --ignore-certificate-errors-spki-list=<hash> 同时越过「不受信」和「名字不匹配」，
 *      既不用装任何信任库，也不必按 host 生成证书。我们仍然按 host 签，只是为了不依赖
 *      「名字可以乱来」这个未文档化的行为。
 */

import {
  createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, X509Certificate
} from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

// ---------------------------------------------------------------- DER 编码

function derLen(n) {
  if (n < 0x80) return Buffer.from([n])
  const bytes = []
  let v = n
  while (v > 0) { bytes.unshift(v & 0xff); v = Math.floor(v / 256) }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), derLen(body.length), body])
const cat = (...xs) => Buffer.concat(xs)

const seq = (...xs) => tlv(0x30, cat(...xs))
const set = (...xs) => tlv(0x31, cat(...xs))
const octstr = (b) => tlv(0x04, b)
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]))
const nullDer = () => Buffer.from([0x05, 0x00])
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'))
/** 显式 [n]（constructed），给 version / extensions 用 */
const ctxExp = (n, body) => tlv(0xa0 | n, body)
/** 隐式原始 [n]（primitive），给 GeneralName 用 */
const ctxImp = (n, body) => tlv(0x80 | n, body)
/** BIT STRING，unused bits 可指定（keyUsage 这种位串要用） */
const bitstr = (b, unused = 0) => tlv(0x03, cat(Buffer.from([unused]), b))

function integer(v) {
  let buf
  if (Buffer.isBuffer(v)) buf = v
  else {
    const bytes = []
    let n = v
    if (n === 0) bytes.push(0)
    while (n > 0) { bytes.unshift(n & 0xff); n = Math.floor(n / 256) }
    buf = Buffer.from(bytes)
  }
  let i = 0
  while (i < buf.length - 1 && buf[i] === 0 && (buf[i + 1] & 0x80) === 0) i++
  buf = buf.subarray(i)
  if (buf.length === 0) buf = Buffer.from([0])
  if (buf[0] & 0x80) buf = cat(Buffer.from([0]), buf)
  return tlv(0x02, buf)
}

function oid(s) {
  const parts = s.split('.').map(Number)
  const out = [40 * parts[0] + parts[1]]
  for (const p of parts.slice(2)) {
    const chunk = []
    let v = p
    do { chunk.unshift(v & 0x7f); v >>>= 7 } while (v > 0)
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80
    out.push(...chunk)
  }
  return tlv(0x06, Buffer.from(out))
}

function utcTime(d) {
  const p = (n) => String(n).padStart(2, '0')
  const s = p(d.getUTCFullYear() % 100) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z'
  return tlv(0x17, Buffer.from(s, 'ascii'))
}

const OID = {
  sha256WithRSA: '1.2.840.113549.1.1.11',
  CN: '2.5.4.3',
  O: '2.5.4.10',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  serverAuth: '1.3.6.1.5.5.7.3.1'
}

const rdn = (id, value) => set(seq(oid(id), utf8(value)))
const x500Name = (cn, org) => {
  const parts = []
  if (org) parts.push(rdn(OID.O, org))
  parts.push(rdn(OID.CN, cn))
  return seq(...parts)
}

const ext = (id, critical, value) =>
  seq(oid(id), ...(critical ? [bool(true)] : []), octstr(value))

/** host -> GeneralName：IPv4 用 [7]，域名用 [2] */
function generalName(host) {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) return ctxImp(7, Buffer.from(v4.slice(1).map(Number)))
  return ctxImp(2, Buffer.from(host, 'ascii'))
}

export function buildCertDer({ key, spkiDer, cn, hosts, serial, days = 397, org = 'Chromium Monitor' }) {
  const now = new Date()
  const notBefore = new Date(now.getTime() - 24 * 3600 * 1000)
  const notAfter = new Date(now.getTime() + days * 86400 * 1000)
  const name = x500Name(cn, org)
  const extensions = seq(
    ext(OID.basicConstraints, true, seq()),
    // digitalSignature(0) + keyEncipherment(2) => 3 位有效，unused = 5
    ext(OID.keyUsage, true, bitstr(Buffer.from([0xa0]), 5)),
    ext(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
    ext(OID.subjectAltName, false, seq(...hosts.map(generalName)))
  )
  const tbs = seq(
    ctxExp(0, integer(2)),                       // version v3
    integer(serial),
    seq(oid(OID.sha256WithRSA), nullDer()),      // signature
    name,                                        // issuer（自签 => 与 subject 同）
    seq(utcTime(notBefore), utcTime(notAfter)),  // validity
    name,                                        // subject
    spkiDer,                                     // subjectPublicKeyInfo：直接嵌 node:crypto 的导出
    ctxExp(3, extensions)
  )
  const sig = sign('sha256', tbs, key)
  return seq(tbs, seq(oid(OID.sha256WithRSA), nullDer()), bitstr(sig))
}

export const pemOf = (der, label) => {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd()
  return '-----BEGIN ' + label + '-----\n' + b64 + '\n-----END ' + label + '-----\n'
}

export const spkiOf = (der) => createHash('sha256').update(der).digest('base64')

// ---------------------------------------------------------------- 对外接口

let serialCounter = 0
function randomSerial() {
  serialCounter++
  const b = Buffer.from(
    createHash('sha256').update(serialCounter + ':' + Math.random()).digest().subarray(0, 12)
  )
  b[0] &= 0x7f
  if (b[0] === 0) b[0] = 1
  return b
}

/**
 * 建一个 CA。keyFile 存在就复用 —— 这样 pin 的 hash 跨重启不变，
 * 否则每次启动都得把新的 hash 传给浏览器，缓存过的页面会全部报证书错。
 */
export function createAuthority({ keyFile = null, org = 'Chromium Monitor', days = 397 } = {}) {
  let key
  let keyPem
  if (keyFile && existsSync(keyFile)) {
    keyPem = readFileSync(keyFile, 'utf8')
    key = createPrivateKey(keyPem)
  } else {
    key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    keyPem = key.export({ type: 'pkcs8', format: 'pem' })
    if (keyFile) {
      mkdirSync(dirname(keyFile), { recursive: true })
      writeFileSync(keyFile, keyPem, { mode: 0o600 })
    }
  }
  const spkiBuf = createPublicKey(key).export({ type: 'spki', format: 'der' })
  const spki = spkiOf(spkiBuf)
  const cache = new Map()
  return {
    keyPem,
    spki,
    spkiBuf,
    org,
    days,
    forHost(host) {
      let hit = cache.get(host)
      if (!hit) {
        const der = buildCertDer({
          key, spkiDer: spkiBuf, cn: host, hosts: [host],
          serial: randomSerial(), days, org
        })
        hit = { host, keyPem, certPem: pemOf(der, 'CERTIFICATE'), der }
        cache.set(host, hit)
      }
      return hit
    },
    get cached() { return cache.size }
  }
}

/** 自检用：拿 PEM 与私钥对一遍 */
export function inspect(certPem, keyPem) {
  const x = new X509Certificate(certPem)
  return {
    subject: x.subject.replace(/\n/g, ' '),
    issuer: x.issuer.replace(/\n/g, ' '),
    san: x.subjectAltName,
    validFrom: x.validFrom,
    validTo: x.validTo,
    selfSigned: x.verify(createPublicKey(keyPem)),
    spki: spkiOf(x.publicKey.export({ type: 'spki', format: 'der' }))
  }
}

// ---------------------------------------------------------------- 自检 CLI

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/proxy/cert.mjs')) {
  const host = process.argv[2] ?? 'example.com'
  const a = createAuthority({})
  const c = a.forHost(host)
  console.log('SPKI(b64)   ', a.spki)
  console.log('cert bytes  ', c.der.length)
  for (const [k, v] of Object.entries(inspect(c.certPem, c.keyPem))) console.log(k.padEnd(12), v)
  console.log('spki stable ', inspect(c.certPem, c.keyPem).spki === a.spki)
  console.log('pem head    ', c.certPem.split('\n')[0])
}
