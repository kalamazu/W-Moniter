# A-007：任务日志诊断独立验收

状态：待独立验收 · 实现 `94958b0` · 对应 [T-007](../tasks/T-007-task-journal-diagnostics.md)

自动证据：`npm run test:actions` 13/13，覆盖 running 状态先落盘、重启恢复 unknown、不重复执行、半写入 JSON 隔离备份、UI/HTTP/MCP 诊断可读。

独立复核：真实进程中断后检查日志备份和诊断时间；评估任务数持续增长时的账本上限/压缩方案。本任务未实现任务事件表迁移。
