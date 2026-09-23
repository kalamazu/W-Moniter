# ADR-0007：扩展状态采用分级观察，不把 Profile 快照当作完整清单

状态：接受（T-014，2026-09-23）

## 决定

每个工作区的期望扩展、实际观察和扫描覆盖度分别落在 v11 的 `extension_desired`、`extension_observed`、`extension_scans`，以 `workspace_id/profile_id` 为所有权边界。期望项仅是元数据，不执行安装、卸载或启停。对账输出 `aligned`、`drift`、`unknown`、`observed_only` 及可读原因，保留最后观察时间。旧观察不在最新扫描中出现时归为 `unknown`，不能按已安装或已卸载下结论。

当前生产观察源是 Chrome Profile `Secure Preferences` 只读快照和运行中的 CDP extension target。两者均非完整扩展清单：Profile 可能尚未落盘、可能包含停用项，service worker target 可以休眠。因此 `complete=false`，期望项缺席只能是 `unknown`。目标运行时与 Profile 观察都不得修改扩展状态。不可读取时保留错误原因而非报告“空清单”。

受控 Manifest V3 fixture 在 Chrome for Testing 154 验证了 `chrome.management.getAll()` 可枚举、版本/权限可读、扩展 storage 跨重启保留。正式版 Chrome 153 不支持以 `--load-extension` 注入该受控 fixture；开发探针仅在未打包应用中显式设置 fixture 目录。官方约束见 [Chrome 扩展新闻](https://developer.chrome.com/blog/extension-news-june-2025)和 [Chromium Extensions 公告](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY)。`chrome.management` 报告尚未接入生产可信桥，因此不得把探针中的完整枚举能力写成当前产品能力。

## 安全与后续门槛

所有入口经同一 ActionRegistry，必须携带明确工作区目标；工作区数据库的 scope 守卫拒绝跨区调用。UI 仅显示摘要，不暴露扩展私有存储。扩展安装源、权限变更、启停、辅助扩展和打包策略，须另立任务设计明确授权与可回滚行为；不得利用测试开关偷渡到正式版。
