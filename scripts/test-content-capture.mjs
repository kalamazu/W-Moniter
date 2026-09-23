#!/usr/bin/env node
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startOrigin } from './test-origin.mjs'
import { launchApp, makeChecker, sleep } from './app-harness.mjs'

const { check, assert, report } = makeChecker()
const dataDir = mkdtempSync(join(tmpdir(), 'monitor-content-'))
const origin = await startOrigin(0)
let app = null
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
} catch (error) {
  check('ContentStore 正文采集流程', () => { throw error })
} finally {
  if (app) await app.close()
  await origin.close()
  rmSync(dataDir, { recursive: true, force: true })
}
process.exit(report() ? 0 : 1)
