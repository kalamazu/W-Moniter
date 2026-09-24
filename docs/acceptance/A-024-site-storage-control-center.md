# A-024：Cookie 与站点存储控制中心验收

状态：已通过 · 复验 2026-09-25 · 实现 `d1eab06`、`7ea404a` · 对应 [T-024](../tasks/T-024-site-storage-control-center.md)

## 证据与结论

- `test:core-centers` 7/7：状态包导出、Cookie/localStorage 选择性恢复、写后扫描，并由受控页面读回原值。
- `test:sitedata` 30/30：Cookie 真实随请求携带、跨站/分区语义、local/session、IDB、Cache、SW、快照 diff、HTTP/MCP/UI 同源。
- UI 可新增/覆盖/删除 Cookie，新增/编辑/删除 local/sessionStorage，浏览和删除 IDB/Cache/SW，导出及选择性恢复状态包。
- 恢复后相关 origin 登录证据标为 stale；跨工作区必须携带显式 TargetRef。

结论：按 ADR-0010 通过。IDB/Cache/SW 的通用状态包只包含结构清单并明确警告，不伪称能无损重建任意 JS 值、Response 流或 worker 执行态。
