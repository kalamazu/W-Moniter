# A-014：插件能力与工作区对账独立验收

状态：待独立验收 · 实现 `5ba1686` · 对应 [T-014](../tasks/T-014-extension-observation.md)

自动证据：Chrome for Testing 154 下 `npm run test:extension-probe` 3/3、`npm run test:extensions` 9/9；A/B 使用不同受控扩展及版本/权限，Profile/CDP 观察与期望漂移不串区；重启保留并重新观察；UI/HTTP/MCP 同源；Profile 部分扫描时缺席为 `unknown`。v10→v11 迁移与备份在 `test:scoped-migration` 16/16 覆盖。`typecheck`、`build`、登录 11/11、存储 54/54、工作区 7/7、动作 13/13 通过。

独立复核重点：

1. 在正式版 Chrome 和 Chrome for Testing 分别核对能力矩阵；不能把开发 fixture 命令行注入当作生产安装能力。
2. 审查 Profile 尚未落盘、service worker 休眠、扩展禁用/删除、manifest/权限变更时，`unknown` 与 `drift` 不误判；检查上次观察时间及 stale 投影。
3. 核查 HTTP/MCP/界面显式工作区目标、非法目标拒绝、数据库 scope 守卫；确认期望写入不会触发安装或权限变化。
4. 核查 v10→v11 备份可恢复、重复迁移幂等以及旧资料不被迁移时覆盖。

未通过的门槛：受控扩展实际启停写操作尚未做可行性验证；可信 `chrome.management` 报告未接入产品。此任务交付的是安全的部分观察与期望对账，不得标成“完整插件控制”或“所有插件的完整清单”。是否把真实启停验收作为本任务返工，还是另立授权控制任务，由独立验收者决定。
