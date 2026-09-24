import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Script, createContext } from 'node:vm'
import type { ReplayRun, ReplayTemplate } from '../../shared/contracts/replay'
import type { TestAssertion, TestCaseResult, TestRunReport, TestSuite } from '../../shared/contracts/testing'
import type { ContentStore } from '../content/store'

interface TestingState { schemaVersion: 1; suites: TestSuite[]; runs: TestRunReport[] }
type Execute = (template: ReplayTemplate, signal?: AbortSignal) => Promise<ReplayRun>

export class TestingService {
  private readonly path: string
  constructor(root: string, private readonly content: ContentStore) { this.path = join(root, 'testing.json') }
  list(): TestingState { const state = this.read(); return { ...state, runs: state.runs.slice(-100).reverse() } }
  save(input: Omit<TestSuite, 'id' | 'version' | 'createdAt' | 'updatedAt'> & { id?: string }): TestSuite {
    validate(input); const state = this.read(); const now = Date.now(); const previous = input.id ? state.suites.filter((item) => item.id === input.id).sort((a, b) => b.version - a.version)[0] : undefined
    const suite: TestSuite = { ...input, id: input.id ?? `ts_${randomUUID()}`, version: (previous?.version ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now }
    state.suites.push(suite); this.write(state); return suite
  }
  get(id: string, version?: number): TestSuite { const suite = this.read().suites.filter((item) => item.id === id && (version === undefined || item.version === version)).sort((a, b) => b.version - a.version)[0]; if (!suite) throw new Error(`测试套件不存在：${id}`); return suite }

  async run(suite: TestSuite, base: ReplayTemplate, execute: Execute, signal?: AbortSignal): Promise<TestRunReport> {
    const startedAt = Date.now(); const total = suite.iterations; const cases: TestCaseResult[] = Array.from({ length: total }, (_, index) => ({ caseId: `case_${index + 1}`, index, datasetIndex: index % Math.max(1, suite.datasets.length), state: 'notStarted', attempts: 0, failures: [] }))
    let cursor = 0; let stopped = false
    const worker = async (): Promise<void> => {
      while (!stopped) {
        const index = cursor++; if (index >= total) return
        const item = cases[index]; if (signal?.aborted) { item.state = 'cancelled'; continue }
        const vars = { ...(suite.datasets[item.datasetIndex] ?? {}), iteration: index + 1 }
        let template = substitute(base, vars)
        try { if (suite.preScript) template = runScript(suite.preScript, { template, variables: { ...vars } }).template as ReplayTemplate }
        catch (error) { item.state = 'failed'; item.failures.push(`preScript: ${message(error)}`); if (suite.stopOnFailure) stopped = true; continue }
        for (let attempt = 0; attempt <= suite.retries; attempt += 1) {
          if (signal?.aborted) { item.state = 'cancelled'; break }
          item.attempts += 1
          const result = await execute(template, signal); item.replayRun = result; item.durationMs = result.response?.durationMs
          item.failures = await assertions(suite.assertions, result, this.content)
          if (suite.postScript) { try { runScript(suite.postScript, { result, variables: { ...vars } }) } catch (error) { item.failures.push(`postScript: ${message(error)}`) } }
          if (result.state === 'canceled') { item.state = 'cancelled'; break }
          if (result.state === 'unknown') { item.state = 'unknown'; break }
          if (!item.failures.length && result.state === 'succeeded') { item.state = 'passed'; break }
          item.state = 'failed'
        }
        if (item.state === 'failed' && suite.stopOnFailure) stopped = true
        if (suite.intervalMs > 0) await new Promise((resolve) => setTimeout(resolve, suite.intervalMs))
      }
    }
    await Promise.all(Array.from({ length: suite.concurrency }, () => worker()))
    if (stopped || signal?.aborted) for (const item of cases) if (item.state === 'notStarted') item.state = signal?.aborted ? 'cancelled' : 'notStarted'
    const report = makeReport(suite, startedAt, cases, signal?.aborted === true); const state = this.read(); state.runs.push(report); state.runs = state.runs.slice(-500); this.write(state); return report
  }
  private read(): TestingState { if (!existsSync(this.path)) return { schemaVersion: 1, suites: [], runs: [] }; const value = JSON.parse(readFileSync(this.path, 'utf8')) as TestingState; if (value.schemaVersion !== 1) throw new Error('测试仓库版本不兼容'); return value }
  private write(value: TestingState): void { mkdirSync(dirname(this.path), { recursive: true }); const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`; writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n'); renameSync(temporary, this.path) }
}

function validate(input: { name: string; iterations: number; concurrency: number; intervalMs: number; retries: number; datasets: unknown[]; assertions: unknown[] }): void { if (!input.name.trim()) throw new Error('套件名称不能为空'); if (!Number.isInteger(input.iterations) || input.iterations < 1 || input.iterations > 1000) throw new Error('次数范围 1–1000'); if (!Number.isInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 32) throw new Error('并发范围 1–32'); if (input.intervalMs < 0 || input.retries < 0 || input.retries > 5) throw new Error('间隔或重试无效') }
function substitute(template: ReplayTemplate, variables: Record<string, unknown>): ReplayTemplate { const replace = (value: string) => value.replace(/\$\{([A-Za-z0-9_.-]+)\}/g, (_, key) => String(variables[key] ?? '')); return { ...template, url: replace(template.url), headers: template.headers.map((item) => ({ name: item.name, value: replace(item.value) })), ...(template.body ? { body: { ...template.body, value: template.body.kind === 'text' ? replace(template.body.value) : template.body.value } } : {}) } }
function runScript(source: string, sandbox: Record<string, unknown>): Record<string, unknown> { const context = createContext({ ...sandbox }); const result = new Script(`"use strict";(()=>{${source}\n;return {template:typeof template==='undefined'?undefined:template,variables:typeof variables==='undefined'?undefined:variables}})()`).runInContext(context, { timeout: 100 }); return result as Record<string, unknown> }
async function assertions(list: TestAssertion[], run: ReplayRun, content: ContentStore): Promise<string[]> { const out: string[] = []; const response = run.response; let bodyText: string | null = null; for (const assertion of list) { if (!response) { out.push(`${assertion.kind}: no response`); continue } if (assertion.kind === 'status' && (assertion.op === 'eq' ? response.status !== assertion.value : response.status < assertion.value || response.status > (assertion.max ?? assertion.value))) out.push(`status=${response.status}`); if (assertion.kind === 'header') { const value = response.headers.filter((item) => item.name.toLowerCase() === assertion.name.toLowerCase()).map((item) => item.value).join(','); if (!value.includes(assertion.contains)) out.push(`header ${assertion.name}`) } if (assertion.kind === 'time' && response.durationMs > assertion.maxMs) out.push(`time=${response.durationMs}ms`); if (assertion.kind === 'body' || assertion.kind === 'json') { if (bodyText === null) { const bytes = response.bodyHash ? await content.get(response.bodyHash) : null; bodyText = bytes ? new TextDecoder().decode(bytes) : '' } if (assertion.kind === 'body' && !bodyText.includes(assertion.contains)) out.push(`body missing ${assertion.contains}`); if (assertion.kind === 'json') { try { let value: unknown = JSON.parse(bodyText); for (const key of assertion.path.split('.').filter(Boolean)) value = (value as Record<string, unknown>)?.[key]; if (JSON.stringify(value) !== JSON.stringify(assertion.equals)) out.push(`json ${assertion.path}`) } catch { out.push('json parse') } } } }
    return out }
function makeReport(suite: TestSuite, startedAt: number, cases: TestCaseResult[], canceled: boolean): TestRunReport { const values = cases.map((item) => item.durationMs).filter((value): value is number => typeof value === 'number').sort((a, b) => a - b); const pick = (q: number) => values.length ? values[Math.min(values.length - 1, Math.floor((values.length - 1) * q))] : undefined; const failed = cases.filter((item) => item.state === 'failed').length; return { id: `tr_${randomUUID()}`, suiteId: suite.id, suiteVersion: suite.version, startedAt, finishedAt: Date.now(), state: canceled ? 'cancelled' : failed ? 'failed' : 'succeeded', cases, summary: { total: cases.length, passed: cases.filter((item) => item.state === 'passed').length, failed, cancelled: cases.filter((item) => item.state === 'cancelled').length, notStarted: cases.filter((item) => item.state === 'notStarted').length, attempts: cases.reduce((sum, item) => sum + item.attempts, 0), latency: { samples: values.length, ...(values.length ? { p50: pick(.5), p95: pick(.95), max: values.at(-1) } : {}) } } } }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
