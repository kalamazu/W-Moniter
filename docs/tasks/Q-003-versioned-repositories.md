# Q-003：T025～T029 正式 Repository 与迁移

状态：开发中 · 优先级：P0 · 认领：Codex（2026-09-25） · 基线：`d0fa446`

目标：用统一的版本仓库替换领域内重复 JSON 读写，提供 schema migration、串行写、备份、校验和损坏隔离。

验收：旧 replay/testing/knowledge/workflow 文件原位升级且数据保留；并发更新不丢失；损坏文件隔离并可诊断。

