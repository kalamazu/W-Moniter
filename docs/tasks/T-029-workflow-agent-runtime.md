# T-029：持久工作流与 Agent 协作运行时

状态：待验收
蓝图映射：M8 §8.2
优先级：P1
认领：Codex（2026-09-25）
基线 commit：`11f98e1`
验收：[A-029](../acceptance/A-029-workflow-agent-runtime.md)

## 背景与目标

单个动作和批量测试仍需要人工串联。本任务让浏览器、重放、存储、测试和证据动作可以组成持久工作流，并支持等待、恢复、人类接管和 Agent 通过同一 run 时间线协作。

## 范围

- 要实现：版本化顺序/DAG 流程、条件与等待事件、变量和检查点、执行租约、崩溃恢复、暂停/取消/接管、运行时间线、表格与图形编辑、CLI/HTTP/MCP 等价调用。
- 要修改的边界：workflow engine/repository、Task journal 事件游标、能力目录、订阅/深链接和工作流工作台。
- 非目标：不允许工作流扩大已有动作权限；网页内容不能修改授权或目标。

## 依赖与风险

- 前置任务：T-024～T-028。
- 风险：恢复时重发未知写动作、旧租约继续控制浏览器、等待事件丢失、人类与 Agent 并发冲突。
- 需要 ADR：工作流恢复、fencing lease、人类接管与外部副作用补偿。

## 验收标准

- 一条流程完成“页面动作→等待请求→提取变量→重放→断言→修改存储→保存证据”，UI/HTTP/MCP/CLI 指向同一 run。
- 进程中断后从安全检查点恢复，不自动重发 unknown 写动作；接管后旧执行者失效。
- 覆盖等待超时、取消、断线、并发浏览器、权限拒绝、版本冻结和证据深链接。

## 完成记录

- 实现 commit：`d77dd1a`、`5b5ff15`
- 修改文件：`src/shared/contracts/workflow.ts`、`src/main/workflow/service.ts`、`src/main/actions/registry.ts`、`WorkflowPanel.tsx`、`cli/monitor.mjs`
- 测试命令与结果：`test:knowledge-workflow` 的 T-029 5/5；真实进程中断重启、接管 fencing、旧租约拒绝和跨工作区拒绝通过。
- 已知限制：本地 V1 为单机工作流和 JSON DAG 编辑；复杂图形布线、暂停后事件流订阅和分布式多用户 lease 留待生产化。
- 回滚：先 `git revert 5b5ff15`，再 `git revert d77dd1a`（后者与 T-028 共用接线）。
