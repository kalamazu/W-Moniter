# ADR-0010：治理账本、网络环境版本与站点状态包边界

状态：已接受（2026-09-25）

## 决策

- 正文原字节仍只在 ContentStore；`governance.json` 只保存配额、宽限期、pin 和最近 1000 条治理审计。GC 先查 pin/宽限期，再走既有 retention intent 与 SQLite 引用对账，不直接删块。
- 工作区状态变化追加到独立 JSONL 事件流；`index.json` 是当前投影，驾驶舱同时展示投影、历史与检查点。
- 网络环境按工作区保存不可变版本；应用后标记待重启。单上游编译为 Chromium `--proxy-server`，多路由编译为 PAC。规则没有匹配时只允许配置中显式的 `*` 终态，不做隐式直连。
- 普通配置只允许 `secret://` 引用，不保存用户名或密码；引用无法解析时浏览器启动 fail-closed。
- 站点状态包无损恢复 Cookie、localStorage 和当前页面上下文的 sessionStorage，并写后读回、把登录证据标 stale。IDB、CacheStorage、Service Worker 只导出结构清单：任意 JS 值、流式 Response 和执行中 worker 无法靠通用 CDP 结构无损重建，系统必须提示而不能伪称恢复。

## 后果

治理、环境和恢复动作都能由 UI/HTTP/MCP 共用的 ActionRegistry 调用。定时 GC、SecretRef 的本机凭据提供器，以及站点专用 IDB/Cache 导入适配器应作为后续安全任务增加，不能在通用恢复里静默猜测。
