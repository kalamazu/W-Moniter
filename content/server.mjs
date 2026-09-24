#!/usr/bin/env node
/** Single-writer content service. PUT /object is begin + binary append + EOF finalize;
 * disconnected requests abort and never publish a manifest. All filesystem work is
 * outside Electron and byte transport never uses JSON/base64. */
import http from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'

const root = process.argv[2]
if (!root) throw new Error('content root required')
const token = randomBytes(32).toString('hex')
const CHUNK = 1024 * 1024
let active = 0

async function atomic(path, bytes) {
  const tmp = `${path}.${randomUUID()}.tmp`
  try { await writeFile(tmp, bytes); await rename(tmp, path) }
  finally { await unlink(tmp).catch(() => {}) }
}

async function publish(stage, hash, size) {
  const manifestPath = join(root, 'manifests', `${hash}.json`)
  try {
    const doc = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (doc.hash === hash && doc.size === size) return { hash, size, chunks: doc.chunks }
  } catch { /* absent or corrupt manifest: rebuild */ }
  const chunks = []
  const input = createReadStream(stage, { highWaterMark: CHUNK })
  for await (const part of input) {
    const block = Buffer.from(part)
    const chunkHash = createHash('sha256').update(block).digest('hex')
    const target = join(root, 'chunks', chunkHash)
    try { await stat(target) } catch { await atomic(target, block) }
    chunks.push(chunkHash)
  }
  const manifest = { hash, size, chunks: chunks.length, chunkHashes: chunks }
  await atomic(manifestPath, Buffer.from(JSON.stringify(manifest) + '\n'))
  return { hash, size, chunks: chunks.length }
}

async function receive(req, res) {
  active++
  const stage = join(root, 'staging', randomUUID())
  const output = createWriteStream(stage, { flags: 'wx' })
  const digest = createHash('sha256')
  let size = 0, finished = false, aborted = false
  req.on('aborted', () => { aborted = true; output.destroy() })
  try {
    for await (const chunk of req) {
      if (aborted) throw new Error('upload aborted')
      const delay = Number(process.env['MONITOR_CONTENT_WRITE_DELAY_MS'] ?? 0)
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, Math.min(delay, 100)))
      digest.update(chunk)
      size += chunk.length
      if (!output.write(chunk)) await once(output, 'drain')
    }
    if (aborted || !req.complete) throw new Error('upload incomplete')
    output.end()
    await once(output, 'finish')
    const expected = req.headers['x-expected-bytes']
    if (expected !== undefined && Number(expected) !== size) throw new Error('length mismatch')
    const hash = digest.digest('hex')
    const ref = await publish(stage, hash, size)
    finished = true
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(ref))
  } catch (error) {
    output.destroy()
    if (!res.destroyed && !res.headersSent) {
      res.writeHead(aborted ? 499 : 400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: String(error.message ?? error) }))
    }
  } finally {
    await unlink(stage).catch(() => {})
    active--
    void finished
  }
}

await mkdir(join(root, 'staging'), { recursive: true })
await mkdir(join(root, 'chunks'), { recursive: true })
await mkdir(join(root, 'manifests'), { recursive: true })
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(); return }
  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ active })); return
  }
  if (req.method !== 'PUT' || req.url !== '/object') { res.writeHead(404); res.end(); return }
  // Each upload owns a unique staging file. Serializing entire request bodies
  // lets one long-lived response (SSE/slow stream) head-of-line block every
  // upload and download artifact, so receive concurrently and only serialize
  // publication through atomic content-addressed files.
  void receive(req, res)
})
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  process.stdout.write(JSON.stringify({ host: '127.0.0.1', port: address.port, token }) + '\n')
})
process.stdin.resume()
process.stdin.on('end', () => server.close())
