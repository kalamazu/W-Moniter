import { startOrigin } from 'file:///F:/code/chrome/scripts/test-origin.mjs'

const origin = await startOrigin(8851)
const base = `http://127.0.0.1:${origin.port}`
const html = await (await fetch(base + '/realtime.html')).text()
console.log('page bytes', html.length)

const ws = new WebSocket(`ws://127.0.0.1:${origin.port}/ws-probe`)
const got = []
ws.onmessage = (e) => got.push(typeof e.data === 'string' ? e.data : '(binary)')
await new Promise((r) => (ws.onopen = r))
ws.send('hello-from-node')
await new Promise((r) => setTimeout(r, 400))
console.log('client got', JSON.stringify(got))
console.log('wsLog', JSON.stringify(origin.wsLog))
ws.close()
await new Promise((r) => setTimeout(r, 300))
console.log('wsLog after close', JSON.stringify(origin.wsLog.map((x) => x.dir)))

const echo = await (await fetch(base + '/api/json-echo?token=tk-1&page=1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'amy', n: 1 }) })).json()
console.log('echo', JSON.stringify(echo))
const echo2 = await (await fetch(base + '/api/json-echo?token=tk-1&page=2', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'bob', n: 2, extra: true }) })).json()
console.log('echo2', JSON.stringify(echo2))
const dl = await fetch(base + '/download.txt')
console.log('download headers', dl.headers.get('content-disposition'), (await dl.text()).trim())
await origin.close()
process.exit(0)