# A-029：持久工作流与 Agent 协作运行时验收

状态：纵向首版通过 · 验收 2026-09-25 · 实现 `d77dd1a`、`5b5ff15`、`a0c989d` · 对应 [T-029](../tasks/T-029-workflow-agent-runtime.md)

## 证据与结论

- `test:knowledge-workflow` T-029 5/5：冻结 v1 DAG 完成等待请求、Action、变量提取、后续证据动作和节点时间线。
- 并发运行中执行人类 takeover 后 fencing 从 1 升到 2，在飞节点变为 unknown；旧 token 恢复被拒，新 token 只有显式 `acknowledgeUnknown` 后才能继续并成功。
- pause/cancel 同样先轮换 fencing token，再中止本地执行器，避免旧循环覆盖命令状态；succeeded/canceled 终态不能恢复或接管。
- 真实关闭 Electron 再用同一数据目录启动：running run 恢复为 needsReview，在飞节点为 unknown，并留下 `run.recovered`，没有自动重发。
- 节点显式指定其它 workspace 时运行失败；节点递归调用 `workflow.*` 被拒，工作流不能扩大统一 Action 的权限。
- CLI 通过 `control.json` discovery 和 `/actions/execute` 返回与 UI/HTTP/MCP 相同的 ActionResult；`test:actions` 13/13 继续证明三入口幂等与目标约束。

结论：M8 单机持久工作流首版通过。复杂图形布线、分布式 lease 与独立事件订阅属于后续产品化，不影响本次安全恢复和协作闭环结论。
