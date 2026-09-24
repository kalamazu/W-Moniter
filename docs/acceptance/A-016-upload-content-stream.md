# A-016：上传请求原文流式采集验收

状态：已通过 · 独立复验 2026-09-24 · 实现 `bfe7cc3` · 对应 [T-016](../tasks/T-016-upload-content-stream.md)

## 证据与结论

- 真实 Chrome + 代理矩阵 3/3：2 MiB 上传到达 origin 的 2,097,152 字节与 ContentStore `requestBodyHash` 完全一致；SQLite 只保存请求引用与预览。
- `STREAM_TEST_MIB=1024 npm run test:stream-content`：1 GiB 流以 1,024 个 MiB 块完成 hash/manifest 校验；声明长度不符返回失败，客户端中断不发布 manifest。
- 代理请求不再先缓冲整体；上游与内容服务双 pipe 共同施加背压。内容服务改为独立 staging 并发接收，长连接不再阻塞后续上传。
- UI/HTTP/MCP 继续复用已通过 A-008 的 `content.readRange`，请求 ContentRef 使用同一 hash 协议。

结论：通过。内容落盘失败采用 ADR-0009 的 fail-open，业务转发与证据完整性分别表达。

