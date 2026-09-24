#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { launchApp, makeChecker, sleep } from './app-harness.mjs'
import { startOrigin } from './test-origin.mjs'

const { check, assert, report } = makeChecker()
const dataDir = mkdtempSync(join(tmpdir(), 'monitor-core-centers-'))
const origin = await startOrigin(0)
let proxyHits = 0
const upstreamProxy = createServer((req, res) => {
  proxyHits += 1
  const target = new URL(req.url)
  const outgoing = httpRequest({ hostname: target.hostname, port: Number(target.port || 80), method: req.method, path: target.pathname + target.search, headers: req.headers }, (incoming) => {
    res.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(res)
  })
  outgoing.on('error', (error) => { res.writeHead(502); res.end(error.message) })
  req.pipe(outgoing)
})
upstreamProxy.on('connect', (req, socket, head) => {
  proxyHits += 1
  const [host, rawPort] = req.url.split(':')
  const upstream = netConnect(Number(rawPort || 443), host, () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length) upstream.write(head)
    upstream.pipe(socket); socket.pipe(upstream)
  })
  socket.on('error', () => upstream.destroy())
  upstream.on('error', () => socket.destroy())
})
await new Promise((resolve) => upstreamProxy.listen(0, '127.0.0.1', resolve))
const upstreamPort = upstreamProxy.address().port
let app = null

const action = async (name, input = {}) => app.evaluate(`(async () => {
  const ws = await window.monitor.getWorkspaces()
  const request = ${JSON.stringify({ action: name, input })}
  request.target = { kind: 'workspace', workspaceId: ws.output.activeWorkspaceId }
  return window.monitor.executeAction(request)
})()`)

try {
  app = await launchApp({ url: `http://127.0.0.1:${origin.port}/dom-probe.html`, dataDir, port: 9625, tab: 'sites', extraEnv: { MONITOR_CAPTURE_BODIES: '1' } })
  await app.waitConnected(1)
  await sleep(800)

  const inspect = await action('content.inspect')
  check('T-021 内容治理枚举正文、策略和审计', () => {
    assert(inspect.task.state === 'succeeded', inspect.task.error?.message ?? 'inspect failed')
    assert(Array.isArray(inspect.output.objects) && inspect.output.objects.length > 0, '缺少正文目录')
    assert(inspect.output.policy.maskSensitivePreview === true, '敏感预览默认没有遮罩')
  })
  if (inspect.output.objects.length) {
    const hash = inspect.output.objects[0].hash
    const pinned = await action('content.pin', { hash, reason: 'acceptance' })
    const revoked = await action('content.revoke', { hash, reason: 'must be blocked' })
    check('T-021 固定正文不能被清理', () => {
      assert(pinned.task.state === 'succeeded', '固定正文失败')
      assert(revoked.task.state === 'failed' && revoked.task.error?.message.includes('固定'), '固定正文仍可删除')
    })
    await action('content.unpin', { hash })
  }
  const policy = await action('content.policySet', { quotaBytes: 32 * 1024 * 1024, graceMs: 0, maskSensitivePreview: true })
  check('T-021 配额与宽限期可版本化落盘', () => assert(policy.output.quotaBytes === 32 * 1024 * 1024 && policy.output.graceMs === 0, '策略未生效'))

  const cockpit = await action('workspace.cockpit')
  check('T-022 驾驶舱聚合状态历史、检查点和正文', () => {
    assert(cockpit.task.state === 'succeeded', cockpit.task.error?.message ?? 'cockpit failed')
    assert(cockpit.output.workspace.state === 'running', '运行状态不符')
    assert(Array.isArray(cockpit.output.history) && cockpit.output.history.length > 0, '没有状态时间线')
    assert(Array.isArray(cockpit.output.checkpoints), '没有检查点投影')
  })

  const invalidSecret = await action('environment.save', { name: 'leak', dnsMode: 'system', upstreams: [{ id: 'p', kind: 'http-connect', host: '127.0.0.1', port: 9, password: 'plaintext' }], routes: [{ match: '*', upstreamId: 'p', required: true }] })
  const saved = await action('environment.save', { name: 'acceptance', dnsMode: 'proxy', upstreams: [{ id: 'direct', kind: 'direct' }, { id: 'corp', kind: 'socks5', host: '127.0.0.1', port: 9, secretRef: 'secret://proxy/corp' }], routes: [{ match: '*.internal', upstreamId: 'corp', required: true }, { match: '*', upstreamId: 'direct', required: true }] })
  const applied = await action('environment.apply', { version: saved.output.version })
  const diagnostics = await action('environment.diagnose', { version: saved.output.version })
  check('T-023 环境版本、SecretRef、应用状态和诊断形成闭环', () => {
    assert(invalidSecret.task.state === 'failed', '明文凭据没有被拒绝')
    assert(saved.task.state === 'succeeded' && saved.output.version >= 2, '环境版本未保存')
    assert(applied.output.pendingRestart === true && applied.output.appliedVersion === saved.output.version, '应用状态不符')
    assert(diagnostics.output.checks.length === 2 && diagnostics.output.checks.some(item => item.upstreamId === 'corp' && item.ok === false), '诊断没有如实报告失败上游')
    assert(!JSON.stringify(saved.output).includes('plaintext'), '输出泄露明文秘密')
  })

  await app.evaluate(`window.monitor.evaluate("localStorage.setItem('acceptance-key','before'); document.cookie='acceptance-cookie=one; path=/'; 'ok'")`)
  await app.evaluate(`window.monitor.scanSiteData({ origin: ${JSON.stringify(`http://127.0.0.1:${origin.port}`)} })`)
  const bundleResult = await action('site.stateExport', { origins: [`http://127.0.0.1:${origin.port}`] })
  await app.evaluate(`window.monitor.evaluate("localStorage.setItem('acceptance-key','changed'); document.cookie='acceptance-cookie=two; path=/'; 'ok'")`)
  const restored = await action('site.stateRestore', { bundle: bundleResult.output, areas: ['cookies', 'localStorage'], replace: true })
  const readbackResult = await app.evaluate(`window.monitor.evaluate("({ local: localStorage.getItem('acceptance-key'), cookie: document.cookie })")`)
  const readback = readbackResult.value
  check('T-024 状态包导出、选择性恢复和浏览器读回', () => {
    assert(bundleResult.task.state === 'succeeded' && bundleResult.output.origins.length === 1, '导出状态包失败')
    assert(bundleResult.output.origins[0].localStorage.some(item => item.key === 'acceptance-key' && item.value === 'before'), `状态包没有原始 localStorage：${JSON.stringify(bundleResult.output.origins[0].localStorage)}`)
    assert(restored.task.state === 'succeeded' && restored.output.verifiedOrigins.length === 1, restored.task.error?.message ?? '恢复失败')
    assert(readback.local === 'before', `localStorage 未恢复：${readback.local}`)
    assert(readback.cookie.includes('acceptance-cookie=one'), `Cookie 未恢复：${readback.cookie}`)
  })

  const routed = await action('environment.save', { name: 'real-http-connect', dnsMode: 'proxy', upstreams: [{ id: 'upstream', kind: 'http-connect', host: '127.0.0.1', port: upstreamPort }], routes: [{ match: '*', upstreamId: 'upstream', required: true }] })
  await action('environment.apply', { version: routed.output.version })
  await app.evaluate(`window.monitor.suspendWorkspace('default')`)
  await app.evaluate(`window.monitor.openWorkspace('default')`)
  await app.waitConnected(1)
  await app.evaluate(`window.monitor.evaluate("fetch('/proxy-proof?nonce=${Date.now()}').then(r => r.text()).then(() => 'ok')")`)
  await sleep(500)
  check('T-023 应用版本在重启后编译为 PAC，真实流量经过 HTTP CONNECT 上游', () => {
    assert(proxyHits > 0, '上游代理没有看到浏览器流量')
  })
} catch (error) {
  check('21–24 综合验收流程', () => { throw error })
} finally {
  if (app) await app.close()
  await new Promise((resolve) => upstreamProxy.close(resolve))
  await origin.close()
  rmSync(dataDir, { recursive: true, force: true })
}

process.exit(report() ? 0 : 1)
