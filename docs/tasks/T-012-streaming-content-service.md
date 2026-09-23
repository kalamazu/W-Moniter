# T-012：流式内容服务第一条纵向链路

- 状态：待验收
- 蓝图映射：M1 §4.1、§10.3、§11、§13；E03/E07
- 优先级：P0
- 认领：Codex · 2026-09-23
- 基线 commit：`f7160fb`
- 验收：[A-012](../acceptance/A-012-streaming-content-service.md)

## 背景与目标

现有 ContentStore 虽已分块，但 `put(bytes)` 仍先在 Electron 主进程持有完整正文。建立 begin/append/finalize/abort 的跨进程二进制流通道，让采集、写盘与元数据提交分开，第一步以大响应证明内存有界。

## 范围

- 要实现：`content/server.mjs` 与 `src/main/content/client.ts` 的单写者协议、随机本地端点/token、分块回执与背压、staging→manifest 原子发布；主进程的一个响应采集路径接入该服务，SQLite 仅在完整回执后记可用引用。构建、开发与打包路径均能启动新进程。
- 要修改的边界：ContentStore 保留兼容读/迁移接口，Controller/采集源只传块与引用；`src/main/paths.ts`、构建资源清单和测试脚本接入新 runtime。
- 非目标：本任务不宣称覆盖上传、WS/SSE/下载的全部来源；不删除旧 BLOB；完整的崩溃窗口对账与 GC 作为后续独立任务。

## 依赖与风险

- 前置任务：T-010、T-011，以及 T-003/T-004/T-008 的内容契约。
- 风险：短写、取消、服务中断时不能留下 `complete`；网络放行不应被写盘失败无界阻塞。协议和打包资源需先以独立 ping 验证。
- 取舍：若本地 TCP/pipe 流方案改变，先写 ADR 说明认证、背压、跨平台与打包证据。

## 验收标准

- 用户或 Agent 流程：受控页面下载并消费大响应，终端报告完整 hash、大小与来源；UI/API 可范围读取，原请求记录不变。
- 自动化测试：动态生成至少 100 MiB 与 1 GiB 响应，服务端真值 hash 与 ContentStore hash 一致；记录 Electron 主进程峰值且不随正文线性增长；模拟慢写、取消、连接中断；打包运行最小读写闭环。
- 失败与边界：未 EOF 时状态只能是 receiving/interrupted，不能生成完整 hash；引用提交失败时 manifest 仍可识别为待对账对象。

## 完成记录

- 实现 commit：`b292e95`（本任务独立提交）。
- 修改文件：`content/server.mjs`、`src/main/content/client.ts`、代理/采集/关联边界、包资源清单、100 MiB/1 GiB 受控探针及 [ADR-0005](../adr/0005-local-content-stream.md)。
- 验证：真实 Chrome 100 MiB 与 1 GiB 页面消费、源站 hash/SQLite 引用一致；内容服务直传 100 MiB/1 GiB、慢写/断连/错误长度；代理与原内容回归、类型检查与构建通过。`win-unpacked` 中的内容服务/Node 读写闭环通过；portable 产物构建受文件锁阻塞，完整包启动待独立复核。
- 已知限制：仅代理透传的已知大响应保证不进 Electron 主进程完整缓冲；CDP-only、规则改写、上传、下载和长连接不是本任务的完整覆盖；原始上游字节与页面解码字节的 hash 语义不同。
- 回滚：`git revert <本任务提交>`；保留已写内容和引用的兼容读取，数据回退另行说明。
