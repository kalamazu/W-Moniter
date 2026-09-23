# ADR-0005：本地二进制内容流与大响应代理直写

状态：接受（T-012，2026-09-23）

## 决定

内容写入服务独立于 Electron 主进程运行，由 bundled Node 启动，监听随机 `127.0.0.1` 端口，启动时生成 256-bit 随机 bearer token。`PUT /object` 的请求开始表示 begin，请求数据流表示 append，正常 EOF 与长度校验后 finalize，断连/错误表示 abort；不在 JSON/base64 中传正文。服务串行写入 staging，逐块计算 SHA-256，完成后以原有 `chunks/<sha256>` + `manifests/<sha256>.json` 格式原子发布。内容引用只在服务端完整回执之后交给 SQLite；请求记录仍以 CDP 为主键。

有代理且无响应正文规则的大响应（已知 `Content-Length > 1 MiB`）由代理将原始上游字节 tee 到内容服务。代理与服务间的 socket 背压会暂停上游读，浏览器响应仍沿代理透传。CDP 不再对这条路径调用一次性 `Fetch.getResponseBody`。有限长但未知长度的响应目前仍走 CDP 兼容路径；SSE/multipart/grpc 不开启持久写入，防止无限长 staging。小正文可经同一服务写入，但在 CDP 边界仍已完整缓冲。代理不可用时回退旧 ContentStore/CDP 路径，不能声称内存有界。

## 原因与代价

CDP `Fetch.getResponseBody` 把完整正文一次性交给 Electron；仅把 `ContentStore.put(bytes)` 内部分块，无法改变峰值内存。代理已有原始字节流，最小纵向链路是在代理进程对其分流。单写者降低 manifest/块并发冲突，但极慢磁盘会对该响应施加网络背压。失败只保留原请求和可见缺口，不生成 `stored` 引用；staging 崩溃残留和引用/manifest 对账仍需后续独立任务。

## 已知边界

此路径存的是代理收到的原始上游字节；有 `Content-Encoding` 时 hash 不等于页面解码后字节。代理改写正文、上传、下载、WS/SSE 不在本任务的“完整覆盖”声明内。服务 token 只用于子进程间通信，不暴露给控制面。Windows 包把 `content/` 作为 `extraResources`，与 `storage/`、`proxy/` 一样位于 asar 外。
