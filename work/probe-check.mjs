import { startOrigin } from '../scripts/test-origin.mjs'
const o = await startOrigin(0)
for (const p of ['/', '/dom-probe.html']) {
  const r = await fetch('http://127.0.0.1:' + o.port + p)
  const t = await r.text()
  console.log(p, r.status, 'len=' + t.length, 'probeBtn=' + /probe-btn/.test(t), 'idApp=' + /id="app"/.test(t))
}
await o.close()
