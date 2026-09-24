import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { connect } from 'node:net'
import { dirname } from 'node:path'

export type UpstreamKind = 'direct' | 'http-connect' | 'socks5'
export interface EnvironmentRoute { match: string; upstreamId: string; required: boolean }
export interface EnvironmentUpstream { id: string; kind: UpstreamKind; host?: string; port?: number; secretRef?: string }
export interface EnvironmentConfig {
  version: number
  createdAt: number
  name: string
  dnsMode: 'system' | 'proxy'
  upstreams: EnvironmentUpstream[]
  routes: EnvironmentRoute[]
}
export interface EnvironmentState { schemaVersion: 1; activeVersion: number; appliedVersion: number | null; pendingRestart: boolean; versions: EnvironmentConfig[] }

/** 每个工作区一份、可回读可回滚的网络环境；凭据只保存 SecretRef。 */
export class EnvironmentRepository {
  constructor(private readonly path: string) {}

  get(): EnvironmentState { return this.read() }

  save(input: Omit<EnvironmentConfig, 'version' | 'createdAt'>): EnvironmentConfig {
    validate(input)
    const state = this.read()
    const config: EnvironmentConfig = { ...input, version: (state.versions.at(-1)?.version ?? 0) + 1, createdAt: Date.now() }
    state.versions.push(config)
    state.activeVersion = config.version
    state.pendingRestart = state.appliedVersion !== config.version
    this.write(state)
    return config
  }

  apply(version = this.read().activeVersion): EnvironmentState {
    const state = this.read()
    if (!state.versions.some((item) => item.version === version)) throw new Error(`环境版本不存在：${version}`)
    state.activeVersion = version
    state.appliedVersion = version
    state.pendingRestart = true
    this.write(state)
    return state
  }

  rollback(version: number): EnvironmentState { return this.apply(version) }

  markStarted(version: number): EnvironmentState {
    const state = this.read()
    if (state.appliedVersion === version) state.pendingRestart = false
    this.write(state)
    return state
  }

  async diagnose(version = this.read().activeVersion): Promise<{ version: number; checks: Array<Record<string, unknown>> }> {
    const config = this.read().versions.find((item) => item.version === version)
    if (!config) throw new Error(`环境版本不存在：${version}`)
    const checks: Array<Record<string, unknown>> = []
    for (const upstream of config.upstreams) {
      if (upstream.kind === 'direct') { checks.push({ upstreamId: upstream.id, kind: upstream.kind, ok: true, detail: 'direct' }); continue }
      const started = Date.now()
      try {
        const address = await lookup(upstream.host!)
        await tcpProbe(address.address, upstream.port!, 3000)
        checks.push({ upstreamId: upstream.id, kind: upstream.kind, ok: true, dns: address.address, connectMs: Date.now() - started, authenticated: Boolean(upstream.secretRef) })
      } catch (error) {
        checks.push({ upstreamId: upstream.id, kind: upstream.kind, ok: false, connectMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { version, checks }
  }

  private read(): EnvironmentState {
    if (!existsSync(this.path)) {
      const initial: EnvironmentConfig = { version: 1, createdAt: Date.now(), name: 'Direct', dnsMode: 'system', upstreams: [{ id: 'direct', kind: 'direct' }], routes: [{ match: '*', upstreamId: 'direct', required: true }] }
      return { schemaVersion: 1, activeVersion: 1, appliedVersion: null, pendingRestart: false, versions: [initial] }
    }
    const state = JSON.parse(readFileSync(this.path, 'utf8')) as EnvironmentState
    if (state.schemaVersion !== 1 || !Array.isArray(state.versions)) throw new Error('环境配置账本损坏')
    return state
  }

  private write(state: EnvironmentState): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', 'utf8')
    renameSync(temporary, this.path)
  }
}

function validate(input: Omit<EnvironmentConfig, 'version' | 'createdAt'>): void {
  const rootKeys = new Set(['name', 'dnsMode', 'upstreams', 'routes'])
  if (Object.keys(input as object).some((key) => !rootKeys.has(key))) throw new Error('环境配置包含未识别字段')
  if (!input.name.trim() || input.name.length > 80) throw new Error('环境名称需要是 1–80 个字符')
  if (!['system', 'proxy'].includes(input.dnsMode)) throw new Error('DNS 模式无效')
  if (!input.upstreams.length) throw new Error('至少需要一个上游')
  const ids = new Set<string>()
  for (const upstream of input.upstreams) {
    const upstreamKeys = new Set(['id', 'kind', 'host', 'port', 'secretRef'])
    if (Object.keys(upstream).some((key) => !upstreamKeys.has(key))) throw new Error(`上游 ${upstream.id || '?'} 包含未识别字段；凭据只能使用 secretRef`)
    if (!['direct', 'http-connect', 'socks5'].includes(upstream.kind)) throw new Error('上游类型无效')
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(upstream.id) || ids.has(upstream.id)) throw new Error('上游 ID 无效或重复')
    ids.add(upstream.id)
    if (upstream.kind !== 'direct') {
      if (!upstream.host || !Number.isInteger(upstream.port) || upstream.port! < 1 || upstream.port! > 65535) throw new Error(`上游 ${upstream.id} 地址无效`)
      if (upstream.secretRef && !/^secret:\/\/[A-Za-z0-9._/-]+$/.test(upstream.secretRef)) throw new Error('认证信息必须使用 secret:// 引用')
    }
  }
  for (const route of input.routes) {
    const routeKeys = new Set(['match', 'upstreamId', 'required'])
    if (Object.keys(route).some((key) => !routeKeys.has(key))) throw new Error('路由包含未识别字段')
    if (!route.match.trim() || !ids.has(route.upstreamId)) throw new Error('路由规则引用了无效上游')
  }
  if (!input.routes.some((route) => route.match === '*')) throw new Error('必须提供 * 默认路由，禁止失败后静默直连')
}

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port })
    const done = (error?: Error): void => { socket.destroy(); error ? reject(error) : resolve() }
    socket.setTimeout(timeoutMs, () => done(new Error('connect_timeout')))
    socket.once('connect', () => done())
    socket.once('error', done)
  })
}
