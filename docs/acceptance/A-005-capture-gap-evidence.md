# A-005：采集缺口、保留与证据独立验收

状态：待独立复验 · 初始复核 2026-09-23 · 返工实现 `2f0d099` · 对应 [T-005](../tasks/T-005-capture-gap-evidence.md)

自动证据：`npm run test:actions` 13/13（模拟超时缺口、请求级证据、篡改检测）；`npm run test:content` 7/7（2 MiB 正文、显式删除、原因、缺口汇总、休眠后查询）。`npm run test:smoke` 129/129 验证旧资源导出仍可读取 ContentStore。

独立复跑（2026-09-23）：`npm run build` 通过；`npm run test:actions` 13/13、`npm run test:content` 7/7、`npm run test:smoke` 129/129 通过。现有用例证明正常大正文、显式清理、离线证据查询、哈希链篡改检测和模拟 timeout 账本行为，但不足以覆盖本验收的故障门槛。

验收失败项：

1. `Controller.revokeContent()` 写入 `retention_intent` 后，依次删除 ContentStore、更新 SQLite、追加 `retained_deleted`。复核没有找到启动恢复或对账 `retention_intent` 的逻辑：若在删除后、SQLite 标记前中断，会留下“意图存在但正文已不存在、请求仍引用正文”的不一致状态；若在意图后、删除前中断，也没有明确的重试/取消投影。意图记录可审计，但单独不足以恢复。
2. 自动测试只直接向 `CaptureEvidenceLedger` 写入模拟 `timeout`；未强制真实 CDP `Network.getResponseBody` 超时，也未通过故障注入制造 ContentStore/流式内容盘写失败。因此“请求 body 状态、SQLite、证据链三者一致”的关键失败路径没有独立证据。
3. 未覆盖多个请求共享同一 hash 后的清理中断与恢复，无法确认全部引用在重启后可正确投影。

返工实现复跑（2026-09-24）：`typecheck`、`build`、`test:actions` 13/13、`test:content` 7/7、`test:smoke` 129/129 通过；新增 `test:retention-recovery` 6/6 覆盖共享 hash 在“删除后/数据库标记前”中断并重启收敛、意图后/删除前中断取消、超时和内容写失败的采集路径。实现将每个意图收敛到 `retention_committed`、`retention_cancelled` 或 `retention_recovery_failed`，重复启动幂等；生产环境不启用验收故障开关。

独立复验仍需确认：恢复日志/摘要对用户和 Agent 可见且不将损坏对象误报为已删除；在实际异常退出（非受控 throw）下复现两个中断点；核对恢复动作不会跨工作区操作。哈希链不是本机所有者不可篡改存储，见 [ADR-0002](../adr/0002-content-evidence-and-retention.md)。复验通过前不得标“已通过”。
