# A-Q002：Runner/Indexer 独立进程基础验收

状态：已通过 · 验收 2026-09-25 · 对应 [Q-002](../tasks/Q-002-worker-runtime.md)

## 证据与结论

- `test:quality-core` 验证 runner 和正文 extractor 的 PID 均不同于主进程；HTTP 响应正文与中文提取结果保持正确。
- 在慢请求执行中主动终止 worker：在途调用明确失败，主进程不退出；下一次 health 自动启动不同 PID 的新 worker。
- RPC 为每次调用提供 request id、超时和 AbortSignal 取消；64MiB 响应上限与最多 10 次重定向保留在隔离执行器中。
- `electron-builder.yml` 将 `workers/` 放入 asar 外资源；应用退出时显式停止 worker。
- 回归：`test:execution-centers` 11/11、`test:knowledge-workflow` 9/9、`test:actions` 14/14、`test:resource-scale` 2/2。

结论：Q-002 定义的独立执行基础通过。当前 Indexer 只下沉正文解码，全文检索仍是 JSON 派生索引和子串扫描；FTS/增量倒排索引需要后续单独任务，不能由本验收推导为已经具备。
