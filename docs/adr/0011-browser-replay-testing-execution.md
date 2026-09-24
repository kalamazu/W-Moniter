# ADR-0011：浏览器对象代次、双重放执行器与可信本地测试脚本

状态：已接受（2026-09-25）
关联：T-025、T-026、T-027

## 决策

1. Browser/Tab/Frame 使用 CDP `targetId`、`sessionId` 和递增的 document generation 标识。导航后旧代次动作必须失败，不能偷偷落到当前焦点页。
2. 浏览器动作统一进入 Action/Task，显式携带 workspace/browser/tab TargetRef；每次动作生成 actionId、开始/完成时间、代次、结果或错误并进入时间线。
3. 请求模板采用追加版本，不覆盖原始采集记录。浏览器执行器保留浏览器 Cookie/CORS/SW 语义，独立执行器保留可控 Header、重定向和超时语义；两者不宣称 TLS/HTTP 指纹等价。
4. 非只读重放必须显式 `confirmWrite=true`。cURL/HAR 只作为数据解析，绝不启动 shell；`@file` 隐式文件读取拒绝，输入限制 8 MiB/1000 entries。
5. 批量报告将 case 与 attempt 分开计数，保留 cancelled/notStarted/unknown；每个 case 复制变量对象。首版脚本是用户信任的本地代码，使用无 Node 全局的 `vm` context 和 100 ms 同步超时，但不把它描述为恶意代码安全沙箱。

## 理由与证据

- 页面刷新后 target 仍可能不变，单靠 targetId 会让旧元素/旧意图误作用到新文档，因此代次是安全边界而非 UI 字段。
- 浏览器 fetch 与 Node HTTP 的身份、CORS、Cookie、代理和协议行为不同，合成一个“完全等价”执行器会制造错误证据。
- 业务写请求的超时不能证明服务端未收到，批量系统必须保留 attempt 和未知效果语义，不能只给成功/失败总数。
- `test:execution-centers` 使用真实 Chromium 与独立受控 origin 验证对象代次、两种执行器、导入边界及 1/10/100 次运行。

## 已知边界与重新评估条件

- Node `vm` 只做可靠性隔离；第三方不可信脚本、内存硬限制和 OS 沙箱进入发布前必须另做安全评审。
- 当前持久化是工作区 JSON 原子替换，适合首版规模；模板/run 数量或并发写入显著增长时迁到蓝图规划的 repository/runner 进程。
- 浏览器模式受页面 CORS、CSP、SW 和可用 Runtime 约束，失败必须如实显示；不得自动降级到独立模式。
- multipart 首版可保存和重放已捕获的原始/二进制正文；可视化逐 part 编辑、ContentRef 文件拼装和秘密提供器仍需后续安全任务。

