# A-012：流式内容服务独立验收

状态：已通过 · 独立验收 2026-09-24 · 实现 `b292e95` · 验收加固 `516364a` · 对应 [T-012](../tasks/T-012-streaming-content-service.md)

自动证据：`test:stream-content` 100 MiB 与 1 GiB hash/manifest/块校验，错误长度、断连不发布 manifest，随机本地端点鉴权；2 ms/块慢写模拟观测到约 25 s 背压。`test:stream-browser` 100 MiB、1 GiB 均由真实 Chrome 页面完整消费，源站 hash 与 SQLite 正文引用一致，Electron 主进程峰值约 112–119 MiB。`test:proxy` 24/24、`test:content` 7/7。`dist/win-unpacked/resources/content/server.mjs` 搭配包内 `node.exe` 完成 100 MiB 最小读写闭环。

独立复核：重复大响应以排除启动/后台任务噪声；在代理禁用、服务崩溃、上游早断、慢盘时核对请求不假标 `stored`，页面不永久卡住；确认 gzip 等压缩响应的 hash 语义为代理原始字节，不误称页面解码正文；排除本次 portable 输出文件锁后复核完整应用包启动与内容读取。未复核前不得标“已通过”。

## 独立验收结论

通过。内容服务分别完成 100 MiB/1 GiB 哈希、分块、错误长度、中断不发布；2 ms/块慢写观测到背压。真实 Chrome 100 MiB/1 GiB 均 2/2，主进程峰值约 112–119 MiB。重新打包后完整 `ChromiumMonitor.exe` 再跑 100 MiB 2/2，峰值 112,488,448 字节；包内 Node/服务路径也通过。此结论只覆盖已声明的代理已知长度响应纵向链路。
