# T-016：上传请求原文流式采集

状态：已通过
蓝图映射：M1 §4.1/§4.2、§10.3、§13；E03/E07
优先级：P0
认领：Codex（2026-09-24）
基线 commit：`a08c6c6`
验收：A-016（完成实现后创建）

## 背景与目标

当前大响应已有流式 ContentStore 链路，但代理大上传会停滞，CDP 请求体又存在截断与表示差异。本任务要让已支持的 HTTP/HTTPS 上传在不先缓冲整体的前提下写入 ContentStore，并把完整、截断、未可见与表示方式如实关联到请求。

## 范围

- 要实现：代理请求体 tee 到 content 服务；支持已知/未知长度、multipart、二进制和大文本；记录 hash、字节数、representation、来源与 completeness；详情/UI/HTTP/MCP 可按范围读取。
- 要修改的边界：`proxy/server.mjs`、代理客户端、content 客户端、请求引用元数据与证据投影；网络转发与写盘失败必须分开表达。
- 非目标：不在本卡解决 WS/SSE、下载或缓存/SW 响应；不把 multipart 解析结果替代线上原始字节。

## 依赖与风险

- 前置任务：T-010、T-012。
- 数据/兼容性/安全风险：凭据和文件上传可能含秘密；证据摘要不得内联正文；慢盘不能无界占用主进程内存。
- 需要 ADR 的取舍：写盘失败时是继续转发还是 fail-closed，必须有明确策略及用户可见结果。

## 验收标准

- 用户或 Agent 流程：发送 1 KiB、100 MiB 及 1 GiB 上传，origin 收到的字节/hash 与内容库一致；详情能看到完整性与安全预览。
- 自动化测试：覆盖已知长度、chunked、multipart、二进制、客户端中断、慢读和磁盘慢写；记录主进程峰值内存且 1 GiB 不随正文线性增长。
- 失败与边界行为：上游未收全、本地写入失败、长度不符或用户取消时不得发布 complete manifest；未可见的浏览器内部上传必须标缺口。

## 完成记录

- 实现 commit：`bfe7cc3`
- 修改文件：`proxy/server.mjs`、`proxy/correlate.*`、`content/server.mjs`、请求引用 schema/投影与采集路径探针。
- 测试命令与结果：代理开启的 `test:capture-paths` 3/3，2 MiB 浏览器上传的 origin/ContentRef hash 与字节一致；`STREAM_TEST_MIB=1024 test:stream-content` 验证 1 GiB 分块、hash、长度不符与中断无 manifest；类型检查和构建通过。
- 已知限制：1 GiB 压测在同一 content 二进制流协议上执行，真实 Chrome 代理路径使用 2 MiB fixture；浏览器内部未交付给代理的上传仍只能标缺口。
- 回滚：`git revert bfe7cc3`
