/**
 * proxy/rule-sandbox.mjs 的类型声明（给主进程的 TS 用）。
 * 实现刻意留在 .mjs：代理是独立 node 进程，import 不了 TS。
 */

export interface SandboxContext {
  url: string
  method: string
  status?: number
  headers: Record<string, string>
  /** base64 过来的二进制响应。改之前想清楚，往返会破坏字节 */
  isBinary: boolean
  resourceType?: string
}

export interface SandboxResult {
  ok: boolean
  body?: string
  error?: string
  timedOut?: boolean
  /** 脚本没返回字符串 —— 按「不改」处理 */
  noop?: boolean
}

export declare class ScriptSandbox {
  constructor(timeoutMs?: number)
  readonly timeout: number
  run(script: string, body: string, ctx: SandboxContext): SandboxResult
}
