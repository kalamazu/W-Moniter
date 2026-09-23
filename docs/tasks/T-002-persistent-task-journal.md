# T-002：持久任务账本与恢复语义

状态：已通过
蓝图映射：M0 §3.2
优先级：P0
依赖：T-001

## 目标

将 TaskService 从主进程内存账本迁为工作区目录内的追加式任务日志；重启后保留已完成任务，并把中断中的任务如实恢复为 `unknown`，不伪造成功。

## 验收

- 同一幂等键跨应用重启仍复用已完成任务；冲突输入明确失败。
- running/queued 任务重启后变为 `unknown`，保留输入 hash 与目标。
- 日志损坏或半写入不阻塞工作区启动，且产生可查询诊断。
- A-002 覆盖重启、冲突和恢复。

## 完成记录

- 认领：Codex · 2026-09-23；基线：`1c36c1d`。
- 实现：`TaskService` 将快照和输出原子写入 `tasks/journal.json`；重启恢复未完成任务为 `unknown`。
- 实现 commit：`2014701`；回滚：`git revert 2014701`。
- 验证：`npm run test:actions`（6/6）、`npm run typecheck`。
