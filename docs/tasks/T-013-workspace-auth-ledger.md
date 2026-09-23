# T-013：工作区登录证据台账

- 状态：已通过
- 蓝图映射：M2 §5.1/§5.2、§10.2；E12 的认证纵向切片
- 优先级：P1
- 认领：Codex · 2026-09-23
- 基线 commit：`d2489ec`
- 验收：[A-013](../acceptance/A-013-workspace-auth-ledger.md)

## 背景与目标

“有某站 Cookie”不等于“已登录”。为每个工作区/profile/站点记录被动线索、主动验证结果、账号上下文、证据时间和新鲜度，让人和 Agent 看见登录判断从何而来，并在重启/恢复后降级为待验证。

## 范围

- 要实现：`site_identities`、追加式 `auth_observations` 与只读摘要；受控 fixture 站点提供登录/登出/过期真值；Observer 记录 Cookie/导航线索，主动验证动作只对用户明确指定的工作区与站点执行；工作区首页的登录卡片与 HTTP/MCP 查询保持同一数据口径。
- 要修改的边界：存储 repository、`src/main/auth/*`、ActionRegistry、工作区 UI；秘密 Cookie 值不进入普通日志/证据摘要。
- 非目标：不自动代填真实网站密码，不把 Cookie 存在推断成 verified，不承诺通用站点自动识别账号。

## 依赖与风险

- 前置任务：T-011；可与 T-012 并行开发，但验收须通过 T-011 的范围测试。
- 风险：站点页面和 Cookie 可误导身份判断；被动证据只能给 `suspected/unknown`，主动 fixture 验证才可给 `verified`。恢复后标 stale，不沿用旧成功结论。
- 取舍：真实网站适配器须单独立项，先不扩展 fixture 验收结论到所有站点。

## 验收标准

- 用户或 Agent 流程：A/B 两工作区登录同一 fixture 为不同账号，台账展示各自 verified 身份、来源与时间；登出/过期/恢复后状态变化可见，不能串身份。
- 自动化测试：`scripts/test-auth-ledger.mjs` 覆盖双工作区、Cookie 线索与真实登录验证的区别、stale、跨范围拒绝和 HTTP/MCP/UI 一致。
- 失败与边界：验证超时为 unknown 而非 logged_out；证据缺失显示“未验证”，不暴露 Cookie 秘密值。

## 完成记录

- 实现 commit：`502a8d3`（本任务独立提交）。
- 修改文件：v10 迁移、存储操作、`src/main/auth/*`、动作/控制/MCP、工作区卡片、受控站点与 `scripts/test-auth-ledger.mjs`；见 [ADR-0006](../adr/0006-auth-evidence.md)。
- 验证：双工作区真实浏览器 11/11，迁移 14/14，`typecheck`、`build`、`test:workspaces`、`test:control` 通过。
- 已知限制：只主动验证本地 fixture；真实网站登录需要独立适配器；休眠工作区摘要当前不可读；新表在每工作区独立 SQLite 中，尚未合库。
- 回滚：`git revert <本任务提交>`；已写认证观察数据的迁移/保留方式另记。
