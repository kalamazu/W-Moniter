import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = 'F:/code/chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class Cdp {
  constructor(ws) {
    this.ws = ws; this.nextId = 1; this.pending = new Map()
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (!m.id) return; const s = this.pending.get(m.id); if (!s) return; this.pending.delete(m.id); m.error ? s.reject(new Error(m.error.message)) : s.resolve(m.result) }
    ws.onclose = () => { for (const s of this.pending.values()) s.reject(new Error('closed')); this.pending.clear() }
  }
  send(method, params = {}) { const id = this.nextId++; return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })) }) }
}
async function openCdp(url) {
  const ws = new WebSocket(url)
  await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('ws timeout')), 15000); ws.onopen = () => { clearTimeout(t); res() }; ws.onerror = () => rej(new Error('ws error')) })
  return new Cdp(ws)
}
async function waitTarget(port, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const h = l.find((t) => t.type === 'page' && String(t.url).includes('index.html')); if (h?.webSocketDebuggerUrl) return h } catch {}
    await sleep(400)
  }
  return null
}

const UI = `(async () => {
  const frame = () => new Promise((r) => setTimeout(r, 60))
  const waitFor = async (sel, ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { const el = document.querySelector(sel); if (el) return el; await frame() } return null }
  const text = (el) => (el ? el.textContent.trim() : '')
  const tabs = await waitFor('.tabs', 30000); if (!tabs) return { ok: false, reason: 'no-tabs' }
  const tab = [...document.querySelectorAll('.tab')].find((b) => b.textContent.trim() === '环境'); if (!tab) return { ok: false, reason: 'no-env-tab' }
  tab.click()
  const btn = await waitFor('.probe-run', 20000); if (!btn) return { ok: false, reason: 'no-btn' }
  btn.click()
  const rep = await waitFor('.probe-report', 90000); if (!rep) { const b = document.querySelector('.banner-err'); return { ok: false, reason: 'no-report', error: b ? b.textContent.trim() : '', html: document.body.innerHTML.length } }
  for (let i = 0; i < 8; i++) { const closed = [...document.querySelectorAll('.probe-group')].filter((g) => !g.querySelector('.probe-table')); if (!closed.length) break; for (const g of closed) g.querySelector('.probe-group-head')?.click(); await frame(); await frame() }
  return { ok: true, summary: text(document.querySelector('.probe-summary')), groupRows: [...document.querySelectorAll('.probe-group')].map((g) => ({ head: text(g.querySelector('.probe-group-head')), rows: [...g.querySelectorAll('.probe-table tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim())) })) }
})()`

async function run(profile, cdpPort, label) {
  const dir = `F:/code/chrome/work/probe-data/${label}-${Date.now()}`
  mkdirSync(dir, { recursive: true })
  const app = spawn('F:/code/chrome/node_modules/electron/dist/electron.exe', ['out/main/index.js', '--no-sandbox', `--remote-debugging-port=${cdpPort}`], {
    cwd: ROOT,
    env: { ...process.env, MONITOR_DATA_DIR: dir, MONITOR_URL: process.env.MONITOR_PROBE_URL ?? 'about:blank', MONITOR_PROFILE: profile, MONITOR_UI_TAB: 'env', MONITOR_CAPTURE_BODIES: '0', MONITOR_CAPTURE_SCRIPTS: '0', MONITOR_AUTO_QUIT_MS: '0' },
    stdio: 'ignore'
  })
  try {
    const target = await waitTarget(cdpPort, 60000)
    if (!target) { console.log(`${label}: no target`); return null }
    const cdp = await openCdp(target.webSocketDebuggerUrl)
    const expr = UI.replace('TIMEOUT_MS', '90000')
    let out = null
    for (let i = 0; i < 3 && !out; i++) {
      try {
        const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 180000 })
        if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'probe threw')
        out = r?.result?.value ?? null
      } catch (e) { await sleep(1000) }
    }
    return out
  } finally {
    try { app.kill() } catch {}
    await sleep(800)
    try { const { execFileSync } = await import('node:child_process'); execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `${ROOT}/scripts/cleanup-stray.ps1`, '-Root', ROOT], { stdio: 'pipe', timeout: 60000 }) } catch {}
  }
}

const which = process.argv[2] ?? 'chrome'
const ports = which === 'ungoogled' ? [9471, 9472] : [9481, 9482]
const label = which
for (const [profile, port] of [['L', ports[0]], ['H', ports[1]]]) {
  const out = await run(profile, port, label)
  console.log(`\n===== ${label} Profile ${profile} =====`)
  if (!out) { console.log('no outcome'); continue }
  if (!out.ok) { console.log('not ok:', JSON.stringify(out).slice(0, 300)); continue }
  console.log('summary:', out.summary)
  const g = out.groupRows.find((x) => x.head.includes('CDP'))
  if (g) for (const row of g.rows) console.log(`  [${row[0]}] ${row[1]} | ${row[2]} | ${row[3]}`)
}