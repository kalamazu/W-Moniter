#!/usr/bin/env node
/**
 * T-001 验收：统一动作协议必须穿过 UI → IPC、HTTP 和 MCP，且三者共享同一任务账本。
 * 任务服务的取消 / unknown 在构建产物上直接验，避免为测试给产品动作加隐藏后门。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

  const taskBuildDir = mkdtempSync(join(tmpdir(), 'monitor-task-service-'))
  execFileSync(process.execPath, [
    join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--rootDir', join(ROOT, 'src'), '--outDir', taskBuildDir,
    join(ROOT, 'src', 'main', 'actions', 'task-service.ts'),
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
  release()
  const canceledResult = await pending
  check('任务取消与远端效果 unknown 有明确状态', () => {
    assert(unknown.task.state === 'unknown' && unknown.task.error?.code === 'effect_unknown', 'unknown 状态或错误码不正确')
    assert(canceled.state === 'canceled' && canceledResult.task.state === 'canceled', '取消没有稳定落为 canceled')
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
