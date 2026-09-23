# A-008：ContentStore 完整性与范围读取独立验收

状态：已通过 · 独立验收 2026-09-24 · 实现 `94958b0` · 验收加固 `516364a` · 对应 [T-008](../tasks/T-008-content-integrity-api.md)

自动证据：`npm run test:content` 7/7，覆盖 2 MiB 重复块去重、跨块范围读取、UI/HTTP/MCP 字节一致、损坏块检测、删除后不存在。`npm run typecheck` 与 `npm run build` 通过。

独立复核：用不同大小、空内容和近 1 MiB 上限的范围重测；检查多进程同时写入同一工作区的风险（当前仅保证单主进程写入，见 ADR-0002）。

## 独立验收结论

通过。加固后 `test:content` 9/9，新增空范围、精确 1 MiB 上限、超限拒绝和工作区证据区显示；同时验证跨块、去重、损坏块、UI/HTTP/MCP 字节一致且不暴露磁盘路径。单主进程写入约束保持 ADR 边界。
