# T-000：工作区 Core——隔离、并发、焦点与休眠

状态：已通过  
蓝图映射：M0 §3.1、M2 §5  
优先级：P0  
认领：已完成（补录）  
验收：[A-000](../acceptance/A-000-workspace-core.md)

## 背景与目标

将“工作区”从界面布局概念变为浏览器状态容器：每个工作区必须拥有独立 Profile 和采集历史；切换焦点不能停止其它受管浏览器。

## 已交付范围

- 工作区状态机、持久索引与崩溃恢复标记。
- 新工作区独立 Profile、SQLite、下载、规则、布局和吸附配置；默认工作区兼容旧目录。
- 多 Controller / Chromium 并发运行、焦点切换、单工作区休眠和可配置并发上限。
- UI、IPC、HTTP、MCP 的 list/create/open/suspend 操作。

## 非目标与限制

- 未实现最终 `workspace_id/profile_id/partition` scoped schema；当前过渡方案见 [ADR-0001](../adr/0001-workspace-directory-isolation.md)。
- 未实现登录台账、扩展对账、检查点、TaskService、全量正文或每个动作自带 TargetRef。

## 完成记录

- 实现 commit：`a51bab4 feat: add persistent concurrent workspaces`。
- 实现位置：`src/main/workspace/*`、`src/main/index.ts`、`src/renderer/src/components/WorkspaceBar.tsx`、`control/server.mjs`、`mcp/server.mjs`。
- 验证：`npm run typecheck`、`npm run build`、`npm run test:workspaces`（7/7）、`npm run test:sessions`（9/9）、`npm run test:control`（33/33）。
- 回滚：`git revert a51bab4`。
