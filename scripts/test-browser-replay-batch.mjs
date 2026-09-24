#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, makeChecker, sleep } from './app-harness.mjs'
import { startOrigin } from './test-origin.mjs'

const { check, assert, report } = makeChecker(); const dataDir = mkdtempSync(join(tmpdir(), 'monitor-execution-')); const origin = await startOrigin(0); const base = `http://127.0.0.1:${origin.port}`; let app = null
const action = async (name, input = {}, targetKind = 'workspace', targetExtra = {}) => app.evaluate(`(async()=>{const w=await window.monitor.getWorkspaces();return window.monitor.executeAction({action:${JSON.stringify(name)},input:${JSON.stringify(input)},target:{kind:${JSON.stringify(targetKind)},workspaceId:w.output.activeWorkspaceId,...${JSON.stringify(targetExtra)}}})})()`)

try {
  app = await launchApp({ url: `${base}/`, dataDir, port: 9635, tab: 'browser', extraEnv: { MONITOR_CAPTURE_BODIES: '1' } }); await app.waitConnected(5)
  const tree = await action('browser.tree'); const initial = tree.output.tabs[0]
  check('T-025 Browser/Tab/Frame 树带稳定 target 与 document generation', () => { assert(initial.targetId && initial.generation >= 0, '缺少稳定 Tab 引用'); assert(initial.frames.length >= 2, `Frame 树不完整：${initial.frames.length}`) })
  const created = await action('browser.tabCreate', { url: `${base}/dom-probe.html` }); await sleep(800); const tree2 = await action('browser.tree'); const newTab = tree2.output.tabs.find(item => item.targetId === created.output.targetId)
  check('T-025 显式工作区创建标签并进入对象树', () => assert(newTab?.url.includes('dom-probe'), '新标签未 attach'))
  const tabTarget = { browserId: 'primary', tabId: initial.targetId }
  const reload = await action('tab.command', { generation: initial.generation, command: { kind: 'reload', ignoreCache: true } }, 'tab', tabTarget); await sleep(600)
  const afterReload = await action('browser.tree'); const refreshed = afterReload.output.tabs.find(item => item.targetId === initial.targetId)
  const stale = await action('tab.command', { generation: initial.generation, command: { kind: 'navigate', url: `${base}/dom-probe.html` } }, 'tab', tabTarget)
  check('T-025 刷新推进代次，旧 Tab 引用明确拒绝且动作留证', () => { assert(reload.output.ok === true, reload.output.error ?? 'reload failed'); assert(refreshed.generation > initial.generation, '代次未推进'); assert(stale.output.ok === false && stale.output.error.includes('过期'), '旧引用未拒绝') })
  const wait = await action('tab.command', { generation: refreshed.generation, command: { kind: 'wait', condition: 'selector', value: 'iframe', timeoutMs: 3000 } }, 'tab', tabTarget)
  const timeline = await action('browser.timeline', { limit: 20 })
  check('T-025 条件等待和动作时间线可回溯', () => { assert(wait.output.ok === true, wait.output.error ?? 'wait failed'); assert(timeline.output.some(item => item.actionId === wait.output.actionId), '时间线缺少等待动作') })

  await app.evaluate(`window.monitor.evaluate(${JSON.stringify(`fetch('${base}/api/json-echo?seed=source',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({user:'source',n:1})}).then(r=>r.json())`)})`); await sleep(800)
  const rows = await app.evaluate(`window.monitor.queryRequests(${JSON.stringify({ urlPattern: '/api/json-echo?seed=source' })},20,0,'time_desc')`); const seq = rows.rows[0]?.seq; assert(seq, '找不到源请求')
  const derived = await action('replay.createFromRequest', { seq, name: 'echo replay' }); const template = derived.output
  const saved = await action('replay.save', { ...template, url: `${base}/api/json-echo?replayed=1`, headers: [...template.headers, { name: 'x-repeat', value: 'a' }, { name: 'x-repeat', value: 'b' }], body: { kind: 'text', value: JSON.stringify({ user: 'replayed', n: 7, extra: true }), contentType: 'application/json' } })
  const independent = await action('replay.run', { templateId: saved.output.id, version: saved.output.version, mode: 'independent', confirmWrite: true }); const browser = await action('replay.run', { templateId: saved.output.id, version: saved.output.version, mode: 'browser', confirmWrite: true })
  check('T-026 历史请求派生不可变模板，新版本以双执行器真实重放', () => { assert(template.version === 1 && saved.output.version === 2, '版本没有递增'); assert(independent.output.state === 'succeeded' && independent.output.response?.status === 200, independent.output.error ?? JSON.stringify(independent.output)); assert(browser.output.state === 'succeeded' && browser.output.response?.status === 200, browser.output.error ?? JSON.stringify(browser.output)); assert(independent.output.response.bodyHash && browser.output.response.bodyHash, '结果正文未绑定证据') })
  const denied = await action('replay.run', { templateId: saved.output.id, version: saved.output.version, mode: 'independent' })
  check('T-026 写请求没有显式确认时拒绝', () => assert(denied.task.state === 'failed' && denied.task.error.message.includes('confirmWrite'), '写请求被静默执行'))

  for (const iterations of [1, 10, 100]) {
    const suite = await action('tests.save', { name: `echo-${iterations}`, templateId: saved.output.id, mode: 'independent', iterations, concurrency: Math.min(5, iterations), intervalMs: 0, retries: 1, stopOnFailure: false, datasets: [{ user: 'A' }, { user: 'B' }], assertions: [{ kind: 'status', op: 'eq', value: 200 }, { kind: 'header', name: 'content-type', contains: 'application/json' }, { kind: 'json', path: 'echo.n', equals: 7 }, { kind: 'body', contains: 'replayed' }, { kind: 'time', maxMs: 5000 }], preScript: "variables.scoped='case-'+variables.iteration" })
    const run = await action('tests.run', { suiteId: suite.output.id, version: suite.output.version })
    check(`T-027 ${iterations} 次批量运行 case/attempt/延迟统计准确`, () => { const summary = run.output.summary; assert(summary.total === iterations && summary.passed === iterations, JSON.stringify(summary)); assert(summary.attempts === iterations, `attempts=${summary.attempts}`); assert(summary.latency.samples === iterations && summary.latency.p95 >= 0, '延迟样本错误') })
  }
  const badSuite = await action('tests.save', { name: 'failure-group', templateId: saved.output.id, mode: 'independent', iterations: 3, concurrency: 1, intervalMs: 0, retries: 1, stopOnFailure: true, datasets: [{}], assertions: [{ kind: 'status', op: 'eq', value: 500 }] })
  const badRun = await action('tests.run', { suiteId: badSuite.output.id, version: badSuite.output.version })
  check('T-027 断言失败、重试和 stopOnFailure 区分 attempt/notStarted', () => { assert(badRun.output.summary.failed === 1, JSON.stringify(badRun.output.summary)); assert(badRun.output.summary.notStarted === 2, '未运行 case 计数错误'); assert(badRun.output.summary.attempts === 2, '重试 attempt 计数错误') })
} catch (error) { check('T-025～T-027 综合验收流程', () => { throw error }) }
finally { if (app) await app.close(); await origin.close(); rmSync(dataDir, { recursive: true, force: true }) }
process.exit(report() ? 0 : 1)
