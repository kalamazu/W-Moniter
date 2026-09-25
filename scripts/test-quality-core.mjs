#!/usr/bin/env node
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ExecutionWorkerClient } from '../src/main/workers/client.ts'
import { VersionedJsonRepository } from '../src/main/repositories/versioned-json.ts'
import { makeChecker } from './app-harness.mjs'

const { check, assert, report } = makeChecker()
const root = mkdtempSync(join(tmpdir(), 'monitor-quality-core-'))
const worker = new ExecutionWorkerClient(process.execPath, resolve('workers/server.mjs'))
const server = createServer((req, res) => {
  if (req.url === '/slow') return setTimeout(() => { res.end('late') }, 2_000)
  res.setHeader('x-duplicate-proof', ['a', 'b'])
  res.end('你好，worker')
})

try {
  await new Promise((resolveReady) => server.listen(0, '127.0.0.1', resolveReady))
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}`
  const health = await worker.health()
  const response = await worker.replay({ method: 'GET', url, headers: [], cookiePolicy: 'omit', bodyBase64: '', timeoutMs: 5_000 })
  const text = await worker.extract(Buffer.from('可检索正文'))
  check('Q-002 Runner/Indexer 使用独立进程', () => {
    assert(health.pid !== process.pid && response.workerPid === health.pid, `main=${process.pid}, worker=${health.pid}`)
    assert(Buffer.from(response.bodyBase64, 'base64').toString() === '你好，worker', '重放正文不一致')
    assert(text === '可检索正文', '索引抽取结果不一致')
  })

  const inFlight = worker.replay({ method: 'GET', url: `${url}/slow`, headers: [], cookiePolicy: 'omit', bodyBase64: '', timeoutMs: 5_000 })
  await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  worker.stop()
  let rejected = false
  try { await inFlight } catch { rejected = true }
  const restarted = await worker.health()
  check('Q-002 Worker 崩溃隔离并自动重启', () => {
    assert(rejected, 'Worker 退出后在途调用应失败')
    assert(restarted.pid !== health.pid && worker.diagnostics().starts === 2, JSON.stringify(worker.diagnostics()))
  })

  const repositoryPath = join(root, 'repository.json')
  writeFileSync(repositoryPath, JSON.stringify({ schemaVersion: 1, rows: [] }))
  const repository = new VersionedJsonRepository(repositoryPath, () => ({ schemaVersion: 1, rows: [] }), (value) => { if (value.schemaVersion !== 1 || !Array.isArray(value.rows)) throw new Error('invalid') })
  const legacy = repository.read()
  repository.write({ schemaVersion: 1, rows: ['first'] }, legacy.revision)
  let conflicted = false
  try { repository.write({ schemaVersion: 1, rows: ['lost'] }, legacy.revision) } catch { conflicted = true }
  const envelope = JSON.parse(readFileSync(repositoryPath, 'utf8'))
  check('Q-003 仓库迁移备份与 CAS 冲突保护', () => {
    assert(existsSync(`${repositoryPath}.legacy.1`) || repository.diagnostics().migratedLegacy, '旧数据未迁移')
    assert(envelope.repositoryVersion === 1 && envelope.revision === 2, JSON.stringify(envelope))
    assert(conflicted && envelope.data.rows[0] === 'first', '陈旧 revision 覆盖了新数据')
  })
} catch (error) {
  check('质量核心专项运行', () => { throw error })
} finally {
  worker.stop()
  await new Promise((resolveClose) => server.close(resolveClose))
  rmSync(root, { recursive: true, force: true })
}

process.exit(report() ? 0 : 1)
