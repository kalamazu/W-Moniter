/**
 * rewriteBody 脚本的沙箱（主进程这一侧的入口）。
 *
 * 实现搬去了 proxy/rule-sandbox.mjs —— 因为改写的两个执行方
 * （主进程的 CDP 路径、代理进程的大 body 路径）必须跑同一套语义，
 * 而代理是独立 node 进程，import 不了 TS。这里只做转出，保证既有引用不动。
 */
export { ScriptSandbox } from '../../../proxy/rule-sandbox.mjs'
export type { SandboxContext, SandboxResult } from '../../../proxy/rule-sandbox.mjs'
