# A-026：请求模板与单次重放工作台验收

状态：已通过 · 验收 2026-09-25 · 实现 `f923b34`、`5df97a0` · 对应 [T-026](../tasks/T-026-request-replay-workbench.md)

## 证据与结论

- `test:execution-centers` T-026 3/3：从真实采集请求派生 v1，编辑保存 v2，原版本不变；独立 Node HTTP 与浏览器 fetch 两种模式均由受控 origin 返回 200。
- 两种模式的响应正文均进入 ContentStore 并以 hash 绑定 run；状态差异、实际 URL/Header、运行时间与历史持久化可追溯。
- 同名重复 Header、执行器生成 Content-Length、重定向上限、64 MiB 响应上限、超时/取消和 Cookie omit/browser/explicit 边界进入执行代码。
- cURL/HAR 只解析不执行 shell；8 MiB/1000 entry 有界，`@file` 被拒；非只读方法缺少 `confirmWrite=true` 时任务失败。

结论：M5 首版单次重放纵向链路通过。浏览器和独立模式能力差异明确；逐 part multipart 编辑、SecretRef 刷新签名和 TLS 指纹复制不在本次通过结论内。

