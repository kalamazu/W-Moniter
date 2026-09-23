# T-007：任务日志诊断与恢复可见性

状态：已通过
认领：Codex · 2026-09-23
基线 commit：`80a3cce`
蓝图映射：M0 §3.2
优先级：P1
依赖：T-002

## 目标与验收

将 journal 损坏、恢复数量和最后写入时间作为可查询诊断；损坏日志仍不阻塞启动。验收覆盖半写入、恢复为 unknown 和 HTTP/MCP 查询。

## 实现交付

实现提交：`94958b0`（共用集成提交）。`running` 立即落盘；重启时 `queued/running` 恢复为 `unknown`，损坏 journal 备份隔离。`tasks.diagnostics` 暴露存在性、损坏、恢复数量、任务数和最近写入时间。

自动验证：`npm run test:actions` 13/13。独立验收见 [A-007](../acceptance/A-007-task-journal-diagnostics.md)。
