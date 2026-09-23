# T-009：内容存储统计与工作区可视化

状态：已通过
认领：Codex · 2026-09-23
基线 commit：`80a3cce`
蓝图映射：M1 §4、M2 §5
优先级：P1
依赖：T-003、T-004

## 目标与验收

在工作区摘要中展示 ContentStore 的引用数、字节数、缺口数和最后错误；UI、HTTP、MCP 读到同一摘要。验收覆盖两工作区不串统计。

## 实现交付

实现提交：`94958b0`（共用集成提交）。工作区栏显示正文对象、字节、缺口与最近错误；`workspaces.contentStats` 提供统一摘要，UI 有显式刷新按钮，避免轮询持续膨胀任务日志。

自动验证：`npm run test:content` 7/7、`npm run test:workspaces` 7/7。独立验收见 [A-009](../acceptance/A-009-content-observability.md)。
