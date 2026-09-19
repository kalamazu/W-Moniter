/**
 * rewriteBody 脚本的沙箱（共享实现）。
 *
 * 为什么在 proxy/ 下而不是 src/main/rules/：改写的两个执行方 —— 主进程的 CDP 路径
 * （小 body）和代理进程（大 body，§6.3 第 2 条）—— 必须**跑同一套语义**，
 * 否则同一条规则在两处的行为会不一致。代理是独立 node 进程，import 不了 TS，
 * 所以实现放在 .mjs，TS 那侧用 .d.mts 拿类型（和 correlate.mjs 同一套做法）。
 *
 * 用 node:vm 起一个干净上下文：脚本里没有 require / process / 宿主对象，
 * 只有 ECMAScript 内建。**这不是安全边界**（vm 挡不住 constructor 逃逸），
 * 目标是「脚本写崩了别把进程一起带走」—— 超时和异常都收在这一层。
 *
 * 脚本约定：一段函数体，参数是 (body, ctx)，return 新的 body。
 *   return body.replace('"debug":false', '"debug":true')
 * 不返回字符串 = 不改（记 noop，不算失败）。
 */
import vm from 'node:vm'

export class ScriptSandbox {
  constructor(timeoutMs = Number(process.env['MONITOR_RULE_SCRIPT_TIMEOUT_MS'] ?? 200)) {
    this.timeoutMs = timeoutMs
    this.cache = new Map()
  }

  get timeout() {
    return this.timeoutMs
  }

  compile(script) {
    const cached = this.cache.get(script)
    if (cached) return cached
    // 包成「定义 + 立即调用」一次执行，超时才能罩住脚本本身 ——
    // 只把函数拿出来再在宿主里调用一次的话，超时就管不到它了。
    const source = '(function (body, ctx) {\n' + script + '\n})(__body, __ctx)'
    const compiled = new vm.Script(source, { filename: 'monitor-rule.js' })
    if (this.cache.size >= 200) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(script, compiled)
    return compiled
  }

  run(script, body, ctx) {
    let compiled
    try {
      compiled = this.compile(script)
    } catch (err) {
      return { ok: false, error: '脚本编译失败：' + (err && err.message ? err.message : String(err)) }
    }

    // 只把纯数据递进去，ctx 冻结，脚本改不动我们的对象
    const sandbox = vm.createContext({ __body: body, __ctx: Object.freeze({ ...ctx }) })
    try {
      const out = compiled.runInContext(sandbox, { timeout: this.timeoutMs })
      if (typeof out !== 'string') return { ok: true, noop: true }
      return { ok: true, body: out }
    } catch (err) {
      const message = (err && err.message) || String(err)
      return { ok: false, error: message, timedOut: /timed out/i.test(message) }
    }
  }
}
