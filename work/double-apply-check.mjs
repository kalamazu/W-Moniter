#!/usr/bin/env node
/**
 * §6.3「绝不重叠」的直接验收：**同一条响应只被处理一次**。
 *
 * 判据用**非幂等**脚本：`body.replace('MARK', 'MARK<!--DUP-->')`。
 * 只要规则被应用两次，页面里就会数到 2 个 DUP 标记 —— 幂等脚本（split/join 那种）
 * 是看不出来的，这也是当初 189 条里 7 条串台没能被及时发现的原因。
 *
 * 两种配置各跑一次：默认（body 采集开）与 MONITOR_CAPTURE_BODIES=0（响应规则的
 * Response pattern 是那时才补发的），两次都必须正好 1 个标记。
 *
 *   node work/double-apply-check.mjs
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = 'F:/code/chrome'
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const RUN_MS = 12000

// 标记在源码里刻意不连续（'D' + 'UP'），否则页面数的是自己脚本里的字面量（踩过）
const PAGE = [
  '<!doctype html><html><head><meta charset="utf-8"><title>non-idempotent-check</title></head><body>',
  '<div id="mk">MARK</div>',
  '<scr' + 'ipt>',
  'var M = "D" + "UP";',
  'var n = document.documentElement.outerHTML.split(M).length - 1;',
  'fetch("/proof?n=" + n);',
  '</scr' + 'ipt></body></html>'
].join('')

const requests = []
const origin = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  requests.push({ path: url.pathname, query: url.search })
  const body = url.pathname === '/proof' ? 'ok' : PAGE
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
  res.end(body)
})
await new Promise((r) => origin.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + origin.address().port

function runApp(captureBodies) {
  const dir = mkdtempSync(join(tmpdir(), 'dup-check-'))
  writeFileSync(
    join(dir, 'rules.json'),
    JSON.stringify({
      version: 1,
      rules: [
        {
          id: 'dup',
          name: 'dup',
          enabled: true,
          priority: 0,
          stage: 'response',
          match: { urlPattern: base + '/*' },
          action: { kind: 'rewriteBody', script: 'return body.replace("MARK", "MARK<!--DUP-->")' }
        }
      ],
      fixtures: {},
      injections: []
    }),
    'utf8'
  )
  const child = spawn(ELECTRON, ['out/main/index.js', '--no-sandbox'], {
    cwd: ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      MONITOR_DATA_DIR: dir,
      MONITOR_HEADLESS: '1',
      MONITOR_URL: base + '/dup.html',
      MONITOR_RULES: join(dir, 'rules.json'),
      MONITOR_AUTO_QUIT_MS: String(RUN_MS),
      MONITOR_CAPTURE_BODIES: captureBodies ? '1' : '0',
      MONITOR_PROXY: '0'
    }
  })
  let out = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (c) => { out += c })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', () => {})
  return new Promise((resolve) => {
    const timer = setTimeout(() => { try { child.kill() } catch {} }, RUN_MS + 30000)
    child.on('exit', () => { clearTimeout(timer); resolve({ dir, out }) })
  })
}

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

console.log('== 非幂等脚本只许应用一次（§6.3 绝不重叠）==')
for (const capture of [true, false]) {
  const from = requests.length
  const dir = capture ? '默认配置（body 采集开）' : 'MONITOR_CAPTURE_BODIES=0'
  console.log('\n-- ' + dir + ' --')
  const run = await runApp(capture)
  const proof = requests.slice(from).filter((e) => e.path === '/proof').pop()
  const n = proof ? Number(new URLSearchParams(proof.query).get('n')) : null
  console.log('  页面数到的 DUP 标记数：' + String(n))
  check(dir + '：非幂等规则正好应用一次（数到 1 个标记）', () => {
    if (n === null) throw new Error('页面没回报（/proof 没到）')
    if (n !== 1) throw new Error('数到 ' + n + ' 个标记 —— 说明规则被应用了 ' + n + ' 次')
  })
  try { rmSync(run.dir, { recursive: true, force: true }) } catch {}
}

await new Promise((r) => origin.close(r))
const failed = results.filter((x) => !x.ok)
console.log('\n== 结果 ==')
console.log('  ' + (results.length - failed.length) + '/' + results.length + ' 通过')
for (const f of failed) console.log('  \u2717 ' + f.name + ': ' + f.message)
process.exit(failed.length ? 1 : 0)
