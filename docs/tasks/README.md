# 任务看板

依据：[工程实施蓝图](../智能Web管理终端-工程实施蓝图.md) · [实施进度与待办](../实施进度与待办.md)

任务卡是可分发、可认领、可回退的最小开发单元；蓝图是最高架构约束，不能被任务卡替代。一个任务只解决一个可纵向验收的能力切片。

## 当前任务

| ID | 状态 | 主题 | 蓝图映射 | 认领者 | 验收 |
| --- | --- | --- | --- | --- | --- |
| [T-000](T-000-workspace-core.md) | 已通过 | 工作区 Core：隔离、并发、焦点、休眠 | M0 / M2 | 已完成 | [A-000](../acceptance/A-000-workspace-core.md) |
| [T-001](T-001-action-task-contract.md) | 已通过 | 统一身份、动作与任务契约 | M0 §3.1 / §3.2 | Codex | [A-001](../acceptance/A-001-action-task-contract.md) |
| [T-002](T-002-persistent-task-journal.md) | 已通过 | 持久任务账本与恢复语义 | M0 §3.2 | Codex | [A-002](../acceptance/A-002-persistent-task-journal.md) |
| [T-003](T-003-content-store-core.md) | 已通过 | ContentStore 内容寻址与分块写入 | M1 §4 | Codex | [A-003](../acceptance/A-003-content-store-core.md) |
| [T-004](T-004-body-capture-to-content-store.md) | 已通过 | 响应正文写入 ContentStore | M1 §4 | Codex | [A-004](../acceptance/A-004-body-capture-to-content-store.md) |
| [T-005](T-005-capture-gap-evidence.md) | 待验收 | 采集缺口、保留策略与证据查询 | M1 §4 | Codex | [A-005](../acceptance/A-005-capture-gap-evidence.md) |
| [T-006](T-006-targeted-rule-actions.md) | 待验收 | 规则动作的显式工作区目标 | M0 §3.1 / M2 §5 | Codex | [A-006](../acceptance/A-006-targeted-rule-actions.md) |
| [T-007](T-007-task-journal-diagnostics.md) | 待验收 | 任务日志诊断与恢复可见性 | M0 §3.2 | Codex | [A-007](../acceptance/A-007-task-journal-diagnostics.md) |
| [T-008](T-008-content-integrity-api.md) | 待验收 | ContentStore 完整性与范围读取 API | M1 §4 | Codex | [A-008](../acceptance/A-008-content-integrity-api.md) |
| [T-009](T-009-content-observability.md) | 待验收 | 内容存储统计与工作区可视化 | M1 / M2 | Codex | [A-009](../acceptance/A-009-content-observability.md) |
| [T-010](T-010-capture-coverage-probe.md) | 可认领 | 全量采集路径与缺口真值矩阵 | M1 §4.2 | 未认领 | 完成后创建 A-010 |
| [T-011](T-011-scoped-metadata-migration.md) | 可认领 | 工作区元数据归属与范围校验迁移 | M2 §5 / §10.2 | 未认领 | 完成后创建 A-011 |
| [T-012](T-012-streaming-content-service.md) | 可认领 | 流式内容服务第一条纵向链路 | M1 §4 / §10.3 | 未认领 | 完成后创建 A-012 |
| [T-013](T-013-workspace-auth-ledger.md) | 可认领 | 工作区登录证据台账 | M2 §5 | 未认领 | 完成后创建 A-013 |
| [T-014](T-014-extension-observation.md) | 可认领 | 插件能力验证与期望/实际对账 | M2 §5 | 未认领 | 完成后创建 A-014 |

建议认领顺序：T-010 与 T-011 可分别启动；T-012 等两者的接口/迁移稳定后接入；T-013、T-014 依赖 T-011，可彼此独立。T-005～T-009 的独立验收仍需补齐，不能因新任务建卡自动转“已通过”。

## 生命周期与规则

`待细化 → 可认领 → 开发中 → 待验收 → 已通过`；异常状态只有 `阻塞 / 返工 / 取消`。

1. 认领前，任务卡必须有蓝图映射、范围、非目标、验收和依赖；认领时填写 owner、开始时间和基线 commit。
2. 实现者完成后只能改为“待验收”，并记录提交、文件和测试证据；验收由独立人或 Agent 执行。
3. 验收失败转“返工”。每个任务使用可独立回退的提交；回滚用 `git revert <commit>`，不使用 `reset --hard`。
4. 架构或迁移取舍先增加 ADR；任务完成与验收通过后同步更新《实施进度与待办》。
5. 小修复可挂在父任务的 checklist 中；涉及数据模型、跨进程协议、用户流程或验收门槛时必须单列任务卡。

新任务从 [任务模板](TEMPLATE.md) 创建。验收任务放在 `docs/acceptance/`，与实现任务分离。

本轮 T-005～T-009 因共享 ActionRegistry/Controller 使用了集成提交 `94958b0`，只能整体回退，未达到第 3 条的“逐任务独立回退”理想状态。验收前需确认是否接受该批次回退粒度；后续任务应先拆接口再分任务提交。
