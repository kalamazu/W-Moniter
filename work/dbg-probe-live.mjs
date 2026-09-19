import { readFileSync } from 'node:fs'
const info = JSON.parse(readFileSync('F:/code/chrome/.userdata/smoke-input/control.json', 'utf8'))
const auth = { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' }
const base = `http://127.0.0.1:${info.port}`
const withTimeout = async (label, promise) => {
  const t0 = Date.now()
  try {
    const res = await Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('超时 8s')), 8000))])
    console.log(`${label}: HTTP ${res.status} ${(await res.text()).slice(0, 200)} (${Date.now() - t0}ms)`)
  } catch (error) {
    console.log(`${label}: ${error.message} (${Date.now() - t0}ms)`)
  }
}
await withTimeout('GET /status', fetch(base + '/status', { headers: auth }))
await withTimeout('GET /health', fetch(base + '/health'))
await withTimeout('POST /input(click body)', fetch(base + '/input', { method: 'POST', headers: auth, body: JSON.stringify({ kind: 'click', selector: 'body', seed: 1 }) }))
await withTimeout('POST /input(click x/y)', fetch(base + '/input', { method: 'POST', headers: auth, body: JSON.stringify({ kind: 'click', x: 100, y: 100, seed: 1 }) }))
await withTimeout('GET /status2', fetch(base + '/status', { headers: auth }))