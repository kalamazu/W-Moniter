#!/usr/bin/env node
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const temp = mkdtempSync(join(tmpdir(), 'monitor-stream-'))
const child = spawn(process.env['CONTENT_NODE_PATH'] ?? process.execPath,
  ['--no-warnings', process.env['CONTENT_SERVER_PATH'] ?? join(root, 'content', 'server.mjs'), temp],
  { stdio: ['pipe', 'pipe', 'pipe'] })
let endpoint
try {
  const [chunk] = await once(child.stdout, 'data')
  endpoint = JSON.parse(String(chunk).trim())
  assert.equal(endpoint.host, '127.0.0.1')
  console.log('  ✓ random local endpoint ready')
  const unauthorized = await new Promise(resolve => {
    http.get({ hostname: endpoint.host, port: endpoint.port, path: '/ping' }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode))
    })
  })
  assert.equal(unauthorized, 401)
  console.log('  ✓ token required')

  async function upload(size, abort = false, declared = size) {
    const hash = createHash('sha256')
    const block = Buffer.alloc(256 * 1024, 73)
    const response = new Promise((resolve, reject) => {
      const req = http.request({ hostname: endpoint.host, port: endpoint.port, path: '/object', method: 'PUT',
        headers: { authorization: `Bearer ${endpoint.token}`, 'x-expected-bytes': String(declared) } }, res => {
        const parts = []
        res.on('error', reject)
        res.on('data', part => parts.push(part))
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString('utf8') }))
      })
      req.on('error', reject)
      void (async () => {
        try {
          let sent = 0
          while (sent < size) {
            const part = block.subarray(0, Math.min(block.length, size - sent))
            hash.update(part)
            sent += part.length
            if (!req.write(part)) await once(req, 'drain')
            if (abort && sent >= size / 2) { req.destroy(); return }
          }
          req.end()
        } catch (error) { req.destroy(error) }
      })()
    })
    return { result: await response, hash: hash.digest('hex') }
  }

  const mib = Number(process.env['STREAM_TEST_MIB'] ?? 100)
  const size = mib * 1024 * 1024
  const began = Date.now()
  const { result, hash } = await upload(size)
  const elapsedMs = Date.now() - began
  assert.equal(result.status, 200, result.body)
  const ref = JSON.parse(result.body)
  assert.equal(ref.hash, hash); assert.equal(ref.size, size)
  const manifest = JSON.parse(readFileSync(join(temp, 'manifests', `${hash}.json`), 'utf8'))
  assert.equal(manifest.chunks, mib)
  const verified = createHash('sha256')
  for (const chunkHash of manifest.chunkHashes) {
    const bytes = readFileSync(join(temp, 'chunks', chunkHash))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), chunkHash)
    verified.update(bytes)
  }
  assert.equal(verified.digest('hex'), hash)
  console.log(`  ✓ ${mib} MiB stream hash/manifest/chunks verified`)
  if (process.env['MONITOR_CONTENT_WRITE_DELAY_MS']) {
    assert(elapsedMs > 250, `slow sink did not backpressure: ${elapsedMs}ms`)
    console.log(`  ✓ slow writer backpressure observed (${elapsedMs} ms)`)
  }

  if (process.env['STREAM_TEST_LARGE_ONLY'] !== '1') {
    const wrong = await upload(1024, false, 2048)
    assert.equal(wrong.result.status, 400)
    console.log('  ✓ incomplete declared length rejected')
    await upload(1024 * 1024, true).catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(readdirSync(join(temp, 'manifests')).length, 1)
    console.log('  ✓ aborted upload has no manifest')
  }
} finally {
  child.stdin.end()
  await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(() => { child.kill(); resolve() }, 3000))])
  if (!resolve(temp).startsWith(resolve(tmpdir()) + sep)) throw new Error('unsafe cleanup')
  rmSync(temp, { recursive: true, force: true })
}
