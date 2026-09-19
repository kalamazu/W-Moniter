import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startOrigin } from '../scripts/test-origin.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9601
const origin = await startOrigin(0)
const url = 'http://127.0.0.1:' + origin.port + '/dom-probe.html'
const dir = mkdtempSync(join(tmpdir(), 'raw-css-'))
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--user-data-dir=' + dir, '--remote-debugging-port=' + PORT, url], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let target = null
for (let i = 0; i < 60 && !target; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
    target = list.find((t) => t.type === 'page' && String(t.url).includes('dom-probe')) ?? null
  } catch {}
  if (!target) await sleep(300)
}
if (!target) throw new Error('no target')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 1
const pending = new Map()
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const s = pending.get(m.id); if (!s) return; pending.delete(m.id); m.error ? s.reject(new Error(JSON.stringify(m.error))) : s.resolve(m.result) }
const send = (method, params = {}) => new Promise((resolve, reject) => { const i = id++; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })) })

await send('DOM.enable')
await send('CSS.enable')
const doc = await send('DOM.getDocument', { depth: 0 })
const hit = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#probe-inline' })
const styles = await send('CSS.getMatchedStylesForNode', { nodeId: hit.nodeId })
console.log('keys =', Object.keys(styles))
console.log('inlineStyle =', JSON.stringify(styles.inlineStyle))
console.log('attributesStyle =', JSON.stringify(styles.attributesStyle))
console.log('matchedCSSRules[0] =', JSON.stringify(styles.matchedCSSRules?.[0]))
console.log('matched selectors =', (styles.matchedCSSRules ?? []).map((r) => [r.rule?.selectorList?.text, r.rule?.style?.cssProperties?.map((p) => [p.name, p.value, p.implicit])]))
ws.close(); chrome.kill(); await origin.close(); process.exit(0)
