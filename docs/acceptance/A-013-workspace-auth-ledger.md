# A-013：工作区登录证据独立验收

状态：已通过 · 独立验收 2026-09-24 · 实现 `502a8d3` · 验收加固 `516364a` · 对应 [T-013](../tasks/T-013-workspace-auth-ledger.md)

自动证据：`npm run test:auth-ledger` 11/11；两个真实 Chromium Profile 对同一受控站点分别验证 Alice/Bob；Cookie 仅 suspected、主动验证 verified、服务端过期 logged_out、超时 unknown、重启 stale；跨工作区摘要分离与非法目标拒绝；HTTP/MCP/UI 同源；认证观察表无 Cookie 秘密。v9→v10 迁移及备份在 `test:scoped-migration` 14/14 中覆盖。`typecheck`、`build`、工作区 7/7、控制面 33/33、站点资料 30/30 通过。

独立复核：审查 fixture 之外的真实网站不会被标 verified；Cookie 改写/删除与多个同域账号轮换不误判；恢复后 stale 不被首次 Cookie 对账覆盖；摘要、普通事件与任务日志均不泄露秘密。休眠工作区离线摘要仍是待开发边界，不能当作已完成。未复核前不得标“已通过”。

## 独立验收结论

通过。`test:auth-ledger` 11/11：Cookie 仅 suspected，Alice/Bob 真实 Profile 主动验证后才 verified，并覆盖过期、超时 unknown、重启 stale、跨工作区隔离、非法目标和 UI/HTTP/MCP 同源。数据库、普通事件和任务日志未泄露 Cookie 值。真实站点适配器和休眠工作区离线摘要仍是后续边界。
