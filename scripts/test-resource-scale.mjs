#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResourceKnowledgeService } from '../src/main/resources/service.ts'
import { ContentStore } from '../src/main/content/store.ts'
import { makeChecker } from './app-harness.mjs'

const { check, assert, report } = makeChecker(); const root = mkdtempSync(join(tmpdir(), 'monitor-resource-scale-')); const total = 100_000
try {
  const extract = async (bytes) => new TextDecoder().decode(bytes)
  const service = new ResourceKnowledgeService(root, new ContentStore(join(root, 'content')), extract)
  const started = Date.now(); const coverage = await service.rebuild(async (limit, offset) => ({ total, rows: Array.from({ length: Math.min(limit, total - offset) }, (_, index) => { const seq = offset + index + 1; return { seq, url: `https://scale.test/assets/${seq}.bin`, status: 200, mime_type: 'application/octet-stream', resource_type: 'Image', body_hash: null, body_size: null, decoded_len: seq, body_trunc: 0, start_ts: seq } }) }))
  const last = service.list({ limit: 100, offset: 99_900 }); const search = service.search('99999.bin', { limit: 10 })
  check('T-028 十万资源索引和末页分页不截断、不全量返回', () => { assert(coverage.scanned === total && coverage.versions === total, JSON.stringify(coverage)); assert(last.total === total && last.rows.length === 100, `total=${last.total} rows=${last.rows.length}`); assert(search.total === 1 && search.rows[0].evidenceSeq === 99_999, '末端 URL 检索错误'); assert(Date.now() - started < 30_000, `十万资源耗时 ${Date.now() - started}ms`) })

  const canceledRoot = join(root, 'cancelled'); const canceledService = new ResourceKnowledgeService(canceledRoot, new ContentStore(join(canceledRoot, 'content')), extract); const controller = new AbortController(); let pages = 0
  const canceled = await canceledService.rebuild(async (limit, offset) => { pages += 1; if (pages === 2) controller.abort(); return { total, rows: Array.from({ length: limit }, (_, index) => { const seq = offset + index + 1; return { seq, url: `https://cancel.test/${seq}`, status: 200, mime_type: 'application/octet-stream', resource_type: 'Image', body_hash: null, body_size: null, decoded_len: 1, body_trunc: 0, start_ts: seq } }) } }, controller.signal)
  check('T-028 取消重建保留明确 coverage，不触碰原始证据', () => { assert(canceled.canceled === true && canceled.scanned === 2000 && pages === 2, JSON.stringify(canceled)); assert(canceledService.list({ limit: 10 }).total === 2000, '部分派生索引状态不自洽') })
} catch (error) { check('T-028 十万资源与取消重建专项', () => { throw error }) }
finally { rmSync(root, { recursive: true, force: true }) }
process.exit(report() ? 0 : 1)
