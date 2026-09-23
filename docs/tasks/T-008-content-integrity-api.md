# T-008：ContentStore 完整性与范围读取 API

状态：已通过
认领：Codex · 2026-09-23
基线 commit：`80a3cce`
蓝图映射：M1 §4
优先级：P1
依赖：T-003

## 目标与验收

提供按 ContentRef 的范围读取与完整性校验动作；验证分块、重复写入、范围读取和损坏块均有确定结果，不把原始磁盘路径暴露给 UI 或 Agent。

## 实现交付

实现提交：`94958b0`（共用集成提交）。`content.verify/readRange` 支持完整 hash 与逐块校验、1 MiB 范围上限；范围读取仅缓冲命中的字节，输出 base64，不回传磁盘路径。

自动验证：`npm run test:content` 7/7。独立验收见 [A-008](../acceptance/A-008-content-integrity-api.md)。
