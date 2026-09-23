#!/usr/bin/env node
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startOrigin } from './test-origin.mjs'
import { launchApp, makeChecker, sleep, ROOT } from './app-harness.mjs'
import { McpClient } from './mcp-client.mjs'

const { check, assert, report } = makeChecker()
const dataDir = mkdtempSync(join(tmpdir(), 'monitor-content-'))
const origin = await startOrigin(0)
let app = null
let mcp = null
async function control(path, options = {}) {
  const info = JSON.parse(readFileSync(join(dataDir, 'control.json'), 'utf8'))
  const response = await fetch(`http://${info.host ?? '127.0.0.1'}:${info.port}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${info.token}`, ...(options.body ? { 'content-type': 'application/json' } : {}) }
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
  return body
}
const action = (request) => app.evaluate(`window.monitor.executeAction(${JSON.stringify(request)})`)
try {
  app = await launchApp({
    url: `http://127.0.0.1:${origin.port}/`, dataDir, port: Number(process.env.CONTENT_CDP_PORT ?? 9535),
    extraEnv: { MONITOR_BODY_TIMEOUT_MS: '10000', MONITOR_CAPTURE_BODIES: '1' }
  })
  await app.waitConnected(8)
  let page = null
  for (let retry = 0; retry < 30 && !page?.rows?.length; retry += 1) {
    page = await app.evaluate("window.monitor.queryRequests({ search: '/big' }, 10, 0, 'time_desc')")
    if (!page?.rows?.length) await sleep(200)
  }
  const row = page?.rows?.[0]
  let detail = row ? await app.evaluate(`window.monitor.getDetail(${row.seq})`) : null
  let payload = null
  for (let retry = 0; retry < 40 && !payload; retry += 1) {
    if (row) detail = await app.evaluate(`window.monitor.getDetail(${row.seq})`)
    if (detail?.body?.hash) payload = await app.evaluate(`window.monitor.getBody(${JSON.stringify(detail.body.hash)}, true)`)
    if (!payload) await sleep(200)
  }
  check('超过旧 256KB 阈值的正文完整进入 ContentStore', () => {
    assert(detail?.body?.hash, `大响应没有 body hash: ${JSON.stringify({ row, detail, payload })}`)
    assert(payload?.size === 2 * 1024 * 1024, `正文大小不对：${payload?.size}`)
    assert(Buffer.from(payload.b64, 'base64').byteLength === 2 * 1024 * 1024, '返回正文不是完整 2MB')
    assert(existsSync(join(dataDir, 'content', 'manifests', `${detail.body.hash}.json`)), 'ContentStore manifest 不存在')
    assert(readdirSync(join(dataDir, 'content', 'chunks')).length >= 2, '2MB 内容没有分块写入')
  })
  const hash = detail.body.hash
  const manifest = JSON.parse(readFileSync(join(dataDir, 'content', 'manifests', `${hash}.json`), 'utf8'))
  const target = { kind: 'workspace', workspaceId: 'default' }
  const verified = await action({ action: 'content.verify', target, input: { hash } })
  const range = await action({ action: 'content.readRange', target, input: { hash, start: 1048570, end: 1048590 } })
  const evidence = await action({ action: 'capture.evidence', target, input: { seq: row.seq } })
  check('大正文可校验、跨块范围读取，并保留请求级采集证据', () => {
    assert(verified.task.state === 'succeeded' && verified.output.valid && verified.output.size === 2 * 1024 * 1024, '完整性校验失败')
    assert(range.output.size === 20 && Buffer.from(range.output.b64, 'base64').every((byte) => byte === 9), '跨块范围返回错误')
    assert(evidence.output.events.some((event) => event.state === 'stored' && event.hash === hash), '缺少成功采集证据')
    assert(manifest.chunkHashes.length === 2 && manifest.chunkHashes[0] === manifest.chunkHashes[1], '重复块未去重')
  })
  mcp = McpClient.spawn(process.execPath, [join(ROOT, 'mcp', 'server.mjs')], { cwd: ROOT, env: { ...process.env, MONITOR_DATA_DIR: dataDir } })
  await mcp.initialize('content-acceptance')
  const httpRange = await control(`/workspaces/default/content/${hash}/range?start=1048570&end=1048590`)
  const mcpRange = await mcp.callJson('monitor_content_range', { workspaceId: 'default', hash, start: 1048570, end: 1048590 })
  check('范围读取的 UI、HTTP、MCP 数据一致', () => {
    assert(range.output.b64 === httpRange.output.b64 && range.output.b64 === mcpRange.output.b64, '三入口读取正文不一致')
  })
  const other = await action({ action: 'workspace.create', target: { kind: 'workspace-collection' }, input: { name: '空内容工作区', profile: 'L' } })
  const statsUi = await action({ action: 'workspaces.contentStats', target: { kind: 'workspace-collection' }, input: {} })
  const statsHttp = await control('/workspaces/content-stats')
  const statsMcp = await mcp.callJson('monitor_workspace_content_stats', {})
  check('内容统计按工作区隔离且三入口摘要一致', () => {
    for (const output of [statsUi.output, statsHttp.output, statsMcp.output]) {
      const main = output.find((entry) => entry.workspaceId === 'default')
      const empty = output.find((entry) => entry.workspaceId === other.output.id)
      assert(main?.content.bytes >= 2 * 1024 * 1024 && main.capture.captured >= 1, '默认工作区统计缺失')
      assert(empty?.content.objects === 0 && empty.capture.captured === 0, '新工作区统计串入内容')
    }
  })
  const chunkPath = join(dataDir, 'content', 'chunks', manifest.chunkHashes[0])
  const originalChunk = readFileSync(chunkPath)
  const damaged = Buffer.from(originalChunk)
  damaged[0] ^= 1
  writeFileSync(chunkPath, damaged)
  const corrupt = await action({ action: 'content.verify', target, input: { hash } })
  writeFileSync(chunkPath, originalChunk)
  check('块损坏可被校验接口发现', () => {
    assert(corrupt.output.exists && !corrupt.output.valid && /校验失败/.test(corrupt.output.error), '损坏未检测到')
  })
  const revoked = await action({ action: 'content.revoke', target, input: { hash, reason: '验收清理' } })
  const revokedVerify = await action({ action: 'content.verify', target, input: { hash } })
  const afterRevoke = await action({ action: 'capture.evidence', target, input: { seq: row.seq } })
  const summary = await control('/workspaces/default/capture/summary')
  check('保留删除实际撤销正文，并留下原因、请求证据和缺口统计', () => {
    assert(revoked.task.state === 'succeeded' && revoked.output.deleted && revoked.output.affected >= 1, '正文没有被清理')
    assert(!existsSync(join(dataDir, 'content', 'manifests', `${hash}.json`)), 'manifest 未删除')
    assert(!existsSync(chunkPath), '未引用的正文块未被清理')
    assert(!revokedVerify.output.exists, '删除后完整性接口仍认为正文存在')
    assert(afterRevoke.output.events.some((event) => event.state === 'retained_deleted' && event.reason === '验收清理'), '删除证据缺失')
    assert(summary.output.deleted >= 1 && summary.output.byReason.retained_deleted >= 1 && summary.output.chainValid, '删除统计或证据链错误')
  })
  await action({ action: 'workspace.suspend', target, input: {} })
  const offlineEvidence = await control(`/workspaces/default/requests/${row.seq}/body-evidence`)
  check('工作区休眠后仍可读取历史采集与删除证据', () => {
    assert(offlineEvidence.task.state === 'succeeded' && offlineEvidence.output.classification === 'offline_evidence_only', '休眠后证据查询失败')
    assert(offlineEvidence.output.events.some((event) => event.state === 'retained_deleted'), '休眠后删除证据丢失')
  })
} catch (error) {
  check('ContentStore 正文采集流程', () => { throw error })
} finally {
  mcp?.close()
  if (app) await app.close()
  await origin.close()
  rmSync(dataDir, { recursive: true, force: true })
}
process.exit(report() ? 0 : 1)
