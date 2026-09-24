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
| [T-005](T-005-capture-gap-evidence.md) | 已通过 | 采集缺口、保留策略与证据查询 | M1 §4 | Codex | [A-005](../acceptance/A-005-capture-gap-evidence.md) |
| [T-006](T-006-targeted-rule-actions.md) | 已通过 | 规则动作的显式工作区目标 | M0 §3.1 / M2 §5 | Codex | [A-006](../acceptance/A-006-targeted-rule-actions.md) |
| [T-007](T-007-task-journal-diagnostics.md) | 已通过 | 任务日志诊断与恢复可见性 | M0 §3.2 | Codex | [A-007](../acceptance/A-007-task-journal-diagnostics.md) |
| [T-008](T-008-content-integrity-api.md) | 已通过 | ContentStore 完整性与范围读取 API | M1 §4 | Codex | [A-008](../acceptance/A-008-content-integrity-api.md) |
| [T-009](T-009-content-observability.md) | 已通过 | 内容存储统计与工作区可视化 | M1 / M2 | Codex | [A-009](../acceptance/A-009-content-observability.md) |
| [T-010](T-010-capture-coverage-probe.md) | 已通过 | 全量采集路径与缺口真值矩阵 | M1 §4.2 | Codex | [A-010](../acceptance/A-010-capture-coverage-probe.md) |
| [T-011](T-011-scoped-metadata-migration.md) | 已通过 | 工作区元数据归属与范围校验迁移 | M2 §5 / §10.2 | Codex | [A-011](../acceptance/A-011-scoped-metadata-migration.md) |
| [T-012](T-012-streaming-content-service.md) | 已通过 | 流式内容服务第一条纵向链路 | M1 §4 / §10.3 | Codex | [A-012](../acceptance/A-012-streaming-content-service.md) |
| [T-013](T-013-workspace-auth-ledger.md) | 已通过 | 工作区登录证据台账 | M2 §5 | Codex | [A-013](../acceptance/A-013-workspace-auth-ledger.md) |
| [T-014](T-014-extension-observation.md) | 已通过 | 插件能力验证与期望/实际对账 | M2 §5 | Codex | [A-014](../acceptance/A-014-extension-observation.md) |
| [T-015](T-015-workbench-ui.md) | 已通过 | 工作台信息架构与响应式窗口控制 | M2 §5 / M5 §11 | Codex | [A-015](../acceptance/A-015-workbench-ui.md) |
| [T-016](T-016-upload-content-stream.md) | 已通过 | 上传请求原文流式采集 | M1 §4 | Codex | [A-016](../acceptance/A-016-upload-content-stream.md) |
| [T-017](T-017-realtime-content-streams.md) | 已通过 | WebSocket 与 SSE 原文内容链路 | M1 §4 / M9 基础 | Codex | [A-017](../acceptance/A-017-realtime-content-streams.md) |
| [T-018](T-018-download-artifact-capture.md) | 已通过 | 下载文件采集与证据化 | M1 §4 / M4 | Codex | [A-018](../acceptance/A-018-download-artifact-capture.md) |
| [T-019](T-019-cache-service-worker-coverage.md) | 已通过 | 缓存与 Service Worker 响应覆盖 | M1 §4.2 | Codex | [A-019](../acceptance/A-019-cache-service-worker-coverage.md) |
| [T-020](T-020-workspace-checkpoint-restore.md) | 已通过 | 工作区检查点与冷恢复 | M2 §5 | Codex | [A-020](../acceptance/A-020-workspace-checkpoint-restore.md) |
| [T-021](T-021-content-governance-evidence-workbench.md) | 已通过 | 内容治理与统一证据工作台 | M1 收口 | Codex | [A-021](../acceptance/A-021-content-governance-evidence-workbench.md) |
| [T-022](T-022-workspace-cockpit-state-history.md) | 已通过 | 工作区驾驶舱与浏览器状态历史 | M2 收口 | Codex | [A-022](../acceptance/A-022-workspace-cockpit-state-history.md) |
| [T-023](T-023-environment-proxy-center.md) | 已通过 | 代理与环境配置中心 | M3 | Codex | [A-023](../acceptance/A-023-environment-proxy-center.md) |
| [T-024](T-024-site-storage-control-center.md) | 已通过 | Cookie 与站点存储控制中心 | M4 | Codex | [A-024](../acceptance/A-024-site-storage-control-center.md) |
| [T-025](T-025-browser-control-center.md) | 已通过 | 浏览器完全控制中心 | M4 | Codex | [A-025](../acceptance/A-025-browser-control-center.md) |
| [T-026](T-026-request-replay-workbench.md) | 已通过 | 请求模板与单次重放工作台 | M5 | Codex | [A-026](../acceptance/A-026-request-replay-workbench.md) |
| [T-027](T-027-batch-testing-script-runner.md) | 已通过 | 批量测试、断言与脚本运行器 | M6 | Codex | [A-027](../acceptance/A-027-batch-testing-script-runner.md) |
| [T-028](T-028-site-resource-knowledge-base.md) | 待验收 | 站点档案与资源知识库 | M7 | Codex | [A-028](../acceptance/A-028-site-resource-knowledge-base.md) |
| [T-029](T-029-workflow-agent-runtime.md) | 待验收 | 持久工作流与 Agent 协作运行时 | M8 | Codex | [A-029](../acceptance/A-029-workflow-agent-runtime.md) |
| [T-030](T-030-intelligence-protocol-experiments.md) | 可认领 | 证据化智能分析与协议实验 | M9 | 未认领 | 待创建 |

2026-09-24 已完成 T-006～T-015 独立验收；T-014 经 `6905516` 返工和真实启停复验后也已通过。T-010 通过的是“缺口真值矩阵”，不代表 M1 全量采集门槛已达成。

2026-09-24 T-016～T-020 已实现并复验：前四项收口上传、实时流、下载和缓存/SW 正文链路，T-020 建立 suspended 独立工作区的可校验检查点与冷恢复。

2026-09-25 T-021～T-024 已实现并复验：内容治理与证据查看、工作区驾驶舱/事件历史、版本化代理环境、Cookie/站点存储工作台均进入统一 Action。通用状态包对 IDB/Cache/SW 只承诺结构清单，不伪称可无损重建，边界见 ADR-0010。

2026-09-25 T-025～T-027 已实现并通过验收：稳定 Browser/Tab/Frame 对象与代次、版本化模板/双执行器、安全 cURL/HAR 导入，以及批量断言/变量/脚本/报告。执行边界见 ADR-0011。

2026-09-25 T-028～T-029 已完成实现并交付验收：资源版本/站点档案/中文与源码检索/人工修订，以及冻结版本 DAG、等待、变量、检查点、fencing 接管和安全恢复。边界见 ADR-0012。

下一批 T-021～T-030 采用较大的纵向任务粒度以加速工程：每张卡同时包含领域服务、持久化、UI、Agent 动作和验收，不再把同一能力按技术层拆成多张小卡。建议依次推进 T-021/022 基础收口，T-023～025 控制面，T-026/027 执行与测试，再进入 T-028～030 资料、工作流和智能能力；依赖满足时允许并行认领。

## 生命周期与规则

`待细化 → 可认领 → 开发中 → 待验收 → 已通过`；异常状态只有 `阻塞 / 返工 / 取消`。

1. 认领前，任务卡必须有蓝图映射、范围、非目标、验收和依赖；认领时填写 owner、开始时间和基线 commit。
2. 实现者完成后只能改为“待验收”，并记录提交、文件和测试证据；验收由独立人或 Agent 执行。
3. 验收失败转“返工”。每个任务使用可独立回退的提交；回滚用 `git revert <commit>`，不使用 `reset --hard`。
4. 架构或迁移取舍先增加 ADR；任务完成与验收通过后同步更新《实施进度与待办》。
5. 小修复可挂在父任务的 checklist 中；涉及数据模型、跨进程协议、用户流程或验收门槛时必须单列任务卡。

新任务从 [任务模板](TEMPLATE.md) 创建。验收任务放在 `docs/acceptance/`，与实现任务分离。

本轮 T-005～T-009 因共享 ActionRegistry/Controller 使用了集成提交 `94958b0`，只能整体回退，未达到第 3 条的“逐任务独立回退”理想状态。验收前需确认是否接受该批次回退粒度；后续任务应先拆接口再分任务提交。
