#!/usr/bin/env node
/**
 * §6.3 第 2 条（大 body 改写下沉到代理层）的端到端验收。
 *
 * 为什么必须跑真应用：单测只能证明代理进程自己会改 body、以及规则映射的形状对；
 * 「规则从面板下发 → 主进程映射 → 代理进程执行 → 浏览器真的收到改后的内容」这条链
 * 只有把 Electron + Chrome + 代理 + CDP 全拉起来才验得了。
 *
 * 判据由**页面自己**报给 origin（不靠引擎自述）：
 *   /big   ≈ 400KB  -> CDP 那条路按 content-length > bodyMaxBytes 直接不取 body，
 *                      只有代理能改；
 *   /small 几十字节 -> CDP 那条路自己就能改（代理按约定不下沉）。
 * 于是 A/B 两次跑就能把「互补、不重叠」钉死：
 *   开代理：big = REWRITTEN，small = REWRITTEN
 *   关代理：big = ORIGINAL （CDP 改不动 —— 这就是下沉存在的原因）
 *           small = REWRITTEN（CDP 本来就改得了）
 *
 *   node work/sink-e2e.mjs
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const ROOT = 'F:/code/chrome'
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const MARK_OLD = 'MARK-ORIGINAL'
const MARK_NEW = 'MARK-REWRITTEN'
const RUN_MS = 14000

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

/* ---------------------------------------------------------------- origin */

const requests = []
/** 页面把「自己看到的是原文还是改写文」回报给服务端 —— 这是唯一可信的判据 */
function page(pad) {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>SINK-E2E</title></head><body>' +
    // 标记必须单独成元素：body.textContent 会把内联脚本的源码也算进去，
    // 而脚本里就写着 MARK-NEW 这个字面量，拿全文本判会永远命中（踩过）
    '<div id="mk">' + MARK_OLD + '</div>' +
    '<div>' + 'x'.repeat(pad) + '</div>' +
    '<iframe src="/small"></iframe>' +
    '<scr' + 'ipt>' +
    'var el = document.getElementById("mk");' +
    'var seen = el && el.textContent.indexOf("' + MARK_NEW + '") >= 0 ? "REWRITTEN" : "ORIGINAL";' +
    'fetch("/proof?p=" + encodeURIComponent(location.pathname) + "&m=" + seen);' +
    '</scr' + 'ipt></body></html>'
  )
}

const origin = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const entry = { path: url.pathname, query: url.search, at: Date.now() }
  requests.push(entry)
  const send = (type, body) => {
    const buf = Buffer.from(body)
    res.writeHead(200, { 'content-type': type + '; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store' })
    res.end(buf)
  }
  if (url.pathname === '/small') return send('text/html', page(64))
  if (url.pathname === '/proof') return send('text/plain', 'ok')
  return send('text/html', page(400 * 1024))
})
await new Promise((r) => origin.listen(0, '127.0.0.1', r))
const port = origin.address().port
const base = 'http://127.0.0.1:' + port

/** from = 这一轮开始时的日志长度：两轮共用一个 origin，不切片会读到上一轮的证据 */
function seen(path, from) {
  const hit = requests.slice(from).filter((e) => e.path === '/proof' && e.query.indexOf('p=' + encodeURIComponent(path)) >= 0).pop()
  if (!hit) return null
  return /m=REWRITTEN/.test(hit.query) ? 'REWRITTEN' : 'ORIGINAL'
}

/* ------------------------------------------------------------ 跑一次应用 */

/**
 * 收工时应用会打一行 MONITOR_SUMMARY。把规则/body 计数抠出来 ——
 * 页面的判据说「看到啥」，这份计数说「谁干的」，两下一对就知道问题在哪。
 */
function summaryOf(out) {
  const m = out.match(/MONITOR_SUMMARY (\{.*\})/)
  if (!m) return null
  try { return JSON.parse(m[1]) } catch { return null }
}

function counts(out) {
  const s = summaryOf(out)
  if (!s) return '没有 MONITOR_SUMMARY'
  const r = { ...(s.rules ?? {}) }
  delete r.recent
  delete r.invalid
  return 'rules=' + JSON.stringify(r) + ' body=' + JSON.stringify(s.body) +
    ' proxy(started=' + (s.proxy && s.proxy.started) + ' flows=' + (s.proxy && s.proxy.flows) + ')'
}

function runApp(opts) {
  const dir = mkdtempSync(join(tmpdir(), 'sink-e2e-'))
  const rulesPath = join(dir, 'rules.json')
  writeFileSync(
    rulesPath,
    JSON.stringify({
      version: 1,
      rules: [
        {
          id: 'sink-e2e',
          name: 'sink-e2e',
          enabled: true,
          priority: 0,
          stage: 'response',
          match: { urlPattern: base + '/*' },
          action: { kind: 'rewriteBody', script: 'return body.split("' + MARK_OLD + '").join("' + MARK_NEW + '")' }
        }
      ],
      fixtures: {},
      injections: []
    }),
    'utf8'
  )
  const env = {
    ...process.env,
    MONITOR_DATA_DIR: dir,
    MONITOR_HEADLESS: '1',
    // 走默认配置（body 采集开着）：这正是用户实际跑的那套 ——
    // 关掉它会让 CDP 那条路连 Fetch 都不开，A/B 就失去意义了
    MONITOR_CAPTURE_BODIES: '1',
    MONITOR_URL: base + '/big',
    MONITOR_RULES: rulesPath,
    MONITOR_AUTO_QUIT_MS: String(RUN_MS),
    MONITOR_PROXY: opts.proxy ? '1' : '0',
    MONITOR_PROXY_KEY: join(dir, 'proxy.key')
  }
  const child = spawn(ELECTRON, ['out/main/index.js', '--no-sandbox'], { cwd: ROOT, windowsHide: true, env })
  let out = ''
  let err = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (c) => { out += c })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (c) => { err += c })
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => { try { child.kill() } catch {} }, RUN_MS + 30000)
    child.on('exit', () => { clearTimeout(timer); resolve(null) })
  })
  return { dir, done: done.then(() => ({ out, err })) }
}

console.log('== 大 body 改写下沉 · 端到端（§6.3 第 2 条）==')
console.log('  origin ' + base + '  /big ≈ ' + (400 * 1024) + 'B  /small 小页面（同一份规则）\n')

console.log('== 第一轮：开代理（MONITOR_PROXY=1）==')
const mark1 = requests.length
const withProxy = runApp({ proxy: true })
const r1 = await withProxy.done
const bigOn = seen('/big', mark1)
const smallOn = seen('/small', mark1)
console.log('  页面自述：/big -> ' + String(bigOn) + '，/small -> ' + String(smallOn))
console.log('  应用计数：' + counts(r1.out))

check('开代理：大 body（> bodyMaxBytes）在浏览器里就是改写后的内容', () => {
  if (bigOn !== 'REWRITTEN') throw new Error('/big 页面看到的是 ' + String(bigOn) + '（说明代理没改，或规则没下发下去）')
})
check('开代理：小 body 由 CDP 那条路改掉（两段都覆盖，没有重叠）', () => {
  if (smallOn !== 'REWRITTEN') throw new Error('/small 页面看到的是 ' + String(smallOn) + '（CDP 那条路应该改得了）')
})
check('日志里能看到代理起来了、规则生效了，且下发没有失败', () => {
  if (!/代理: 127\.0\.0\.1:\d+ SPKI=/.test(r1.out)) throw new Error('没看到代理启动日志')
  if (!/\[rules\] 生效 1 条/.test(r1.out)) throw new Error('没看到规则生效日志')
  if (/代理规则下发失败/.test(r1.out)) throw new Error('规则下发失败了：' + r1.out.match(/代理规则下发失败[^\n]*/)[0])
  if (/代理层跳过/.test(r1.out)) throw new Error('代理层跳过了本可以执行的规则：' + r1.out.match(/代理层跳过[^\n]*/)[0])
})
check('库里这条大 body 请求是 merged，且带代理侧网络时序', () => {
  const db = new DatabaseSync(join(withProxy.dir, 'monitor.db'))
  const row = db.prepare('SELECT url, status, merge_state, proxy_flow_id, net_download_ms, ttfb_ms FROM requests WHERE url LIKE ? ORDER BY id DESC LIMIT 1').get(base + '/big%')
  db.close()
  if (!row) throw new Error('库里没有 /big 这条')
  if (row.status !== 200) throw new Error('status=' + row.status)
  if (row.merge_state !== 'merged') throw new Error('merge_state=' + row.merge_state)
  if (!row.proxy_flow_id) throw new Error('没有 proxy_flow_id')
  if (row.net_download_ms === null) throw new Error('没有代理侧的 download 耗时')
})

console.log('\n== 第二轮：关代理（MONITOR_PROXY=0）==')
const mark2 = requests.length
const noProxy = runApp({ proxy: false })
const r2 = await noProxy.done
const bigOff = seen('/big', mark2)
const smallOff = seen('/small', mark2)
console.log('  页面自述：/big -> ' + String(bigOff) + '，/small -> ' + String(smallOff))
console.log('  应用计数：' + counts(r2.out))

check('关代理：同样的大 body 改不动了（这就是必须下沉的原因）', () => {
  if (bigOff !== 'ORIGINAL') {
    throw new Error('/big 页面看到的是 ' + String(bigOff) + '，预期 CDP 拿不到这种 body | ' + counts(r2.out))
  }
})
check('关代理：小 body 仍然由 CDP 改掉（对照组，说明规则本身没问题）', () => {
  if (smallOff !== 'REWRITTEN') throw new Error('/small 页面看到的是 ' + String(smallOff))
})

await new Promise((r) => origin.close(r))
for (const d of [withProxy.dir, noProxy.dir]) { try { rmSync(d, { recursive: true, force: true }) } catch {} }

const failed = results.filter((x) => !x.ok)
console.log('\n== 结果 ==')
console.log('  ' + (results.length - failed.length) + '/' + results.length + ' 通过')
for (const f of failed) console.log('  \u2717 ' + f.name + ': ' + f.message)
process.exit(failed.length ? 1 : 0)
