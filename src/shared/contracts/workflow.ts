import type { TargetRef } from './action'

export type WorkflowNode = {
  id: string; kind: 'action'; action: string; input: unknown; target?: TargetRef; dependsOn?: string[]
  when?: { variable: string; equals: unknown }; extract?: Record<string, string>; retries?: number
} | {
  id: string; kind: 'wait'; wait: { type: 'delay'; ms: number } | { type: 'request'; query: Record<string, unknown>; timeoutMs: number; pollMs?: number }
  dependsOn?: string[]; extract?: Record<string, string>
}
export interface WorkflowDefinition { id: string; version: number; name: string; nodes: WorkflowNode[]; createdAt: number; updatedAt: number }
export type WorkflowNodeState = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'canceled' | 'unknown'
export interface WorkflowNodeRun { nodeId: string; state: WorkflowNodeState; attempts: number; startedAt?: number; finishedAt?: number; output?: unknown; error?: string }
export interface WorkflowEvent { at: number; type: string; nodeId?: string; detail?: string; lease: number }
export interface WorkflowRun {
  id: string; workflowId: string; workflowVersion: number; workspaceId: string
  state: 'running' | 'paused' | 'succeeded' | 'failed' | 'canceled' | 'needsReview'
  lease: number; leaseToken: string; owner: 'agent' | 'human'; variables: Record<string, unknown>
  nodes: WorkflowNodeRun[]; timeline: WorkflowEvent[]; createdAt: number; updatedAt: number
}

