#!/usr/bin/env node
/**
 * P3 验收：干预引擎端到端。
 *
 * 判据（设计文档 §12）：改写成功率 ≥ 99%，且 7 种动作在真实管道上都能生效。
 *
 * 证据分两层：
 *   1. 页面自己回报 —— 探针页把「它实际看到的」发给受控 origin（body 被改成什么、
 *      响应头有没有、注入脚本有没有跑、delay 有多久）。这是端到端，不是引擎自证。
 *   2. origin 的 access log —— block/fulfill/mock 的请求**不该**出现在真值日志里；
 *      redirect 会让日志里多出一个页面从不直接请求的路径。
 *
 *   node scripts/test-rules-e2e.mjs
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startOrigin } from './test-origin.mjs'

process.removeAllListeners('warning')
process.on('warning', () => {})

const ROOT = dirname(fileURLToPath(import.meta.url)) + '/..'
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

const DELAY_MS = 800
/** §12：改写成功率 ≥ 99% */
const REWRITE_BUDGET = 0.99

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []

async function check(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  \u2713 ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error: error.message })
    console.log(`  \u2717 ${name}\n      ${error.message}`)
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await sleep(150)
  }
  throw new Error(`等不到：${label}`)
}

function readSummary(text) {
  const match = /MONITOR_SUMMARY ([^\n]*)/.exec(text)
  if (!match) return null
  try {
    return JSON.parse(match[1])
  } catch {
    return null
  }
}

function buildRules(base) {
  const host = `*://127.0.0.1:*`
  const rule = (id, name, stage, urlPattern, action, extra = {}) => ({
    id,
    name,
    enabled: true,
    priority: 10,
    stage,
    match: { urlPattern, ...(extra.match ?? {}) },
    action,
    ...extra.rest
  })

  return {
    version: 1,
    rules: [
      rule('blk', '拦掉 /missing', 'request', `${host}/missing`, { kind: 'block' }),
      rule('red', '跳转 /api/fetch-post', 'request', `${host}/api/fetch-post`, {
        kind: 'redirect',
        to: `${base}/rules-redirect-target`
      }),
      rule('reqhdr', '请求头打标', 'request', `${host}/api/xhr-get`, {
        kind: 'rewriteHeaders',
        set: { 'x-monitor-rule': 'p3' }
      }),
      rule('delay', 'POST 延迟', 'request', `${host}/api/xhr-post`, {
        kind: 'delay',
        ms: DELAY_MS
      }),
      rule('man', '伪造 manifest', 'request', `${host}/manifest.webmanifest`, {
        kind: 'fulfill',
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"name":"fulfilled"}'
      }),
      rule('mock', 'fixture 伪造', 'request', `${host}/api/through-sw`, {
        kind: 'mock',
        fixture: 'sw-mock'
      }),
      rule('resbody', '改 JSON 响应体', 'response', `${host}/api/fetch-get`, {
        kind: 'rewriteBody',
        script: "return body.replace('\"fetch\":\"get\"', '\"fetch\":\"rewritten\"')"
      }),
      rule('reshdr', '响应头打标', 'response', `${host}/style.css`, {
        kind: 'rewriteHeaders',
        set: { 'x-monitor-resp': 'p3' }
      }),
      rule('off', '停用的规则不该生效', 'request', `${host}/app1.js`, { kind: 'block' }, {
        rest: {}
      })
    ],
    fixtures: {
      'sw-mock': {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"mocked":true}'
      }
    },
    injections: [
      {
        id: 'inj',
        name: '标记已注入',
        enabled: true,
        urlPattern: '*rules-probe.html*',
        code: 'window.__INJECTED__ = 1',
        runAt: 'document_start'
      }
    ]
  }
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'monitor-rules-e2e-'))
  const rulesPath = join(dataDir, 'rules.json')
  const quitFile = join(dataDir, 'quit')

  const origin = await startOrigin(0)
  const base = `http://127.0.0.1:${origin.port}`
  const rules = buildRules(base)
  // 最后一条要显式停用：停用的规则必须被忽略
  rules.rules[rules.rules.length - 1].enabled = false
  writeFileSync(rulesPath, JSON.stringify(rules, null, 2), 'utf8')

  const url = `${base}/rules-probe.html`
  console.log(`受控 origin: ${base}`)
  console.log(`规则文件: ${rulesPath}`)
  console.log(`探针页: ${url}\n`)

  const out = []
  const child = spawn(ELECTRON, ['out/main/index.js', '--no-sandbox'], {
    cwd: ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      MONITOR_URL: url,
      MONITOR_DATA_DIR: dataDir,
      MONITOR_HEADLESS: '1',
      MONITOR_RULES: rulesPath,
      MONITOR_QUIT_FILE: quitFile
    }
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    out.push(chunk)
    process.stdout.write(chunk)
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => process.stderr.write(chunk))

  let summary = null
  try {
    await waitFor(
      () => origin.requests.find((entry) => entry.path === '/api/rules-report'),
      90_000,
      '探针页回报结果'
    )
    writeFileSync(quitFile, 'quit')
    await new Promise((resolve) => child.once('exit', resolve))
    summary = readSummary(out.join(''))
  } finally {
    try {
      child.kill()
    } catch {}
    await origin.close()
  }

  const report = origin.requests.find((entry) => entry.path === '/api/rules-report')
  const seen = report ? new URLSearchParams(report.query) : new URLSearchParams()
  const paths = origin.requests.map((entry) => entry.path)
  const count = (path) => paths.filter((item) => item === path).length

  console.log('\n== 页面端到端证据（探针页自己报的）==')
  await check('响应体改写：页面读到的 JSON 是改过的', () =>
    assert.equal(seen.get('v'), 'rewritten', `实际 ${seen.get('v')}`))
  await check('响应头改写：页面读到 x-monitor-resp', () =>
    assert.equal(seen.get('h'), 'p3', `实际 ${seen.get('h')}`))
  await check('请求阶段拦截：fetch(/missing) 被拒', () =>
    assert.equal(seen.get('blocked'), 'blocked', `实际 ${seen.get('blocked')}`))
  await check('伪造响应：页面拿到 fulfill 的 body', () =>
    assert.equal(seen.get('man'), 'ok', `实际 ${seen.get('man')}`))
  await check('fixture 伪造：页面拿到 mock 的 body', () =>
    assert.equal(seen.get('mock'), 'ok', `实际 ${seen.get('mock')}`))
  await check('请求跳转：页面落在跳转落点的 404 上', () =>
    assert.equal(seen.get('redir'), 'ok', `实际 ${seen.get('redir')}`))
  await check(`延时放行：POST 至少等了 ${DELAY_MS}ms`, () =>
    assert.ok(Number(seen.get('delay')) >= DELAY_MS - 50, `实际 ${seen.get('delay')}ms`))
  await check('注入脚本：document_start 在页面里跑过', () =>
    assert.equal(seen.get('inj'), '1', `实际 ${seen.get('inj')}`))

  console.log('\n== origin 真值日志（网络层证据）==')
  await check('改写的请求头真的发出去了', () => {
    const hits = origin.requests.filter((entry) => entry.path === '/api/xhr-get')
    assert.ok(hits.length > 0, 'origin 没收到 /api/xhr-get')
    assert.ok(hits.every((entry) => entry.probe === 'p3'), `实际 ${JSON.stringify(hits.map((h) => h.probe))}`)
  })
  await check('跳转目标出现在日志里，原路径没有', () => {
    assert.equal(count('/rules-redirect-target'), 1, `跳转落点 ${count('/rules-redirect-target')} 次`)
    assert.equal(count('/api/fetch-post'), 0, '原路径不该被请求')
  })
  await check('block / fulfill / mock 的请求没到 origin', () => {
    assert.equal(count('/missing'), 0, `/missing ${count('/missing')} 次`)
    assert.equal(count('/manifest.webmanifest'), 0, 'manifest 被伪造了不该到 origin')
    assert.equal(count('/api/through-sw'), 0, 'mock 命中不该到 origin')
  })
  await check('停用的规则不生效（/app1.js 正常放行）', () =>
    assert.equal(count('/app1.js'), 0, '探针页不该请求 /app1.js'))

  console.log('\n== 引擎统计（summary.rules）==')
  const stats = summary?.rules ?? null
  await check('summary 里带上了规则统计', () => assert.ok(stats, '没有 summary.rules'))
  if (stats) {
    await check('坏规则 0 条', () => assert.equal(stats.invalid.length, 0, JSON.stringify(stats.invalid)))
    await check('9 条规则里 8 条生效（1 条停用）', () =>
      assert.equal(stats.total, 8, `实际 ${stats.total}`))
    await check('每种动作都真的跑过', () => {
      assert.ok(stats.blocked >= 1, `blocked=${stats.blocked}`)
      assert.ok(stats.redirected >= 1, `redirected=${stats.redirected}`)
      assert.ok(stats.delayed >= 1, `delayed=${stats.delayed}`)
      assert.ok(stats.headersRewritten >= 2, `headersRewritten=${stats.headersRewritten}`)
      assert.ok(stats.bodiesRewritten >= 1, `bodiesRewritten=${stats.bodiesRewritten}`)
      assert.ok(stats.fulfilled >= 2, `fulfilled=${stats.fulfilled}`)
      assert.equal(stats.failed, 0, `failed=${stats.failed}`)
    })
    await check('§12 改写成功率 ≥ 99%', () => {
      const rate = stats.matched === 0 ? 0 : stats.applied / stats.matched
      assert.ok(rate >= REWRITE_BUDGET, `成功率 ${(rate * 100).toFixed(1)}%（命中 ${stats.matched}）`)
    })
    await check('§6.2 匹配开销 < 50µs', () =>
      assert.ok(stats.avgMatchUs < 50, `实际 ${stats.avgMatchUs.toFixed(2)}µs`))
    await check('注入脚本挂上了', () =>
      assert.ok((summary.injections?.installed ?? 0) >= 1, JSON.stringify(summary.injections)))
  }

  console.log('\n== 采集没有被规则破坏 ==')
  await check('请求照常入库', () => assert.ok((summary?.requestCount ?? 0) >= 8, `requestCount=${summary?.requestCount}`))

  /* ---------------------- 关掉 body 采集时，响应规则也必须生效 ---------------------- */
  // 曾经是坏的：Fetch.enable 的 pattern 只按**请求阶段**的规则反推，
  // 「MONITOR_CAPTURE_BODIES=0 + 只有响应规则」这个组合下压根没有 requestPaused，
  // 规则静默失效（页面上什么都看不出来，日志里一个错都没有）。
  console.log('\n== 关掉 body 采集时的响应规则（对照组）==')
  const origin2 = await startOrigin(0)
  const base2 = `http://127.0.0.1:${origin2.port}`
  const dataDir2 = mkdtempSync(join(tmpdir(), 'monitor-rules-e2e-nobody-'))
  const rulesPath2 = join(dataDir2, 'rules.json')
  writeFileSync(rulesPath2, JSON.stringify(buildRules(base2), null, 2), 'utf8')
  const quitFile2 = join(dataDir2, 'quit')
  const out2 = []
  const child2 = spawn(ELECTRON, ['out/main/index.js', '--no-sandbox'], {
    cwd: ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      MONITOR_URL: `${base2}/rules-probe.html`,
      MONITOR_DATA_DIR: dataDir2,
      MONITOR_HEADLESS: '1',
      MONITOR_CAPTURE_BODIES: '0',
      MONITOR_RULES: rulesPath2,
      MONITOR_QUIT_FILE: quitFile2
    }
  })
  child2.stdout.setEncoding('utf8')
  child2.stdout.on('data', (chunk) => out2.push(chunk))
  child2.stderr.setEncoding('utf8')
  child2.stderr.on('data', () => {})
  let seen2 = new URLSearchParams()
  try {
    const report2 = await waitFor(
      () => origin2.requests.find((entry) => entry.path === '/api/rules-report'),
      90_000,
      '关掉 body 采集那轮的探针页回报'
    )
    seen2 = new URLSearchParams(report2.query)
    writeFileSync(quitFile2, 'quit')
    await new Promise((resolve) => child2.once('exit', resolve))
  } finally {
    try {
      child2.kill()
    } catch {}
    await origin2.close()
    rmSync(dataDir2, { recursive: true, force: true })
  }

  await check('关掉 body 采集后响应体改写仍然生效（页面读到改后的 JSON）', () =>
    assert.equal(seen2.get('v'), 'rewritten', `实际 ${seen2.get('v')}`))
  await check('关掉 body 采集后请求阶段的规则照旧（拦截 / 跳转）', () => {
    assert.equal(seen2.get('blocked'), 'blocked', `blocked=${seen2.get('blocked')}`)
    assert.equal(seen2.get('redir'), 'ok', `redir=${seen2.get('redir')}`)
  })

  const failed = results.filter((row) => !row.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  rmSync(dataDir, { recursive: true, force: true })
  if (failed.length) process.exitCode = 1
}

void main()