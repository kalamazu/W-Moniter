#!/usr/bin/env node
/**
 * Core 0.1 工作区验收。
 *
 * 通过真实 renderer → preload → IPC 路径创建、切换与休眠工作区；检查每个新
 * 工作区是否拥有独立的 profile / SQLite / 规则目录。这里不把“切 UI 标签”误当成
 * 隔离：切换必须关闭旧受管浏览器，再连接到新工作区的 Chromium。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startOrigin } from './test-origin.mjs'
import { launchApp, makeChecker, sleep } from './app-harness.mjs'

const { check, assert, report } = makeChecker()
const dataDir = mkdtempSync(join(tmpdir(), 'monitor-workspaces-'))
const origin = await startOrigin(0)
const port = Number(process.env['WORKSPACE_CDP_PORT'] ?? 9515)
const url = `http://127.0.0.1:${origin.port}/dom-probe.html`
let app = null

async function controlRequest(path, options = {}) {
  const infoPath = join(dataDir, 'control.json')
  let info = null
  for (let attempt = 0; attempt < 80 && !info; attempt += 1) {
    if (existsSync(infoPath)) {
      try {
        const candidate = JSON.parse(readFileSync(infoPath, 'utf8'))
        if (candidate?.port && candidate?.token) info = candidate
      } catch {
        /* control.json 可能正好在原子替换中 */
      }
    }
    if (!info) await sleep(100)
  }
  if (!info) throw new Error('等不到工作区控制服务')
  const response = await fetch(`http://${info.host ?? '127.0.0.1'}:${info.port}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${info.token}`,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' })
    }
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
  return body
}

try {
  app = await launchApp({
    url,
    dataDir,
    port,
    tab: 'list',
    extraEnv: { MONITOR_MAX_ACTIVE_WORKSPACES: '2' }
  })
  await app.waitConnected(1)
  const defaultStatus = await app.evaluate('window.monitor.getStatus()')

  const beforeAction = await app.evaluate('window.monitor.getWorkspaces()')
  const before = beforeAction.output
  check('首次启动把旧目录登记为默认工作区并标为运行中', () => {
    assert(before.workspaces.length === 1, `首次工作区数应为 1，实际 ${before.workspaces.length}`)
    assert(before.activeWorkspaceId === 'default', `活动工作区不是 default：${before.activeWorkspaceId}`)
    assert(before.workspaces[0].legacy === true, '默认工作区没有保留 legacy 标记')
    assert(before.workspaces[0].state === 'running', `默认状态不是 running：${before.workspaces[0].state}`)
  })

  const listedByAgentAction = await controlRequest('/workspaces')
  const listedByAgent = listedByAgentAction.output
  check('本地 HTTP 控制面可枚举工作区，Agent 不依赖 UI 焦点猜测', () => {
    assert(listedByAgent.activeWorkspaceId === 'default', '控制面没有返回活动工作区')
    assert(listedByAgent.workspaces.length === 1, '控制面工作区列表不完整')
  })

  const createdAction = await app.evaluate("window.monitor.createWorkspace({ name: 'Alice', profile: 'H' })")
  const created = createdAction.output
  check('创建工作区只生成元数据，尚未混入默认工作区', () => {
    assert(created.id.startsWith('ws_'), `工作区 ID 不对：${created.id}`)
    assert(created.profile === 'H', `Profile 不对：${created.profile}`)
    assert(created.state === 'closed', `新工作区状态不对：${created.state}`)
    assert(existsSync(join(dataDir, 'workspaces', created.id)), '工作区根目录没有创建')
  })

  const openedAction = await app.evaluate(`window.monitor.openWorkspace(${JSON.stringify(created.id)})`)
  const opened = openedAction.output
  await app.waitConnected(1)
  const aliceStatus = await app.evaluate('window.monitor.getStatus()')
  await sleep(300)
  check('打开第二个工作区时默认浏览器继续运行，目标使用独立资料目录', () => {
    const current = opened.workspaces.find((workspace) => workspace.id === created.id)
    const previous = opened.workspaces.find((workspace) => workspace.id === 'default')
    assert(opened.activeWorkspaceId === created.id, '活动工作区没有切到新工作区')
    assert(current?.state === 'running', `目标状态不对：${current?.state}`)
    assert(previous?.state === 'running', `默认工作区不应被切换操作暂停：${previous?.state}`)
    assert(aliceStatus.profile === 'H', `新工作区没有使用 H Profile：${aliceStatus.profile}`)
    assert(existsSync(join(dataDir, 'workspaces', created.id, 'monitor.db')), '目标工作区 SQLite 没有创建')
    assert(existsSync(join(dataDir, 'workspaces', created.id, 'browser-profile')), '目标浏览器资料目录没有创建')
  })

  const thirdAction = await controlRequest('/workspaces', {
    method: 'POST',
    body: JSON.stringify({ name: 'Bob', profile: 'L' })
  })
  const third = thirdAction.output
  const capped = await app.evaluate(`window.monitor.openWorkspace(${JSON.stringify(third.id)}).then(
    (result) => ({ ok: result.task.state === 'succeeded', message: result.task.error?.message ?? '' }),
    (error) => ({ ok: false, message: String(error) })
  )`)
  check('并发上限拒绝第三个浏览器，不会静默关闭已有工作区', () => {
    assert(capped.ok === false, '达到上限仍启动了第三个工作区')
    assert(capped.message.includes('上限'), `错误没有说明并发上限：${capped.message}`)
  })

  const suspendedAction = await controlRequest(`/workspaces/${encodeURIComponent(created.id)}/suspend`, { method: 'POST' })
  const suspended = suspendedAction.output
  check('休眠只停止指定工作区，后台默认工作区继续运行', () => {
    const current = suspended.workspaces.find((workspace) => workspace.id === created.id)
    const previous = suspended.workspaces.find((workspace) => workspace.id === 'default')
    assert(current?.state === 'suspended', `休眠后的状态不对：${current?.state}`)
    assert(previous?.state === 'running', `默认工作区被错误停止：${previous?.state}`)
    assert(existsSync(join(dataDir, 'workspaces', created.id, 'monitor.db')), '休眠后数据库不应被删除')
  })

  const workspaceRoot = join(dataDir, 'workspaces', created.id)
  mkdirSync(join(workspaceRoot, 'content'), { recursive: true })
  writeFileSync(join(workspaceRoot, 'rules.json'), '{"marker":"before"}\n')
  writeFileSync(join(workspaceRoot, 'content', 'checkpoint-sentinel'), 'immutable-evidence')
  const target = { kind: 'workspace', workspaceId: created.id }
  const checkpointAction = await app.evaluate(`window.monitor.executeAction(${JSON.stringify({
    action: 'workspace.checkpointCreate', target, input: { label: 'acceptance' }
  })})`)
  const checkpoint = checkpointAction.output
  writeFileSync(join(workspaceRoot, 'rules.json'), '{"marker":"after"}\n')
  rmSync(join(workspaceRoot, 'content', 'checkpoint-sentinel'))
  const restoredAction = await app.evaluate(`window.monitor.executeAction(${JSON.stringify({
    action: 'workspace.checkpointRestore', target, input: { checkpointId: checkpoint.id }
  })})`)
  check('suspended 工作区可创建校验清单并冷恢复，恢复前状态留有备份', () => {
    assert(checkpoint.files.some((file) => file.path === 'rules.json' && /^[a-f0-9]{64}$/.test(file.hash)), '检查点缺少逐文件 hash')
    assert(restoredAction.task.state === 'succeeded' && restoredAction.output.restored, '检查点恢复失败')
    assert(readFileSync(join(workspaceRoot, 'rules.json'), 'utf8').includes('before'), '规则文件没有恢复')
    assert(readFileSync(join(workspaceRoot, 'content', 'checkpoint-sentinel'), 'utf8') === 'immutable-evidence', '内容证据没有恢复')
    assert(existsSync(restoredAction.output.backup), '恢复前备份不存在')
  })

  const listedCheckpoints = await app.evaluate(`window.monitor.executeAction(${JSON.stringify({
    action: 'workspace.checkpointList', target, input: {}
  })})`)
  const afterRestore = (await app.evaluate('window.monitor.getWorkspaces()')).output
  check('检查点可由统一 Action API 枚举，恢复后登录与扩展状态明确标为待复验', () => {
    assert(listedCheckpoints.output.some((item) => item.id === checkpoint.id), '统一动作未列出检查点')
    const current = afterRestore.workspaces.find((workspace) => workspace.id === created.id)
    assert(current?.state === 'suspended' && current.error?.includes('登录证据需重新验证'), '恢复后没有标出登录/扩展复验要求')
  })

  const resumedAction = await app.evaluate("window.monitor.openWorkspace('default')")
  const resumed = resumedAction.output
  await app.waitConnected(1)
  const resumedStatus = await app.evaluate('window.monitor.getStatus()')
  check('聚焦默认工作区不重启浏览器，新工作区仍保持休眠', () => {
    const alice = resumed.workspaces.find((workspace) => workspace.id === created.id)
    const current = resumed.workspaces.find((workspace) => workspace.id === 'default')
    assert(resumed.activeWorkspaceId === 'default', '没有恢复默认工作区')
    assert(current?.state === 'running', `默认工作区状态不对：${current?.state}`)
    assert(alice?.state === 'suspended', `Alice 工作区被错误唤醒：${alice?.state}`)
    assert(resumedStatus.profile === 'L', `焦点没有回到默认 Profile：${resumedStatus.profile}`)
    assert(resumedStatus.inst === defaultStatus.inst, '聚焦默认工作区不应重新创建采集实例')
  })
} catch (error) {
  check('工作区端到端流程', () => {
    throw error
  })
} finally {
  if (app) await app.close()
  await origin.close()
  rmSync(dataDir, { recursive: true, force: true })
}

process.exit(report() ? 0 : 1)
