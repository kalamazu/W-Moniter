# A-006：显式目标规则动作独立验收

状态：已通过 · 独立验收 2026-09-24 · 实现 `94958b0` · 验收加固 `516364a` · 对应 [T-006](../tasks/T-006-targeted-rule-actions.md)

自动证据：`npm run test:actions` 13/13，覆盖 UI/HTTP/MCP 同幂等任务、两工作区不串写、缺失/过期 TargetRef 拒绝；`npm run test:smoke` 129/129 与 `npm run test:drill` 39/39 覆盖旧场景升级后的规则调用。

独立复核：切换焦点时在规则面板保存后台工作区规则，核对磁盘规则集、面板显示和目标浏览器实际生效一致；检查规则内容无效时是否需要“拒绝落盘”而非返回 invalid。

## 独立验收结论

通过。`test:actions` 13/13 验证 UI/HTTP/MCP 共用动作、幂等、过期/缺失目标拒绝及工作区隔离；`test:rules:e2e` 22/22、`test:smoke` 129/129、`test:drill` 39/39 无回归。无效规则落盘策略作为后续产品策略，不阻断本任务的显式目标契约。
