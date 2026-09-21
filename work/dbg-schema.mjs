import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const base = 1_700_000_000_000
const sha = (t) => createHash('sha256').update(t).digest('hex')
const child = spawn(process.execPath, ['storage/server.mjs'], { stdio: ['pipe', 'pipe', 'inherit'] })
let id = 1
const pending = new Map()
let carry = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (c) => {
  carry += c
  let nl
  while ((nl = carry.indexOf('\n')) >= 0) {
    const line = carry.slice(0, nl); carry = carry.slice(nl + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    const slot = pending.get(msg.id); pending.delete(msg.id)
    if (slot) slot(msg)
  }
})
const call = (op, args = {}) => new Promise((res, rej) => {
  const myId = id++
  pending.set(myId, (m) => (m.ok ? res(m.result) : rej(new Error(op + ': ' + m.error))))
  child.stdin.write(JSON.stringify({ id: myId, op, args }) + '\n')
})
const dir = mkdtempSync(join(tmpdir(), 'dbg-'))
await call('open', { dbPath: join(dir, 'm.db') })
const { instId } = await call('beginInstance', { url: 'http://x/' })
const mk = (seq, body, status) => ({
  seq, key: 'k' + seq, request_id: 'r' + seq, session_id: 's', target_id: 'T', target_type: 'page',
  frame_url: 'http://x/', url: 'https://api.test/user/' + seq, host: 'api.test', scheme: 'https', path: '/user/' + seq,
  method: 'GET', resource_type: 'XHR', mime_type: 'application/json', status, status_text: 'OK',
  resp_headers: JSON.stringify({ 'content-type': 'application/json' }),
  encoded_len: 10, decoded_len: 10, ttfb_ms: 1, duration_ms: 2, start_ts: base + seq, end_ts: base + seq + 2
})
const bodies = ['{"id":42,"name":"alpha"}', '{"id":43,"name":"bravo"}', '{"error":"boom"}']
await call('appendRequests', { inst: instId, rows: [mk(1, null, 200), mk(2, null, 200), mk(3, null, 500)] })
await call('appendBodies', { inst: instId, items: bodies.map((t, i) => ({ seq: i + 1, hash: sha(t), size: t.length, trunc: false, b64: Buffer.from(t).toString('base64') })) })
await call('setRequestBodies', { inst: instId, items: bodies.map((t, i) => ({ seq: i + 1, state: 'stored', size: t.length, hash: sha(t), trunc: false })) })
const detail = await call('endpointDetail', { inst: instId, key: 'GET api.test/user/{int}' })
console.log(JSON.stringify(detail.responseSchema, null, 1))
console.log(JSON.stringify(detail.responseFields, null, 1))
child.stdin.end()