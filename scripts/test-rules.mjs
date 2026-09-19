#!/usr/bin/env node
/**
 * 规则引擎自检：匹配语义、动作语义、脚本沙箱边界、匹配开销。
 *
 * 为什么先把 TS 打包再 import，而不是直接跑 out/：
 *   electron-vite 打出来的是给 Electron 主进程用的单文件 bundle，
 *   没法按模块 import。这里用 esbuild（vite 本来就带）单独打一份，
 *   于是纯逻辑可以脱离浏览器、脱离 Electron 单独测。
 *
 *   node scripts/test-rules.mjs
 */

import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 沙箱超时调到 50ms，测「死循环」那条不用真等 200ms
process.env['MONITOR_RULE_SCRIPT_TIMEOUT_MS'] = '50'

const results = []
function check(name, fn) {
  try {
    const out = fn()
    if (out && typeof out.then === 'function') {
      return out.then(
        () => {
          results.push({ name, ok: true })
          console.log(`  \u2713 ${name}`)
        },
        (err) => {
          results.push({ name, ok: false, message: err.message })
          console.log(`  \u2717 ${name}\n      ${err.message}`)
        }
      )
    }
    results.push({ name, ok: true })
    console.log(`  \u2713 ${name}`)
  } catch (err) {
    results.push({ name, ok: false, message: err.message })
    console.log(`  \u2717 ${name}\n      ${err.message}`)
  }
  return undefined
}

const dir = mkdtempSync(join(tmpdir(), 'monitor-rules-'))
const bundlePath = join(dir, 'rules.mjs')

const { build } = await import('esbuild')
await build({
  // 一个入口把要测的模块都送进去：electron-vite 的产物没法按模块 import
  stdin: {
    contents: "export * from './engine'\nexport * from './store'\nexport * from '../proxy/rules'\n",
    resolveDir: join(ROOT, 'src/main/rules'),
    sourcefile: 'rules-test-entry.ts',
    loader: 'ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: bundlePath,
  logLevel: 'silent'
})

const {
  RuleEngine,
  applyHeaders,
  emptyRuleSet,
  globToRegex,
  hostOf,
  patternHost,
  readRuleSet,
  RuleMatcher,
  toProxyRules,
  writeRuleSet
} = await import(pathToFileURL(bundlePath).href)

/* ------------------------------------------------------------------ 工具 */

const rule = (over = {}) => ({
  id: over.id ?? 'r' + Math.random().toString(36).slice(2, 8),
  name: over.name ?? 'rule',
  enabled: over.enabled ?? true,
  priority: over.priority ?? 0,
  match: over.match ?? { urlPattern: '*' },
  stage: over.stage ?? 'request',
  action: over.action ?? { kind: 'block' }
})

const ctx = (over = {}) => ({
  url: 'https://api.example.com/v1/users',
  method: 'GET',
  resourceType: 'XHR',
  targetType: 'page',
  requestHeaders: [{ name: 'accept', value: '*/*' }],
  ...over
})

const engineWith = (rules, fixtures = {}) => {
  const engine = new RuleEngine()
  engine.setRules({ version: 1, rules, fixtures, injections: [] })
  return engine
}

console.log('\n== URL 匹配 ==')
{
  const matcher = new RuleMatcher([
    rule({ id: 'glob', match: { urlPattern: '*://api.example.com/v1/*' } }),
    rule({ id: 're', match: { urlPattern: 're:^https://[^/]+/v2/' } })
  ])

  check('glob 的 `*` 跨 `/` 匹配', () => {
    assert.equal(matcher.match(ctx()).rule.id, 'glob')
    assert.equal(
      matcher.match(ctx({ url: 'https://api.example.com/v1/a/b/c?x=1' })).rule.id,
      'glob'
    )
  })
  check('glob 不越界匹配别的路径', () =>
    assert.equal(matcher.match(ctx({ url: 'https://api.example.com/v3/x' })), null))
  check('`re:` 走正则', () =>
    assert.equal(matcher.match(ctx({ url: 'https://other.example.com/v2/x' })).rule.id, 're'))
  check('`?` 匹配单个字符', () => {
    const m = new RuleMatcher([rule({ match: { urlPattern: 'https://x.com/a?c' } })])
    assert.ok(m.match(ctx({ url: 'https://x.com/abc' })))
    assert.equal(m.match(ctx({ url: 'https://x.com/abbc' })), null)
  })
  check('glob 里的正则元字符按字面量处理', () => {
    const m = new RuleMatcher([rule({ match: { urlPattern: 'https://x.com/a+b(c)' } })])
    assert.ok(m.match(ctx({ url: 'https://x.com/a+b(c)' })))
    assert.equal(m.match(ctx({ url: 'https://x.com/aab(c)' })), null)
  })
}

console.log('\n== host 分桶（§6.2 的性能前提）==')
{
  const matcher = new RuleMatcher([
    rule({ match: { urlPattern: '*://api.example.com/*' } }),
    rule({ match: { urlPattern: '*://*.cdn.example.com/*' } }),
    rule({ match: { urlPattern: '*://*/*' } })
  ])
  check('精确 host / 后缀 / 全局各归各桶', () => {
    const b = matcher.buckets()
    assert.deepEqual(b, { exact: 1, suffix: 1, any: 1 })
  })
  check('子域命中后缀桶', () => {
    const hit = matcher.match(ctx({ url: 'https://a.b.cdn.example.com/x' }))
    assert.equal(hit.rule.match.urlPattern, '*://*.cdn.example.com/*')
  })
  check('后缀桶不会误伤同后缀的别的域', () =>
    assert.equal(
      matcher.match(ctx({ url: 'https://evil-cdn.example.com/x' })).rule.match.urlPattern,
      '*://*/*'
    ))
  check('patternHost 抠得出 host', () => {
    assert.deepEqual(patternHost('*://*.example.com/*'), { exact: null, suffix: '.example.com' })
    assert.deepEqual(patternHost('https://a.b/'), { exact: 'a.b', suffix: null })
    assert.deepEqual(patternHost('re:.*'), { exact: null, suffix: null })
  })
  check('hostOf 处理端口 / 用户信息 / 大小写', () => {
    assert.equal(hostOf('https://User@API.Example.com:8443/x'), 'api.example.com')
    assert.equal(hostOf('https://[::1]:9/x'), '[::1]')
  })
}

console.log('\n== 优先级与过滤条件 ==')
{
  const matcher = new RuleMatcher([
    rule({ id: 'low', match: { urlPattern: '*' }, priority: 1 }),
    rule({ id: 'high', match: { urlPattern: '*' }, priority: 9 }),
    rule({ id: 'same-first', match: { urlPattern: '*' }, priority: 5 }),
    rule({ id: 'same-second', match: { urlPattern: '*' }, priority: 5 })
  ])
  check('优先级高的赢，同优先级按顺序', () => assert.equal(matcher.match(ctx()).rule.id, 'high'))

  const filtered = new RuleMatcher([
    rule({ id: 'm', match: { urlPattern: '*', method: ['post'] } }),
    rule({ id: 't', match: { urlPattern: '*', resourceType: ['Document'] } }),
    rule({ id: 's', match: { urlPattern: '*', statusCode: [404] } })
  ])
  check('method 大小写不敏感', () =>
    assert.equal(filtered.match(ctx({ method: 'POST' })).rule.id, 'm'))
  check('resourceType 不符就不命中', () => assert.equal(filtered.match(ctx()), null))
  check('statusCode 只在给了 status 时才可能命中', () => {
    assert.equal(filtered.match(ctx({ status: 404 })).rule.id, 's')
    assert.equal(filtered.match(ctx({ status: 500 })), null)
  })
}

console.log('\n== 规则校验（坏规则要被丢掉并报出来，而不是炸管道）==')
{
  const engine = engineWith([
    rule({ id: 'bad-re', name: '坏正则', match: { urlPattern: 're:[' } }),
    rule({ id: 'empty', name: '空 pattern', match: { urlPattern: '  ' } }),
    rule({ id: 'wrong-stage', name: '阶段对不上', stage: 'request', action: { kind: 'rewriteBody', script: '' } }),
    rule({ id: 'ok', name: '好的', match: { urlPattern: '*' }, action: { kind: 'block' } })
  ])
  const stats = engine.stats()
  check('坏规则不进匹配器', () => assert.equal(stats.total, 1))
  check('三条坏规则都报出来了', () => assert.equal(stats.invalid.length, 3))
  check('报的原因可读', () => {
    const messages = stats.invalid.map((item) => item.message).join(' | ')
    assert.match(messages, /不是合法正则/)
    assert.match(messages, /urlPattern 为空/)
    assert.match(messages, /不支持 rewriteBody/)
  })
  check('describe() 标出每条规则是否生效', () => {
    const rows = engine.describe()
    assert.equal(rows.length, 4)
    assert.equal(rows.find((row) => row.rule.id === 'ok').active, true)
    assert.equal(rows.find((row) => row.rule.id === 'bad-re').active, false)
  })
}

console.log('\n== 请求阶段动作 ==')
{
  await check('block', async () => {
    const plan = await engineWith([rule({ action: { kind: 'block' } })]).planRequest(ctx())
    assert.equal(plan.verdict.kind, 'block')
  })

  await check('redirect 支持 $HOST 占位', async () => {
    const plan = await engineWith([
      rule({ action: { kind: 'redirect', to: 'https://$HOST/mirror' } })
    ]).planRequest(ctx())
    assert.equal(plan.verdict.to, 'https://api.example.com/mirror')
  })

  await check('delay 被夹在上限内', async () => {
    const engine = engineWith([rule({ action: { kind: 'delay', ms: 999999 } })])
    const plan = await engine.planRequest(ctx())
    assert.equal(plan.verdict.kind, 'continue')
    assert.equal(plan.delayMs, 30000)
  })

  await check('rewriteHeaders 覆盖 + 删除', async () => {
    const engine = engineWith([
      rule({
        action: {
          kind: 'rewriteHeaders',
          set: { 'x-monitor': '1', accept: 'application/json' },
          remove: ['ACCEPT-LANGUAGE']
        }
      })
    ])
    const plan = await engine.planRequest(
      ctx({ requestHeaders: [
        { name: 'accept', value: '*/*' },
        { name: 'Accept-Language', value: 'zh' }
      ] })
    )
    assert.deepEqual(plan.verdict.headers, [
      { name: 'accept', value: 'application/json' },
      { name: 'x-monitor', value: '1' }
    ])
  })

  await check('fulfill 自带 body', async () => {
    const engine = engineWith([
      rule({ action: { kind: 'fulfill', status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":1}' } })
    ])
    const plan = await engine.planRequest(ctx())
    assert.equal(plan.verdict.kind, 'fulfill')
    assert.equal(plan.verdict.status, 200)
    assert.equal(plan.verdict.body, '{"ok":1}')
  })

  await check('mock 从 fixtures 取，缺失则记失败并放行', async () => {
    const engine = engineWith(
      [rule({ action: { kind: 'mock', fixture: 'user' } })],
      { user: { status: 201, body: '{"id":7}' } }
    )
    const plan = await engine.planRequest(ctx())
    assert.equal(plan.verdict.status, 201)

    const missing = engineWith([rule({ action: { kind: 'mock', fixture: 'nope' } })])
    const plan2 = await missing.planRequest(ctx())
    assert.equal(plan2.verdict.kind, 'continue')
    assert.equal(missing.stats().failed, 1)
    assert.match(missing.stats().recent[0].detail, /找不到 fixture/)
  })
}

console.log('\n== 响应阶段动作 ==')
{
  const responseCtx = ctx({ status: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }] })

  await check('rewriteBody 跑脚本并去掉 content-length', async () => {
    const engine = engineWith([
      rule({
        stage: 'response',
        match: { urlPattern: '*', statusCode: [200] },
        action: { kind: 'rewriteBody', script: "return body.replace('\"debug\":false', '\"debug\":true')" }
      })
    ])
    const plan = await engine.planResponse(
      ctx({
        status: 200,
        responseHeaders: [
          { name: 'content-type', value: 'application/json' },
          { name: 'content-length', value: '18' }
        ]
      }),
      { text: '{"debug":false,"a":1}', isBinary: false }
    )
    assert.equal(plan.verdict.kind, 'fulfill')
    assert.equal(plan.verdict.body, '{"debug":true,"a":1}')
    assert.equal(plan.verdict.headers.some((h) => h.name === 'content-length'), false)
    assert.equal(engine.stats().bodiesRewritten, 1)
  })

  await check('脚本拿到 ctx', async () => {
    const engine = engineWith([
      rule({
        stage: 'response',
        action: { kind: 'rewriteBody', script: 'return ctx.method + " " + ctx.status + " " + ctx.url' }
      })
    ])
    const plan = await engine.planResponse(responseCtx, { text: 'x', isBinary: false })
    assert.equal(plan.verdict.body, 'GET 200 https://api.example.com/v1/users')
  })

  await check('脚本不返回字符串 = 不改（不算失败）', async () => {
    const engine = engineWith([
      rule({ stage: 'response', action: { kind: 'rewriteBody', script: 'const x = 1' } })
    ])
    const plan = await engine.planResponse(responseCtx, { text: 'x', isBinary: false })
    assert.equal(plan.verdict.kind, 'continue')
    assert.equal(engine.stats().failed, 0)
    assert.equal(engine.stats().applied, 1)
  })

  await check('脚本抛异常 = 失败但放行', async () => {
    const engine = engineWith([
      rule({ stage: 'response', action: { kind: 'rewriteBody', script: 'throw new Error("boom")' } })
    ])
    const plan = await engine.planResponse(responseCtx, { text: 'x', isBinary: false })
    assert.equal(plan.verdict.kind, 'continue')
    assert.match(engine.stats().recent[0].detail, /boom/)
  })

  await check('脚本死循环会被超时掐掉', async () => {
    const engine = engineWith([
      rule({ stage: 'response', action: { kind: 'rewriteBody', script: 'while (true) {}' } })
    ])
    const plan = await engine.planResponse(responseCtx, { text: 'x', isBinary: false })
    assert.equal(plan.verdict.kind, 'continue')
    assert.equal(engine.stats().timeouts, 1)
  })

  await check('二进制响应不改写（base64 往返会毁字节）', async () => {
    const engine = engineWith([
      rule({ stage: 'response', action: { kind: 'rewriteBody', script: 'return "x"' } })
    ])
    const plan = await engine.planResponse(responseCtx, { text: 'AAEC', isBinary: true })
    assert.equal(plan.verdict.kind, 'continue')
    assert.equal(engine.stats().skippedBinary, 1)
    assert.equal(engine.stats().bodiesRewritten, 0)
  })

  await check('沙箱里没有 process / require', async () => {
    const engine = engineWith([
      rule({
        stage: 'response',
        action: {
          kind: 'rewriteBody',
          script: 'return [typeof process, typeof require, typeof globalThis.process].join(",")'
        }
      })
    ])
    const plan = await engine.planResponse(responseCtx, { text: 'x', isBinary: false })
    assert.equal(plan.verdict.body, 'undefined,undefined,undefined')
  })

  await check('响应的 rewriteHeaders 走 continue 而不是 fulfill', async () => {
    const engine = engineWith([
      rule({
        stage: 'response',
        action: { kind: 'rewriteHeaders', set: { 'access-control-allow-origin': '*' } }
      })
    ])
    const plan = await engine.planResponse(responseCtx, { text: 'x', isBinary: false })
    assert.equal(plan.verdict.kind, 'continue')
    assert.deepEqual(plan.verdict.headers, [
      { name: 'content-type', value: 'application/json' },
      { name: 'access-control-allow-origin', value: '*' }
    ])
  })
}

console.log('\n== 拦截范围要窄（每条被拦的请求都是一次管道往返）==')
{
  const engine = engineWith([
    rule({ match: { urlPattern: '*://api.example.com/v1/*' }, action: { kind: 'block' } }),
    rule({ match: { urlPattern: '*://*.tracker.net/*' }, action: { kind: 'block' } }),
    rule({ match: { urlPattern: 're:.*\\.js$' }, action: { kind: 'block' } }),
    rule({ match: { urlPattern: '*', resourceType: ['Image', 'Font'] }, action: { kind: 'block' } })
  ])
  const patterns = engine.requestPatterns()
  check('精确 host 只拦那个域，但两种端口写法都发', () => {
    assert.ok(patterns.some((p) => p.urlPattern === '*://api.example.com/*'))
    assert.ok(patterns.some((p) => p.urlPattern === '*://api.example.com:*/*'))
    assert.ok(patterns.every((p) => !/example\.com/.test(p.urlPattern ?? '') || /api\.example\.com/.test(p.urlPattern)))
  })
  check('host:* 也归到同一个 host 桶', () =>
    assert.deepEqual(
      engineWith([
        rule({ match: { urlPattern: '*://api.example.com:*/v1/*' }, action: { kind: 'block' } })
      ]).requestPatterns().map((p) => p.urlPattern),
      ['*://api.example.com:*/*', '*://api.example.com/*']
    ))
  check('后缀 host 两种写法都发', () =>
    assert.ok(
      patterns.some((p) => p.urlPattern === '*://*.tracker.net/*') &&
        patterns.some((p) => p.urlPattern === '*://tracker.net/*')
    ))
  check('正则规则只能退化成全量拦', () =>
    assert.ok(patterns.some((p) => p.urlPattern === '*')))
  check('写了 resourceType 的按类型拆开', () => {
    const types = patterns.filter((p) => p.resourceType).map((p) => p.resourceType)
    assert.deepEqual(types.sort(), ['Font', 'Image'])
  })
  check('pattern 去重', () => {
    const keys = patterns.map((p) => `${p.urlPattern}|${p.resourceType ?? ''}`)
    assert.equal(new Set(keys).size, keys.length)
  })
}

console.log('\n== 响应阶段也要有拦截范围（关掉 body 采集时规则的唯一命门）==')
{
  const engine = engineWith([
    rule({
      id: 'res',
      stage: 'response',
      action: { kind: 'rewriteBody', script: 'return body' },
      match: { urlPattern: '*://api.example.com/v1/*' }
    }),
    rule({ id: 'req', action: { kind: 'block' }, match: { urlPattern: '*://req.example.com/*' } })
  ])
  check('响应规则单独出一份 Response pattern（空的话规则会静默失效）', () => {
    const patterns = engine.responsePatterns()
    assert.ok(patterns.length > 0, 'responsePatterns() 是空的')
    assert.ok(
      patterns.every((p) => p.requestStage === 'Response'),
      'requestStage 不是 Response: ' + JSON.stringify(patterns)
    )
    assert.ok(patterns.some((p) => p.urlPattern === '*://api.example.com:*/*'))
  })
  check('两个阶段的 pattern 互不串台', () => {
    assert.ok(
      engine.responsePatterns().every((p) => !/req\.example\.com/.test(p.urlPattern ?? '')),
      '响应 pattern 里混进了请求规则'
    )
    assert.ok(
      engine.requestPatterns().every((p) => !/api\.example\.com/.test(p.urlPattern ?? '')),
      '请求 pattern 里混进了响应规则'
    )
  })
}

console.log('\n== 匹配开销（§6.2 要求 < 50µs/请求）==')
{
  const HOSTS = 200
  const rules = []
  for (let i = 0; i < HOSTS; i++) {
    for (let j = 0; j < 10; j++) {
      rules.push(
        rule({
          id: `r${i}-${j}`,
          priority: j,
          match: {
            urlPattern: `*://h${i}.example.com/api/${j}/*`,
            method: ['GET', 'POST'],
            resourceType: ['XHR', 'Fetch']
          },
          action: { kind: 'rewriteHeaders', set: { 'x-a': '1' } }
        })
      )
    }
  }
  const engine = engineWith(rules)
  assert.equal(engine.stats().total, 2000)

  const urls = []
  for (let i = 0; i < 1000; i++) {
    const host = `h${i % HOSTS}.example.com`
    urls.push({
      url: `https://${host}/api/${i % 10}/item/${i}`,
      method: 'GET',
      resourceType: 'XHR',
      targetType: 'page',
      requestHeaders: []
    })
  }

  // 预热，别把 JIT 的账算进去
  for (let round = 0; round < 2; round++) {
    for (const item of urls) await engine.planRequest(item)
  }
  engine.resetStats()

  const started = process.hrtime.bigint()
  let hits = 0
  const N = 5
  for (let round = 0; round < N; round++) {
    for (const item of urls) {
      const plan = await engine.planRequest(item)
      if (plan.ruleId) hits += 1
    }
  }
  const totalUs = Number(process.hrtime.bigint() - started) / 1000
  const perRequest = totalUs / (urls.length * N)

  console.log(
    `  2000 条规则 / ${urls.length * N} 次匹配 = 平均 ${perRequest.toFixed(2)}µs/次` +
      `（引擎内部计时 ${engine.stats().avgMatchUs.toFixed(2)}µs，最大 ${engine.stats().maxMatchUs.toFixed(1)}µs）`
  )
  check('每次匹配（含动作执行）平均 < 50µs', () =>
    assert.ok(perRequest < 50, `实际 ${perRequest.toFixed(2)}µs`))
  check('全部命中且没走错规则', () =>
    assert.equal(hits, urls.length * N, `命中 ${hits}`))
}

console.log('\n== 统计 ==')
{
  // pattern 要窄：`*` 匹配一切，第二条 planRequest 也会命中
  const engine = engineWith([
    rule({ match: { urlPattern: '*://api.example.com/*' }, action: { kind: 'block' } })
  ])
  await engine.planRequest(ctx())
  await engine.planRequest(ctx({ url: 'https://nope.test/x' }))
  const stats = engine.stats()
  check('matched/applied 分开记', () => {
    assert.equal(stats.matched, 1)
    assert.equal(stats.applied, 1)
    assert.equal(stats.failed, 0)
  })
  check('recent 里有命中记录', () => {
    assert.equal(stats.recent.length, 1)
    assert.equal(stats.recent[0].kind, 'block')
    assert.equal(stats.recent[0].ok, true)
  })
  check('改写成功率 = applied / matched', () =>
    assert.equal(stats.matched === 0 ? 1 : stats.applied / stats.matched, 1))
}

console.log('\n== CDP 头部的两种形态 ==')
{
  check('request.headers 是对象时也能改（CDP 给的就是对象）', () =>
    assert.deepEqual(applyHeaders({ host: 'a.test', 'x-a': '1' }, { 'X-A': '2' }, ['Host']), [
      { name: 'x-a', value: '2' }
    ]))
  check('数组形态照旧', () =>
    assert.deepEqual(applyHeaders([{ name: 'x-a', value: '1' }], undefined, ['x-a']), []))
  check('set 里没有的头原样保留', () =>
    assert.deepEqual(applyHeaders({ 'x-a': '1' }, { 'x-b': '2' }), [
      { name: 'x-a', value: '1' },
      { name: 'x-b', value: '2' }
    ]))
}

console.log('\n== 规则文件（面板与验收脚本的接口）==')
{
  const file = join(dir, 'rules.json')
  const set = {
    version: 1,
    rules: [rule({ id: 'a' }), rule({ id: 'b' })],
    fixtures: { f: { status: 201, body: '{}' } },
    injections: [{ id: 'i', name: 'n', enabled: true, urlPattern: '', code: 'x', runAt: 'document_start' }]
  }
  check('写进去能原样读回来', () => {
    writeRuleSet(file, set)
    const back = readRuleSet(file)
    assert.equal(back.rules.length, 2)
    assert.equal(back.rules[0].id, 'a')
    assert.equal(back.fixtures.f.status, 201)
    assert.equal(back.injections[0].id, 'i')
  })
  check('目录不存在也能写（自动建）', () => {
    const nested = join(dir, 'deep', 'nested', 'rules.json')
    writeRuleSet(nested, set)
    assert.equal(readRuleSet(nested).rules.length, 2)
  })
  check('文件不存在 = 空规则，不是报错', () =>
    assert.deepEqual(readRuleSet(join(dir, 'nope.json')), emptyRuleSet()))
  check('文件坏了 = 空规则 + 留一条日志', () => {
    const broken = join(dir, 'broken.json')
    writeFileSync(broken, '{ this is not json', 'utf8')
    const lines = []
    const back = readRuleSet(broken, (line) => lines.push(line))
    assert.deepEqual(back, emptyRuleSet())
    assert.equal(lines.length, 1)
    assert.match(lines[0], /解析失败/)
    unlinkSync(broken)
  })
  check('字段类型不对会被兜住（人手改过也不会炸）', () => {
    const weird = join(dir, 'weird.json')
    writeFileSync(weird, JSON.stringify({ version: 'x', rules: {}, fixtures: 7, injections: 'no' }), 'utf8')
    const back = readRuleSet(weird)
    assert.equal(back.version, 1)
    assert.deepEqual(back.rules, [])
    assert.deepEqual(back.fixtures, {})
    assert.deepEqual(back.injections, [])
  })
}

/* ------------------------------------------- 代理层规则映射（§6.3 第 2 条） */

{
  const rs = (over) => ({
    version: 1,
    rules: [],
    fixtures: {},
    injections: [],
    ...over
  })
  const bodyRule = (id, extra = {}) =>
    rule({
      id,
      name: id,
      priority: extra.priority ?? 0,
      enabled: extra.enabled ?? true,
      stage: 'response',
      action: { kind: 'rewriteBody', script: extra.script ?? "return body" },
      match: { urlPattern: 'https://a.example/*', ...(extra.match ?? {}) }
    })

  const set = rs({
    rules: [
      rule({ id: 'req-block', name: 'req-block', stage: 'request', action: { kind: 'block' } }),
      rule({
        id: 'resp-headers',
        name: 'resp-headers',
        stage: 'response',
        action: { kind: 'rewriteHeaders', set: { 'x-a': 'b' } }
      }),
      bodyRule('body-glob', { priority: 1 }),
      bodyRule('body-re', {
        priority: 5,
        match: { urlPattern: 're:^https://b\\.example/.*$', method: ['get'], statusCode: [200, 304] }
      }),
      bodyRule('body-hi', { priority: 9, match: { urlPattern: 'https://c.example/*' } }),
      bodyRule('body-off', { enabled: false }),
      bodyRule('body-rt', { match: { urlPattern: 'https://d.example/*', resourceType: ['Document'] } }),
      bodyRule('body-frame', { match: { urlPattern: 'https://e.example/*', frameUrl: 'https://*.example/*' } }),
      bodyRule('body-target', { match: { urlPattern: 'https://f.example/*', targetType: ['page'] } })
    ]
  })

  const plan = toProxyRules(set)

  check('只下发 rewriteBody 的响应规则（改头/拦截/禁用都不发，避免两边各执行一次）', () =>
    assert.deepEqual(
      plan.rules.map((r) => r.id),
      ['body-hi', 'body-re', 'body-glob']
    ))

  check('下发顺序 = 优先级：priority 降序、同号按列表顺序（代理取第一条即最高优先级）', () => {
    const same = toProxyRules(
      rs({ rules: [bodyRule('a', { priority: 3 }), bodyRule('b', { priority: 3 }), bodyRule('c', { priority: 4 })] })
    )
    assert.deepEqual(same.rules.map((r) => r.id), ['c', 'a', 'b'])
  })

  check('glob 编译成正则、re: 原样带过去（代理和主进程一套匹配语义）', () => {
    const glob = plan.rules.find((r) => r.id === 'body-glob')
    const globRe = new RegExp(glob.urlRegex, glob.urlFlags ?? '')
    assert.ok(globRe.test('https://a.example/x/y'), 'glob 正则匹配不上自己的 URL')
    assert.ok(!globRe.test('https://z.example/x'), 'glob 正则匹配了别的域')
    assert.equal(globRe.source, globToRegex('https://a.example/*').source, '和主进程 matcher 编译出的正则不一致')

    const re = plan.rules.find((r) => r.id === 'body-re')
    assert.equal(re.urlRegex, new RegExp('^https://b\\.example/.*$').source, 're: 的正则源被改动了')
    assert.deepEqual(re.statuses, [200, 304], 'statusCode 没带过去')
    assert.ok(re.bodyScript.includes('body'), 'bodyScript 没带过去')
  })

  check('代理拿不到匹配信号的规则不下发，且如实记进 skipped（漏改要能看出来）', () => {
    assert.deepEqual(
      plan.skipped.map((p) => p.ruleId).sort(),
      ['body-frame', 'body-rt', 'body-target']
    )
    for (const p of plan.skipped) assert.ok(p.message.length > 0, 'skipped 没有原因')
  })

  check('urlPattern 不合法的 re: 记 skipped 而不是静默丢掉', () => {
    const bad = toProxyRules(rs({ rules: [bodyRule('bad-re', { match: { urlPattern: 're:([a-z' } })] }))
    assert.equal(bad.rules.length, 0)
    assert.equal(bad.skipped.length, 1)
    assert.match(bad.skipped[0].message, /不是合法正则/)
  })

  check('非 response 阶段/空的规则集返回空计划，不炸', () => {
    assert.deepEqual(toProxyRules(rs({})), { rules: [], skipped: [] })
    assert.deepEqual(toProxyRules(rs({ rules: [bodyRule('x', { match: { urlPattern: '   ' } })] })).rules, [])
  })
}

const failed = results.filter((row) => !row.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
rmSync(dir, { recursive: true, force: true })
if (failed.length) process.exitCode = 1
