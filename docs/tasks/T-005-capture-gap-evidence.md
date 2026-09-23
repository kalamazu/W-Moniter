# T-005：采集缺口、保留策略与证据查询

状态：已通过
返工认领：Codex · 2026-09-23 · 基线 `5c7bb9b`
认领：Codex · 2026-09-23
基线 commit：`80a3cce`
蓝图映射：M1 §4
优先级：P0
依赖：T-004

## 目标

把“没采到”变成可查询证据：记录缺口原因、采集阶段、大小估算、保留/删除决定；策略和 UI 预览限制不得影响原始采集结论。

## 验收

- 每个未获得正文的请求可区分：浏览器不可得、超时、存储失败、保留删除。
- API 可按请求读取正文证据或 gap 证据；统计可汇总缺口原因。
- 保留清理产生可校验的追加式删除证据；本机所有者整体替换文件的威胁边界见 ADR-0002。
- A-005 覆盖统计与失败/清理路径。

## 实现交付

初始实现：`94958b0`（T-005～T-009 共用集成提交）。返工实现：`2f0d099`（可独立回退）。`CaptureEvidenceLedger` 按请求记录采集成功、失败及显式清理原因；`content.revoke` 对账引用后删除 manifest 和无引用块，更新请求状态。UI/HTTP/MCP 可查请求证据及汇总；休眠工作区仍可查账本事件。

自动验证：`npm run test:actions` 13/13、`npm run test:content` 7/7、`npm run test:retention-recovery` 6/6、`npm run test:smoke` 129/129、`typecheck`、`build`。返工实现把 `retention_intent` 收敛为 committed/cancelled/failed 终态：启动时对象仍在则取消意图，对象已删则幂等更新全部旧引用与证据；内容损坏则留失败证据，不静默猜测。超时与内容写失败通过仅开发验收故障开关进入真实采集回调。2026-09-24 复验通过，见 [A-005](../acceptance/A-005-capture-gap-evidence.md)。自动 TTL/配额清理不在本任务，见 ADR-0002。
