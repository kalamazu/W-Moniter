# T-006：规则动作的显式工作区目标

状态：已通过
认领：Codex · 2026-09-23
基线 commit：`80a3cce`
蓝图映射：M0 §3.1、M2 §5
优先级：P1
依赖：T-001

## 目标

把规则读取/保存迁入 ActionRegistry。保存规则必须携带 `TargetRef.workspaceId` 与可选版本守卫；不允许规则面板焦点或 HTTP 当前连接决定写入哪个工作区。

## 验收

- UI、HTTP、MCP 对同一规则写操作复用任务结果和幂等语义。
- 缺失/过期/后台工作区目标均有明确结果，不能误写活动工作区。
- A-006 覆盖两工作区隔离和冲突。

## 实现交付

实现提交：`94958b0`（共用集成提交）。规则面板、IPC、HTTP、MCP 统一经 `rules.get/save`，保存必须显式指定工作区；可选版本守卫与幂等键由动作层验证。后台工作区保存不会改动活动面板。

自动验证：`npm run test:actions` 13/13、`npm run test:smoke` 129/129、`npm run test:drill` 39/39。独立验收见 [A-006](../acceptance/A-006-targeted-rule-actions.md)。
