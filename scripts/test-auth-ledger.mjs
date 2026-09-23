#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createInterface } from 'node:readline'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startOrigin } from './test-origin.mjs'
import { launchApp, makeChecker, sleep } from './app-harness.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const temp = mkdtempSync(join(tmpdir(), 'monitor-auth-'))
const origin = await startOrigin(0)
const base = `http://127.0.0.1:${origin.port}`
const { check, assert, report } = makeChecker()
let app, mcp

async function endpoint() {
  for (let i = 0; i < 100; i += 1) {
    const path = join(temp, 'control.json')
    if (existsSync(path)) {
      try { const value = JSON.parse(readFileSync(path, 'utf8')); if (value.port && value.token) return value } catch {}
    }
    await sleep(100)
  }
  throw new Error('control endpoint unavailable')
}
async function api(method, path, body) {
  const info = await endpoint()
  const response = await fetch(`http://127.0.0.1:${info.port}${path}`, { method,
    headers: { authorization: `Bearer ${info.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, body: await response.json() }
}
function mcpClient() {
  const child = spawn(process.execPath, [join(root, 'mcp', 'server.mjs'), `--data-dir=${temp}`], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
  let next = 1; const pending = new Map()
  createInterface({ input: child.stdout }).on('line', line => {
    let msg; try { msg = JSON.parse(line) } catch { return }
    const done = pending.get(msg.id); if (done) { pending.delete(msg.id); done(msg) }
  })
  return { child, send(method, params) {
    const id = next++
    const response = new Promise(resolve => pending.set(id, resolve))
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return response
  }, async call(name, args) {
    const result = await this.send('tools/call', { name, arguments: args })
    if (result.result?.isError) throw new Error(JSON.stringify(result.result.content))
    return JSON.parse(result.result.content[0].text)
  } }
}

try {
  app = await launchApp({ url: `${base}/dom-probe.html`, dataDir: temp, port: 9550,
    extraEnv: { MONITOR_MAX_ACTIVE_WORKSPACES: '2' } })
  await app.waitConnected(1)
  await api('POST', '/navigate', { url: `${base}/auth/login?account=Alice` })
  let passive = null
  for (let n = 0; n < 20; n += 1) {
    passive = await api('GET', '/workspaces/default/auth')
    if (passive.body.output?.some(row => row.state === 'suspected')) break
    await sleep(150)
  }
  check('cookie alone is only a suspected login clue', () => assert(passive.body.output?.some(row => row.state === 'suspected'), JSON.stringify(passive.body)))
  const verifiedA = await api('POST', '/workspaces/default/auth/verify-fixture', { origin: `${base}/` })
  check('active fixture verification identifies Alice', () => {
    assert(verifiedA.body.output?.state === 'verified', JSON.stringify(verifiedA.body))
    assert(verifiedA.body.output?.accountLabel === 'Alice')
  })

  const created = await app.evaluate("window.monitor.createWorkspace({name:'Bob workspace',profile:'L'})")
  const id = created.output?.id
  assert(id, JSON.stringify(created))
  await app.evaluate(`window.monitor.openWorkspace(${JSON.stringify(id)})`)
  const navigated = await api('POST', '/navigate', { url: `${base}/auth/login?account=Bob` })
  assert(navigated.status === 200, JSON.stringify(navigated))
  await sleep(350)
  const verifiedB = await api('POST', `/workspaces/${encodeURIComponent(id)}/auth/verify-fixture`, { origin: `${base}/` })
  check('second workspace verifies Bob independently', () => {
    assert(verifiedB.body.output?.state === 'verified', JSON.stringify(verifiedB.body))
    assert(verifiedB.body.output?.accountLabel === 'Bob')
  })
  const a = await api('GET', '/workspaces/default/auth')
  const b = await api('GET', `/workspaces/${encodeURIComponent(id)}/auth`)
  check('scope-separated summaries never cross identities', () => {
    assert(a.body.output?.some(row => row.account_label === 'Alice' && row.state === 'verified'), JSON.stringify(a.body))
    assert(!a.body.output?.some(row => row.account_label === 'Bob'))
    assert(b.body.output?.some(row => row.account_label === 'Bob' && row.state === 'verified'), JSON.stringify(b.body))
    assert(!b.body.output?.some(row => row.account_label === 'Alice'))
  })
  const bogus = await api('GET', '/workspaces/not-a-workspace/auth')
  check('unknown scope rejected, never falls back to active workspace', () => assert(!bogus.body.output))

  mcp = mcpClient()
  await mcp.send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'auth-test', version: '1' } })
  const fromMcp = await mcp.call('monitor_auth_ledger', { workspaceId: id })
  check('HTTP and MCP use the same summary', () => assert(JSON.stringify(fromMcp.output) === JSON.stringify(b.body.output), JSON.stringify(fromMcp)))
  await sleep(2300)
  await app.evaluate("document.querySelector('.workspace-evidence')?.setAttribute('open', '')")
  const ui = await app.evaluate('document.body.innerText')
  check('workspace UI shows verified identity and source', () => assert(ui.includes('已验证 Bob'), ui.slice(0, 400)))

  await api('POST', '/navigate', { url: `${base}/auth/expire` })
  const expired = await api('POST', `/workspaces/${encodeURIComponent(id)}/auth/verify-fixture`, { origin: `${base}/` })
  check('server-side expiry changes verified to logged_out', () => assert(expired.body.output?.state === 'logged_out'))
  await api('POST', '/navigate', { url: `${base}/auth/login?account=slow` })
  const timeout = await api('POST', `/workspaces/${encodeURIComponent(id)}/auth/verify-fixture`, { origin: `${base}/` })
  check('verification timeout is unknown, not logged_out', () => assert(timeout.body.output?.state === 'unknown', JSON.stringify(timeout.body)))
  await api('POST', '/navigate', { url: `${base}/auth/login?account=Bob` })
  const reverified = await api('POST', `/workspaces/${encodeURIComponent(id)}/auth/verify-fixture`, { origin: `${base}/` })
  assert(reverified.body.output?.state === 'verified')
  await api('POST', `/workspaces/${encodeURIComponent(id)}/suspend`)
  await api('POST', `/workspaces/${encodeURIComponent(id)}/open`)
  const afterRestore = await api('GET', `/workspaces/${encodeURIComponent(id)}/auth`)
  check('restart downgrades old verified evidence to stale', () => assert(afterRestore.body.output?.some(row => row.state === 'stale'), JSON.stringify(afterRestore.body)))

  const db = new DatabaseSync(join(temp, 'workspaces', id, 'monitor.db'))
  const evidence = db.prepare('SELECT detail, account_label FROM auth_observations').all()
  db.close()
  check('secret cookie value absent from auth evidence', () => assert(!JSON.stringify(evidence).includes('auth_session=')))
} catch (error) { check('auth ledger flow', () => { throw error }) }
finally {
  mcp?.child?.kill()
  if (app) await app.close()
  await origin.close()
  if (resolve(temp).startsWith(resolve(tmpdir()) + sep)) rmSync(temp, { recursive: true, force: true })
}
process.exit(report() ? 0 : 1)
