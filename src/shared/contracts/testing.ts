import type { ReplayMode, ReplayRun } from './replay'
export type TestAssertion =
  | { kind: 'status'; op: 'eq' | 'between'; value: number; max?: number }
  | { kind: 'header'; name: string; contains: string }
  | { kind: 'body'; contains: string }
  | { kind: 'json'; path: string; equals: unknown }
  | { kind: 'time'; maxMs: number }
export interface TestSuite {
  id: string; version: number; name: string; templateId: string; mode: ReplayMode
  iterations: number; concurrency: number; intervalMs: number; retries: number; stopOnFailure: boolean
  datasets: Array<Record<string, string | number | boolean>>; assertions: TestAssertion[]
  preScript?: string; postScript?: string; createdAt: number; updatedAt: number
}
export interface TestCaseResult { caseId: string; index: number; datasetIndex: number; state: 'passed' | 'failed' | 'cancelled' | 'notStarted' | 'unknown'; attempts: number; durationMs?: number; failures: string[]; replayRun?: ReplayRun }
export interface TestRunReport { id: string; suiteId: string; suiteVersion: number; startedAt: number; finishedAt: number; state: 'succeeded' | 'failed' | 'cancelled'; cases: TestCaseResult[]; summary: { total: number; passed: number; failed: number; cancelled: number; notStarted: number; attempts: number; latency: { samples: number; p50?: number; p95?: number; max?: number } } }
