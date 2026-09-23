# T-001：统一身份、动作与任务契约

状态：已通过
蓝图映射：M0 §3.1、§3.2  
优先级：P0  
认领：Codex · 2026-09-23
基线 commit：`207d584 docs: add task and acceptance workflow`
验收：[A-001](../acceptance/A-001-action-task-contract.md)

## 背景与目标

当前 UI、IPC、HTTP 与 MCP 仍直接调用当前 Controller，无法表达明确的工作区目标、幂等键、长期任务和“远端效果未知”。本任务建立后续重放、插件和 Agent 操作共享的执行语义。

## 范围

- 新增 `identity/action/result/task/catalog` 共享契约，至少覆盖 workspace/profile/browser/tab 与 TargetRef。
- 新增 ActionRegistry、TargetResolver、Policy 和最小 TaskService；写动作必须明确目标，查询可显式跨工作区。
- 将 workspace 的 list/create/open/suspend 迁入统一注册表；现有 IPC/HTTP/MCP 先走兼容适配层。
- 任务包含状态、幂等键、输入 hash、取消与 `unknown` 效果状态。

## 非目标

- 不实现重放运行器、用户脚本、插件宿主或完整工作流。
- 不在本任务迁移正文 BLOB 或所有存储表的 workspace scope。

## 验收标准

- 同一工作区动作由 UI、HTTP、MCP 调用时得到同结构结果和同一 taskId。
- 相同幂等键/相同输入返回原任务；相同键/不同输入返回冲突。
- 写动作无 TargetRef 或目标过期时明确失败，不回退到“当前工作区”。
- 创建 A-001，由独立验收者覆盖成功、取消、冲突、unknown 和跨工作区误操作。

## 风险与记录

- 控制面目前是手写路由；生成 catalog 的构建接线可能影响打包，需先写 ADR 或技术验证记录。
- 完成后必须更新《实施进度与待办》、任务看板与 A-001 证据。

## 完成记录

- 实现 commit：`318e797 feat: add target-aware action task contracts`。
- 实现：`src/shared/contracts/action.ts` 定义身份、目标、动作、任务和结果契约；`src/main/actions/*` 实现注册表、目标校验、幂等、取消和 unknown 效果语义。
- 接线：UI/IPC、HTTP、MCP 均通过统一动作服务；兼容的工作区路由仍可使用，但返回统一 `ActionResult` 外壳。
- 验证：`npm run typecheck`、`npm run build`、`npm run test:workspaces`（7/7）、`npm run test:actions`（5/5）、`npm run test:control`（33/33）。
- 已知限制：任务账本目前在主进程内存中，重启后不保留；持久化任务事件属于后续 scoped schema 任务。
- 回滚：`git revert 318e797`。
