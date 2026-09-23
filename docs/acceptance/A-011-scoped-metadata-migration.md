# A-011：工作区元数据迁移独立验收

状态：待独立验收 · 实现 `faba1d7` · 对应 [T-011](../tasks/T-011-scoped-metadata-migration.md)

自动证据：合成 v8→v9、幂等重开、范围错误、旧行/正文引用、外键、备份恢复 `npm run test:scoped-migration` 12/12；存储协议 54/54，双工作区 7/7，站点资料 30/30，控制面 33/33；类型检查和构建通过。

独立复核：用真实旧库副本确认 WAL 中已提交行进入备份；模拟事务中断确认生产入口不开放写入并按备份恢复；验证 A/B 对相同 origin 和 Cookie key 互不串读；检查 `profile_id=primary` 不会被 L/H 配置切换误改；确认 `legacy_unknown` 不是“已登录”证据。复核前不得标“已通过”。
