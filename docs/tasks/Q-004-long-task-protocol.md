# Q-004：长任务、事件游标与恢复协议

状态：开发中 · 优先级：P0 · 认领：Codex（2026-09-25） · 基线：`d0fa446`

目标：Action 可立即返回 taskId，统一提供状态、结果、事件游标、取消与重启 unknown 语义，HTTP/MCP/UI 共用。

验收：长任务启动不阻塞控制请求；事件可增量读取；取消与重启后的终态准确。

进展：HTTP 已提供 `/actions/start`、`/tasks/:id`、`/tasks/events?after=`；端到端用 800ms 工作流证明启动小于 500ms、结果可轮询、cursor 不重复。取消改为幂等单终态，事件 sidecar 超过 8MiB 自动压缩。MCP/UI 的 start/get/events 对等入口尚未补齐，因此保持开发中。
