# A-009：内容与采集可观测性独立验收

状态：已通过 · 独立验收 2026-09-24 · 实现 `94958b0` · 验收加固 `516364a` · 对应 [T-009](../tasks/T-009-content-observability.md)

自动证据：`npm run test:content` 7/7，覆盖一工作区 2 MiB 内容与另一空工作区的隔离，以及 UI 动作/HTTP/MCP 汇总一致；`npm run test:workspaces` 7/7。

独立复核：在实际窗口确认正文对象、KiB、缺口和最近错误布局可读；按“刷新统计”后数值与 API 一致，休眠工作区仍可显示摘要。统计为当前 manifest 引用字节，不是物理磁盘占用。

## 独立验收结论

通过。`test:content` 9/9 验证 UI/HTTP/MCP 同源、正文/缺口/字节摘要与 A/B 工作区隔离；`test:workspaces` 7/7。界面在“证据”区按需展开，统计口径仍是 manifest 逻辑引用量。
