#!/usr/bin/env node
/** T-010: origin truth, page consumption and monitor evidence are separate witnesses. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { startOrigin } from '../test-origin.mjs'
import { launchApp, makeChecker, sleep } from '../app-harness.mjs'

const { check, assert, report } = makeChecker()
const dataDir = mkdtempSync(join(tmpdir(), 'monitor-capture-paths-'))
const origin = await startOrigin(0)
const profile = process.env['CAPTURE_PROFILE'] === 'H' ? 'H' : 'L'
const proxy = process.env['CAPTURE_PROXY'] === '1'
const skipUpload = process.env['CAPTURE_SKIP_UPLOAD'] === '1'
let app = null
const routes = ['matrix-binary', 'matrix-upload', 'matrix-stream', 'matrix-truncate', 'matrix-slow', 'matrix-cache', 'api/through-sw', 'events', 'ws-probe', 'matrix-download']

try {
  app = await launchApp({
    url: `http://127.0.0.1:${origin.port}/capture-matrix.html${skipUpload ? '?skipUpload' : ''}`, dataDir,
    port: Number(process.env['CAPTURE_CDP_PORT'] ?? 9545), profile,
    extraEnv: { MONITOR_CAPTURE_BODIES: '1', MONITOR_BODY_TIMEOUT_MS: '10000', MONITOR_PROXY: proxy ? '1' : '0' }
  })
  await app.waitConnected(1)
  for (let retry = 0; retry < 100 && !origin.matrixReports.length; retry += 1) await sleep(200)
  const page = origin.matrixReports[0]
  check('页面消费与不完整场景均留下独立真值', () => {
    if (proxy && !page) {
      assert(origin.requests.some((item) => item.path === '/matrix-upload'), '代理模式未记录上传尝试')
      return
    }
    assert(page && !page.error, `页面未回报：${JSON.stringify(page)}`)
    assert(page.binary?.bytes === 2 * 1024 * 1024, `响应未完整消费：${JSON.stringify(page.binary)}`)
    if (!skipUpload) assert(page.upload?.bytes === 2 * 1024 * 1024, '上传到达字节不完整')
    assert(page.stream?.bytes === 3 * 256 * 1024, `未知长度流未完整消费：${JSON.stringify(page.stream)}`)
    assert(page.cache?.stored && page.serviceWorker?.ready, '缓存/SW 没有完成')
    assert(page.sse === 'hello', 'SSE 页面消费失败')
    assert(page.ws === 'echo:matrix-message' || (proxy && page.ws?.error), 'WS 结果无消费或失败证据')
    assert(page.download?.clicked, '下载未触发')
    assert(page.truncated?.error && page.aborted?.error, '截断/取消未产生页面错误')
  })
  const binaryTruth = createHash('sha256').update(Buffer.alloc(2 * 1024 * 1024, 37)).digest('hex')
  const uploadTruth = createHash('sha256').update(Buffer.alloc(2 * 1024 * 1024, 71)).digest('hex')
  const originUpload = origin.requests.find((item) => item.path === '/matrix-upload')
  check('服务端独立真值与页面 hash/上传字节一致', () => {
    if (page) {
      assert(page.binary.hash === binaryTruth, '浏览器消费的响应 hash 不对')
      if (!skipUpload) assert(page.upload.hash === uploadTruth && originUpload?.bodyHash === uploadTruth, '服务器收到的上传 hash 不对')
      if (page.ws === 'echo:matrix-message') assert(origin.wsLog.some((item) => item.dir === 'in' && item.data === 'matrix-message'), '服务器未收到 WS 帧')
      else assert(proxy && page.ws?.error && !origin.wsLog.some((item) => item.dir === 'in'), '代理 WS 失败没有对应服务端真值')
    } else {
      assert(proxy && originUpload && !originUpload.bodyHash, '页面未完成但没有可定位的上传缺口')
    }
  })

  const coverage = []
  for (const route of routes) {
    let rows = []
    for (let retry = 0; retry < 15 && !rows.length; retry += 1) {
      const pageOfRows = await app.evaluate(`window.monitor.queryRequests({search:${JSON.stringify('/' + route)}}, 20, 0, 'time_desc')`)
      rows = pageOfRows?.rows ?? []
      if (!rows.length) await sleep(200)
    }
    const row = rows.find((item) => String(item.url ?? '').includes('/' + route))
    const detail = row ? await app.evaluate(`window.monitor.getDetail(${row.seq})`) : null
    const truth = origin.requests.filter((item) => item.path === '/' + route)
    coverage.push({ route, originCount: truth.length, originLatencyMs: truth[0]?.finishedAt ? truth[0].finishedAt - truth[0].at : null,
      observed: !!row, bodyState: detail?.request?.body_state ?? null, bodyHash: detail?.body?.hash ?? null,
      bodySize: detail?.request?.body_size ?? null })
  }
  const binary = coverage.find((item) => item.route === 'matrix-binary')
  check('监控记录可与独立真值逐条比对', () => {
    assert(binary.observed, `二进制请求未被记录：${JSON.stringify(binary)}`)
    if (binary.bodyState === 'stored') assert(binary.bodyHash === binaryTruth, `已存正文 hash 与真值不符：${JSON.stringify(binary)}`)
    if (page) {
      const truncated = coverage.find((item) => item.route === 'matrix-truncate')
      const aborted = coverage.find((item) => item.route === 'matrix-slow')
      assert(truncated?.bodyState !== 'stored' && aborted?.bodyState !== 'stored', '失败/取消响应被误标为完整正文')
    }
  })
  const status = await app.evaluate('window.monitor.getStatus()')
  const ws = await app.evaluate("window.monitor.queryWsFrames({limit:20})")
  let mainPeakRssBytes = null
  if (process.platform === 'win32' && Number.isSafeInteger(app.app.pid)) {
    try { mainPeakRssBytes = Number(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${app.app.pid}).PeakWorkingSet64`], { encoding: 'utf8' }).trim()) } catch { /* process may be exiting */ }
  }
  const result = { at: new Date().toISOString(), browser: status?.browserVersion ?? null, profile, proxy, skipUpload,
    page: page ?? null, coverage, bodyCapture: status?.body ?? null, mainPeakRssBytes,
    wsFramesObserved: ws?.rows?.length ?? null,
    knownGaps: [
      ...(proxy && !page ? ['proxy_upload_stalled_page'] : []),
      ...(page?.ws?.error ? ['proxy_websocket_failed'] : []),
      ...(coverage.find((item) => item.route === 'matrix-download')?.observed ? [] : ['download_request_not_observed']),
      ...(coverage.find((item) => item.route === 'events')?.bodyState === 'stored' ? [] : ['sse_body_not_stored']),
      ...(!skipUpload && coverage.find((item) => item.route === 'matrix-upload')?.bodySize !== page?.upload?.bytes ? ['upload_original_not_stored'] : [])
    ],
    facts: { responseHash: binaryTruth, uploadHash: uploadTruth, uploadReceivedBytes: originUpload?.receivedBytes ?? 0, wsFramesAtOrigin: origin.wsLog.length } }
  if (process.env['CAPTURE_REPORT']) writeFileSync(process.env['CAPTURE_REPORT'], JSON.stringify(result, null, 2) + '\n')
  console.log('CAPTURE_MATRIX ' + JSON.stringify(result))
} catch (error) {
  check('采集路径探针流程', () => { throw error })
} finally {
  if (app) await app.close()
  await origin.close()
  if (existsSync(dataDir) && resolve(dataDir).startsWith(resolve(tmpdir()) + sep)) rmSync(dataDir, { recursive: true, force: true })
}
process.exit(report() ? 0 : 1)
