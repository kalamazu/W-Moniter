# A-006：显式目标规则动作独立验收

状态：待独立验收 · 实现 `94958b0` · 对应 [T-006](../tasks/T-006-targeted-rule-actions.md)

自动证据：`npm run test:actions` 13/13，覆盖 UI/HTTP/MCP 同幂等任务、两工作区不串写、缺失/过期 TargetRef 拒绝；`npm run test:smoke` 129/129 与 `npm run test:drill` 39/39 覆盖旧场景升级后的规则调用。

独立复核：切换焦点时在规则面板保存后台工作区规则，核对磁盘规则集、面板显示和目标浏览器实际生效一致；检查规则内容无效时是否需要“拒绝落盘”而非返回 invalid。
