#!/usr/bin/env node
/**
 * P5 验收（三）：端到端 —— 真 Electron + 真 Chromium 走代理 + 受控 origin。
 *
 * 前两个脚本分别验了「代理本身」和「关联算法」，这个验的是**它们接进产品之后**：
 *   §10 P5 的验收
 *   §12 「三源关联率 ≥ 95%」「DNS/TLS 信息齐全」
 *   §6.3 第 2 条「大 body 改写下沉到代理层」
 *
 * 用 localhost 而不是 127.0.0.1 访问受控 origin —— 只有 hostname 才走 DNS，
 * DNS 耗时才有得采（IP 字面量本来就没有 DNS 这一步）。
 *
 *   node scripts/test-proxy-e2e.mjs [--dump]
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { createServer as createHttpsServer } from 'node:https'
import { startOrigin } from './test-origin.mjs'
import { createAuthority } from '../proxy/cert.mjs'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const DUMP = process.argv.includes('--dump')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const QUIET_MS = 2500
const MAX_WAIT_MS = 60000

const results = []
function check(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
    console.log('  \u2713 ' + name)
  } catch (err) {
    results.push({ name, ok: false, message: err.message })
    console.log('  \u2717 ' + name + '\n      ' + err.message)
  }
}

const keyFile = join(mkdtempSync(join(tmpdir(), 'monitor-proxy-e2e-')), 'proxy-ca.key')

/**
 * 跑一次应用会话，等它体面退出，返回 summary。
 * settle 有两种：等受控 origin 静默（http 会话），或死等固定秒数（https 会话够用）。
 */
async function runSession(name, env, settle) {
  const dir = mkdtempSync(join(tmpdir(), 'monitor-proxy-app-'))
  const quitFile = join(dir, 'quit')
  const out = []
  const child = spawn(ELECTRON, ['out/main/index.js', '--no-sandbox'], {
    cwd: ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      MONITOR_DATA_DIR: dir,
      MONITOR_HEADLESS: '1',
      MONITOR_PROXY: '1',
      MONITOR_PROXY_KEY: keyFile,
      MONITOR_CAPTURE_BODIES: '0',
      MONITOR_CAPTURE_SCRIPTS: '0',
      MONITOR_QUIT_FILE: quitFile,
      ...env
    }
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    out.push(chunk)
    if (DUMP) process.stdout.write(chunk)
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    if (DUMP) process.stderr.write(chunk)
  })

  await settle()
  writeFileSync(quitFile, 'quit')
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      resolve()
    }, 40000)
    child.on('exit', () => { clearTimeout(timer); resolve() })
  })

  const text = out.join('')
  const line = text.split('\n').find((l) => l.startsWith('MONITOR_SUMMARY '))
  assert.ok(line, name + '：应用没打出 MONITOR_SUMMARY')
  return { summary: JSON.parse(line.slice('MONITOR_SUMMARY '.length)), text, dir }
}

/** 等到受控 origin 不再有新请求 —— 死等秒数在慢机器上会截断页面 */
async function waitQuiet(origin, label) {
  const deadline = Date.now() + MAX_WAIT_MS
  let last = -1
  let quietSince = 0
  while (Date.now() < deadline) {
    await sleep(400)
    if (origin.requests.length !== last) {
      last = origin.requests.length
      quietSince = Date.now()
    } else if (quietSince && Date.now() - quietSince >= QUIET_MS) break
  }
  console.log('  ' + label + '：流量已静默（origin 收到 ' + origin.requests.length + ' 条）')
}

console.log('== P5 端到端验收 ==\n')

// ---- 会话 1：http 受控 origin，189 条真实流量，量关联率
const origin = await startOrigin(0)
const url = 'http://localhost:' + origin.port + '/'
console.log('  受控 origin（http）: ' + url)
const session1 = await runSession('http 会话', { MONITOR_URL: url }, () => waitQuiet(origin, 'http 会话'))
const summary = session1.summary
const proxy = summary.proxy ?? {}
const merge = proxy.merge ?? {}
const raw = proxy.rawMerge ?? {}

console.log('  受控 origin 请求数: ' + origin.requests.length)
console.log('  关联(受控): ' + JSON.stringify(merge))
console.log('  关联(全量): ' + JSON.stringify(raw))
console.log('  时序证据: ' + JSON.stringify(proxy.timingEvidence))
if (DUMP) {
  console.log('  配不上的 CDP 样本: ' + JSON.stringify(merge.samples?.cdpOnly ?? [], null, 1))
  console.log('  配不上的代理样本: ' + JSON.stringify(merge.samples?.proxyOnly ?? [], null, 1))
  console.log('  配对时钟差样本: ' + JSON.stringify(merge.samples?.deltas ?? []))
}
console.log('  时序样本: ' + JSON.stringify(proxy.timingSample) + '\n')

// ---- 会话 2：https 自签 origin。TLS 时序只有 https 才有得量
const auth = createAuthority({})
const cert = auth.forHost('localhost')
const httpsOrigin = createHttpsServer({ key: cert.keyPem, cert: cert.certPem }, (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<title>TLS-ORIGIN</title>TLS-ORIGIN-OK')
})
await new Promise((r) => httpsOrigin.listen(0, '::', r))
const httpsUrl = 'https://localhost:' + httpsOrigin.address().port + '/'
console.log('\n  受控 origin（https，自签）: ' + httpsUrl)
const session2 = await runSession(
  'https 会话',
  { MONITOR_URL: httpsUrl, MONITOR_PROXY_UPSTREAM_VERIFY: '0' },
  () => sleep(12000)
)
const https = session2.summary.proxy ?? {}
console.log('  关联(https 受控): ' + JSON.stringify(https.merge ?? {}))
console.log('  时序证据(https): ' + JSON.stringify(https.timingEvidence))
console.log('  时序样本(https): ' + JSON.stringify(https.timingSample) + '\n')
await new Promise((r) => httpsOrigin.close(r))


console.log('== 断言 ==')

check('代理在容器里起来了，端口和 SPKI 都有（§10 P5「本地代理接入」）', () => {
  assert.equal(proxy.started, true, '这次会话没起代理: ' + proxy.error)
  assert.ok(proxy.port > 0, '没拿到端口')
  assert.match(String(proxy.spki), /^[A-Za-z0-9+/]{43}=$/, 'SPKI 形状不对')
  assert.equal(proxy.error ?? null, null)
})

check('Chromium 真的走了代理（代理侧有 flow）', () => {
  assert.ok(proxy.flows > 0, '代理一条 flow 都没看到，说明 --proxy-server 没生效')
})

check('三源关联率 ≥ 95%（§12）', () => {
  assert.ok(merge.cdpCount > 0, 'CDP 侧一条都没有')
  assert.ok(merge.proxyCount > 0, '代理侧一条都没有')
  assert.ok(
    merge.mergeRate >= 0.95,
    '关联率只有 ' + (merge.mergeRate * 100).toFixed(1) + '%：' + JSON.stringify(merge)
  )
})

check('受控范围内没有孤儿记录（配不上也不丢，但要能解释）', () => {
  assert.equal(merge.cdpOnly, 0, '有 CDP 孤儿: ' + merge.cdpOnly)
  assert.equal(merge.proxyOnly, 0, '有代理孤儿: ' + merge.proxyOnly)
})

check('DNS 信息齐全（§12 硬指标，CDP 给不了这个）', () => {
  const sample = proxy.timingSample
  assert.ok(sample, '一条都没关联上，拿不到时序样本')
  assert.ok(sample.url.startsWith(url.replace(/\/$/, '')), '样本不是受控 origin 的: ' + sample.url)
  assert.equal(typeof sample.timings.dns, 'number', '缺 DNS 耗时')
  assert.equal(typeof sample.timings.connect, 'number', '缺 connect 耗时')
  assert.equal(typeof sample.timings.ttfb, 'number', '缺 TTFB')
  assert.equal(typeof sample.timings.download, 'number', '缺 download')
  assert.ok(sample.upstreamIp, '没记到上游 IP（就是 DNS 的结果）')
  const ev = proxy.timingEvidence ?? {}
  assert.ok(ev.dns > 0, '没有任何一条记录带上 DNS 耗时')
})

check('TLS 信息齐全（https 会话）', () => {
  const ev = https.timingEvidence ?? {}
  assert.ok(ev.tls > 0, 'https 会话里没有一条记录带上 TLS 耗时: ' + JSON.stringify(ev))
  assert.ok(ev.dns > 0, 'https 会话里没有 DNS: ' + JSON.stringify(ev))
  assert.ok(https.timingSample?.tlsVersion, '没记到 TLS 版本: ' + JSON.stringify(https.timingSample))
})

check('https 会话的关联率同样达标', () => {
  const m = https.merge ?? {}
  assert.ok(m.merged > 0, 'https 会话一条都没配上')
  assert.ok(m.mergeRate >= 0.95, 'https 关联率 ' + ((m.mergeRate ?? 0) * 100).toFixed(1) + '%')
})

check('代理补充的字段真的并进了 CDP 记录（不是只在代理侧自说自话）', () => {
  const db = new DatabaseSync(join(session1.dir, 'monitor.db'), { readOnly: true })
  const rows = db.prepare(
    'SELECT url, request_id, seq FROM requests WHERE url LIKE ? ORDER BY seq LIMIT 20'
  ).all('http://localhost:' + origin.port + '/%')
  db.close()
  assert.ok(rows.length > 0, '库里没有受控 origin 的记录')
  assert.ok(rows[0].request_id, '记录缺 CDP request id')
})

check('全量关联统计也如实报出来（Chrome 后台请求 CDP 看不见，会成 proxy-only）', () => {
  assert.ok(raw.proxyCount >= merge.proxyCount, '全量代理数不该小于受控范围: ' + JSON.stringify(raw))
  assert.equal(typeof raw.mergeRate, 'number')
})

check('应用侧没有报错', () => {
  assert.notEqual(summary.state, 'error', 'state=error: ' + summary.error)
  assert.equal(summary.error ?? null, null)
})

if (DUMP) {
  console.log('\n== 应用输出里的代理相关行 ==')
  for (const line of session1.text.split('\n')) {
    if (/\[proxy\]|代理|关联|proxy/.test(line)) console.log('  ' + line.slice(0, 200))
  }
}

try { rmSync(session1.dir, { recursive: true, force: true }) } catch {}
try { rmSync(session2.dir, { recursive: true, force: true }) } catch {}
try { await origin.close() } catch {}

console.log('\n== 结果 ==')
const failed = results.filter((item) => !item.ok)
console.log('  ' + (results.length - failed.length) + '/' + results.length + ' 通过')
for (const item of failed) console.log('  \u2717 ' + item.name + ': ' + item.message)
process.exit(failed.length === 0 ? 0 : 1)
