#!/usr/bin/env node
/**
 * T-001 验收：统一动作协议必须穿过 UI → IPC、HTTP 和 MCP，且三者共享同一任务账本。
 * 任务服务的取消 / unknown 在构建产物上直接验，避免为测试给产品动作加隐藏后门。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startOrigin } from './test-origin.mjs'
import { launchApp, makeChecker, sleep, ROOT } from './app-harness.mjs'
import { McpClient } from './mcp-client.mjs'

const { check, assert, report } = makeChecker()
const dataDir = mkdtempSync(join(tmpdir(), 'monitor-actions-'))
const origin = await startOrigin(0)
const port = Number(process.env['ACTION_CDP_PORT'] ?? 9525)
let app = null
let mcp = null

async function control(path, options = {}) {
  const infoPath = join(dataDir, 'control.json')
  let info = null
  for (let attempt = 0; attempt < 80 && !info; attempt += 1) {
    if (existsSync(infoPath)) {
      try {
        const candidate = JSON.parse(readFileSync(infoPath, 'utf8'))
        if (candidate?.port && candidate?.token) info = candidate
      } catch { /* 原子替换中 */ }
    }
    if (!info) await sleep(100)
  }
  if (!info) throw new Error('等不到控制服务')
  const response = await fetch(`http://${info.host ?? '127.0.0.1'}:${info.port}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${info.token}`, ...(options.body ? { 'content-type': 'application/json' } : {}) }
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
  return body
}

try {
  app = await launchApp({
    url: `http://127.0.0.1:${origin.port}/dom-probe.html`, dataDir, port, tab: 'list',
    extraEnv: { MONITOR_MAX_ACTIVE_WORKSPACES: '2' }
  })
  await app.waitConnected(1)

  const request = {
    action: 'workspace.create', input: { name: '协议共享工作区', profile: 'L' },
    target: { kind: 'workspace-collection' }, idempotencyKey: 'acceptance-shared-create'
  }
  const ui = await app.evaluate(`window.monitor.executeAction(${JSON.stringify(request)})`)
  const http = await control('/actions/execute', { method: 'POST', body: JSON.stringify(request) })
  mcp = McpClient.spawn(process.execPath, [join(ROOT, 'mcp', 'server.mjs')], { cwd: ROOT, env: { ...process.env, MONITOR_DATA_DIR: dataDir } })
  await mcp.initialize('action-acceptance')
  const viaMcp = await mcp.callJson('monitor_action_execute', request)
  check('UI、HTTP、MCP 共享同一结构与同一幂等任务', () => {
    assert(ui.task.id === http.task.id && ui.task.id === viaMcp.task.id, '三入口没有复用 taskId')
    assert(ui.task.state === 'succeeded', `任务状态不是 succeeded：${ui.task.state}`)
    assert(ui.output?.id === http.output?.id && ui.output?.id === viaMcp.output?.id, '三入口领域输出不一致')
    assert(ui.task.inputHash === http.task.inputHash, '输入哈希不一致')
  })

  const catalog = await mcp.callJson('monitor_action_catalog', {})
  check('Agent 可发现动作及目标约束', () => {
    assert(catalog.actions.some((item) => item.name === 'workspace.open' && item.target === 'required'), 'catalog 缺 workspace.open 的 target 约束')
  })

  const conflict = await app.evaluate(`window.monitor.executeAction(${JSON.stringify({ ...request, input: { name: '不同输入', profile: 'L' } })}).then(
    () => null, (error) => String(error)
  )`)
  check('相同幂等键与不同输入明确冲突', () => {
    assert(/幂等键/.test(conflict ?? ''), `没有收到幂等冲突：${conflict}`)
  })

  const missingTarget = await app.evaluate("window.monitor.executeAction({ action: 'workspace.open', input: {} }).then(() => null, (error) => String(error))")
  const staleTarget = await app.evaluate(`window.monitor.executeAction({ action: 'workspace.open', input: {}, target: { kind: 'workspace', workspaceId: ${JSON.stringify(ui.output.id)}, expectedVersion: 0 } }).then(() => null, (error) => String(error))`)
  check('写动作缺失或过期 TargetRef 不会回退到当前工作区', () => {
    assert(/TargetRef/.test(missingTarget ?? ''), `缺失目标没有被拒绝：${missingTarget}`)
    assert(/过期/.test(staleTarget ?? ''), `过期目标没有被拒绝：${staleTarget}`)
  })

  const workflowTarget = { kind: 'workspace', workspaceId: ui.output.id }
  const savedWorkflow = await control('/actions/execute', { method: 'POST', body: JSON.stringify({ action: 'workflow.save', target: workflowTarget, input: { name: '异步协议验收', nodes: [{ id: 'delay', kind: 'wait', wait: { type: 'delay', ms: 800 } }] } }) })
  const asyncStartedAt = Date.now()
  const asyncTask = await control('/actions/start', { method: 'POST', body: JSON.stringify({ action: 'workflow.start', target: workflowTarget, input: { workflowId: savedWorkflow.output.id } }) })
  const asyncReturnMs = Date.now() - asyncStartedAt
  let asyncResult = null
  for (let attempt = 0; attempt < 50; attempt += 1) {
    asyncResult = await control(`/tasks/${asyncTask.id}`)
    if (!['queued', 'running'].includes(asyncResult?.task?.state)) break
    await sleep(50)
  }
  const firstEvents = await control('/tasks/events?after=0&limit=1000')
  const cursorEvents = await control(`/tasks/events?after=${firstEvents.nextCursor}&limit=1000`)
  const ownEvents = firstEvents.rows.filter((item) => item.taskId === asyncTask.id)
  check('长任务启动立即返回，结果与事件游标可恢复读取', () => {
    assert(asyncReturnMs < 500, `启动阻塞了 ${asyncReturnMs}ms`)
    assert(asyncResult?.task?.state === 'succeeded', `最终状态：${asyncResult?.task?.state}`)
    assert(ownEvents.some((item) => item.type === 'running') && ownEvents.some((item) => item.type === 'succeeded'), JSON.stringify(ownEvents))
    assert(cursorEvents.rows.length === 0 && cursorEvents.nextCursor === firstEvents.nextCursor, '相同 cursor 重复返回事件')
  })

  const taskBuildDir = mkdtempSync(join(tmpdir(), 'monitor-task-service-'))
  execFileSync(process.execPath, [
    join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--rootDir', join(ROOT, 'src'), '--outDir', taskBuildDir,
    join(ROOT, 'src', 'main', 'actions', 'task-service.ts'),
    join(ROOT, 'src', 'main', 'content', 'evidence.ts'),
    join(ROOT, 'src', 'shared', 'contracts', 'action.ts')
  ], { cwd: ROOT, stdio: 'pipe' })
  const { TaskService } = await import(pathToFileURL(join(taskBuildDir, 'main', 'actions', 'task-service.js')).href)
  const { RemoteEffectUnknownError } = await import(pathToFileURL(join(taskBuildDir, 'shared', 'contracts', 'action.js')).href)
  const tasks = new TaskService()
  const unknown = await tasks.execute({ action: 'test.unknown', input: {} }, async () => { throw new RemoteEffectUnknownError('连接中断，远端效果未知') })
  let taskId = ''
  let release = () => {}
  const pending = tasks.execute({ action: 'test.cancel', input: {} }, async (_input, context) => {
    taskId = context.task.id
    await new Promise((resolve) => { release = resolve })
    return { ok: true }
  })
  while (!taskId) await sleep(1)
  const canceled = tasks.cancel(taskId)
  const canceledAgain = tasks.cancel(taskId)
  release()
  const canceledResult = await pending
  const canceledEvents = tasks.readEvents(0, 100).rows.filter((item) => item.taskId === taskId)
  check('任务取消与远端效果 unknown 有明确状态', () => {
    assert(unknown.task.state === 'unknown' && unknown.task.error?.code === 'effect_unknown', 'unknown 状态或错误码不正确')
    assert(canceled.state === 'canceled' && canceledAgain.state === 'canceled' && canceledResult.task.state === 'canceled', '取消没有稳定落为 canceled')
    assert(canceledEvents.filter((item) => item.type === 'canceled').length === 1, '重复取消或 handler 收尾写入了多个终态事件')
    assert(canceledEvents.every((item, index) => index === 0 || item.cursor > canceledEvents[index - 1].cursor), '任务事件游标未单调递增')
  })
  const journal = join(taskBuildDir, 'journal.json')
  const persisted = new TaskService({ journalPath: journal })
  const first = await persisted.execute({ action: 'test.persist', input: { n: 1 }, idempotencyKey: 'persist-key' }, async () => ({ ok: true }))
  const restarted = new TaskService({ journalPath: journal })
  const replay = await restarted.execute({ action: 'test.persist', input: { n: 1 }, idempotencyKey: 'persist-key' }, async () => { throw new Error('不应重复执行') })
  check('任务账本重启后保留幂等结果', () => {
    assert(first.task.id === replay.task.id && replay.task.state === 'succeeded', '重启后没有复用持久任务')
  })
  const pendingJournal = join(taskBuildDir, 'running.json')
  const runningTasks = new TaskService({ journalPath: pendingJournal })
  let runningRelease = () => {}
  let started = false
  const inFlight = runningTasks.execute({ action: 'test.running', input: {}, idempotencyKey: 'running-key' }, async () => {
    started = true
    await new Promise((resolve) => { runningRelease = resolve })
    return { ok: true }
  })
  while (!started) await sleep(1)
  const recovered = new TaskService({ journalPath: pendingJournal })
  const uncertain = await recovered.execute({ action: 'test.running', input: {}, idempotencyKey: 'running-key' }, async () => { throw new Error('不得重放') })
  check('运行中任务落盘且重启后恢复为 unknown，不重复执行', () => {
    assert(uncertain.task.state === 'unknown', `恢复状态错误：${uncertain.task.state}`)
    assert(recovered.diagnostics().recoveredUnknown === 1, '恢复诊断未计数')
  })
  runningRelease()
  await inFlight
  const corruptPath = join(taskBuildDir, 'corrupt.json')
  writeFileSync(corruptPath, '{partial')
  const corrupt = new TaskService({ journalPath: corruptPath })
  check('损坏任务日志隔离备份，服务仍可启动并给出诊断', () => {
    const diagnostic = corrupt.diagnostics()
    assert(diagnostic.corrupt && diagnostic.corruptBackup, '未报告损坏备份')
    assert(existsSync(join(taskBuildDir, diagnostic.corruptBackup)), '损坏日志备份不存在')
  })
  const { CaptureEvidenceLedger } = await import(pathToFileURL(join(taskBuildDir, 'main', 'content', 'evidence.js')).href)
  const ledger = new CaptureEvidenceLedger(join(taskBuildDir, 'capture-evidence-test'))
  await ledger.record({ inst: 1, seq: 17, phase: 'fetch', state: 'timeout', size: 1024 })
  const gapSummary = await ledger.summary()
  const gapEntries = await ledger.entries(1, 17)
  check('采集失败按原因汇总并可按请求追溯', () => {
    assert(gapSummary.gaps === 1 && gapSummary.byReason.timeout === 1, '缺口原因统计错误')
    assert(gapEntries.length === 1 && gapEntries[0].phase === 'fetch' && gapEntries[0].size === 1024, '请求证据不完整')
  })
  const evidencePath = join(taskBuildDir, 'capture-evidence-test', 'capture-evidence.jsonl')
  writeFileSync(evidencePath, readFileSync(evidencePath, 'utf8').replace('timeout', 'tampered'))
  const tampered = await ledger.summary()
  check('篡改后的证据链不再报告可信', () => {
    assert(!tampered.chainValid && tampered.lastError === 'evidence_chain_invalid', '证据篡改未被识别')
  })
  const uiDiagnostics = await app.evaluate("window.monitor.executeAction({action:'tasks.diagnostics',input:{}})")
  const httpDiagnostics = await control('/tasks/diagnostics')
  const mcpDiagnostics = await mcp.callJson('monitor_task_diagnostics', {})
  check('任务诊断可从 UI、HTTP、MCP 读取', () => {
    for (const result of [uiDiagnostics, httpDiagnostics, mcpDiagnostics]) {
      assert(result.task?.state === 'succeeded' && typeof result.output?.taskCount === 'number', '任务诊断结构不正确')
    }
  })
  const secondId = ui.output.id
  const targetedRule = { version: 1, rules: [{ id: 'target-test', name: 'target-test', enabled: false, priority: 1, match: { urlPattern: '*example.com*' }, stage: 'request', action: { kind: 'block' } }], fixtures: {}, injections: [] }
  const saveRule = { action: 'rules.save', target: { kind: 'workspace', workspaceId: secondId }, input: { set: targetedRule }, idempotencyKey: 'targeted-rules-test' }
  const savedUi = await app.evaluate(`window.monitor.executeAction(${JSON.stringify(saveRule)})`)
  const savedHttp = await control('/actions/execute', { method: 'POST', body: JSON.stringify(saveRule) })
  const savedMcp = await mcp.callJson('monitor_rules_set', { workspaceId: secondId, rules: targetedRule, idempotencyKey: 'targeted-rules-test' })
  const ownRules = await app.evaluate(`window.monitor.executeAction({action:'rules.get',target:{kind:'workspace',workspaceId:${JSON.stringify(secondId)}},input:{}})`)
  const defaultRules = await control('/workspaces/default/rules')
  check('规则写入显式目标且三入口幂等，未污染活动工作区', () => {
    assert(savedUi.task.state === 'succeeded' && savedUi.task.id === savedHttp.task.id && savedUi.task.id === savedMcp.task.id, '规则三入口任务不一致')
    assert(ownRules.output.rules.some((rule) => rule.id === 'target-test'), '目标工作区规则未保存')
    assert(!defaultRules.output.rules.some((rule) => rule.id === 'target-test'), '活动工作区规则被串写')
  })
  const rulesMissing = await app.evaluate(`window.monitor.executeAction({action:'rules.save',input:{set:${JSON.stringify(targetedRule)}}}).then(() => null, (error) => String(error))`)
  const rulesStale = await app.evaluate(`window.monitor.executeAction({action:'rules.save',target:{kind:'workspace',workspaceId:${JSON.stringify(secondId)},expectedVersion:0},input:{set:${JSON.stringify(targetedRule)}}}).then(() => null, (error) => String(error))`)
  check('规则保存拒绝缺失或过期工作区目标', () => {
    assert(/TargetRef/.test(rulesMissing ?? '') && /过期/.test(rulesStale ?? ''), '规则目标守卫未生效')
  })
  rmSync(taskBuildDir, { recursive: true, force: true })
} catch (error) {
  check('统一动作协议端到端流程', () => { throw error })
} finally {
  mcp?.close()
  if (app) await app.close()
  await origin.close()
  rmSync(dataDir, { recursive: true, force: true })
}

process.exit(report() ? 0 : 1)
