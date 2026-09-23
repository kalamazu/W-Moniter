# 采集能力账本：T-010 真值矩阵

日期：2026-09-23。测试入口：`npm run test:capture-paths`、`npm run test:capture-cdp`；代理组合用 `CAPTURE_PROXY=1`，跳过上传单独复测其他路径用 `CAPTURE_SKIP_UPLOAD=1`，Profile H 用 `CAPTURE_PROFILE=H`。探针输出 `CAPTURE_MATRIX` JSON，设 `CAPTURE_REPORT` 可另存完整原始结果。所有样本来自临时受控 origin，不含真实站点资料。

测试内核：Chrome/153.0.8010.50。直连 Profile L、H 均通过探针 3/3；独立 Chrome 的 `Network.getResponseBody` 对 2 MiB 固定响应和 768 KiB 有限分块响应均与 origin hash 一致。代理模式大上传在此环境只到达服务端约 261 KiB，页面未继续执行；跳过上传复测时其余 HTTP 路径可运行，但 WebSocket 握手失败。这些是技术验证结果，不是产品能力达标。

| 场景 | Origin/页面真值 | 当前终端记录 | 结论与下一步 |
| --- | --- | --- | --- |
| 2 MiB 二进制响应 | 页面读满，SHA-256 与 origin 一致 | `stored`，ContentStore hash 一致 | 此规模直连可用；尚未证明 1 GiB 内存有界 |
| 2 MiB 上传 | origin 收满 2 MiB 且 hash 一致 | 请求行在，`req_body` 仅预览/截取；记录的 `body_hash` 是 91 B 响应体 | 上传原文未采集；代理模式还出现转发停滞，优先排查 |
| 768 KiB 未知长度有限响应 | 页面读满 | `stored`，hash 一致；独立 CDP 路径也能取回 | 仅证明会结束的 chunked 流，不代表无界长流 |
| 响应提前截断 | 页面 `Failed to fetch`，只收到 1 KiB/声明 64 KiB | 现标 `incomplete`，不生成完整 hash | 修复了先前误标 `stored`；压缩响应不直接比 `content-length` |
| 页面取消慢响应 | 页面 `AbortError` | 请求仍有记录，正文为 `none`/后续失败状态，不标完整 | 后续需给取消单独事件和已收片段引用 |
| CacheStorage 与 Service Worker | cache.add 命中网络，cache.match 本地成功；SW ready 且 fetch 200 | 网络请求有正文；纯 cache.match 不产生网络请求 | 缓存命中不等于网络正文；需单独来源与覆盖语义 |
| SSE | 页面收到 `hello` | 请求可见，正文未存；本轮见 `error` | 不可用常规 Fetch.getResponseBody 把长流当完整响应；需流片段协议 |
| WebSocket | 直连 origin 收到 `matrix-message` 并回声 | 通过帧表可见，不在普通请求列表中 | 帧原文仍受旧 4 KiB 预览限制；代理模式握手失败 |
| 下载 | origin 发出 4 KiB，页面触发下载 | 当前请求列表未见这条下载 | 要接下载来源与文件 hash/引用，不可冒称覆盖 |

峰值：本轮 2 MiB 样本的 Electron 主进程 Windows `PeakWorkingSet64` 约 139–151 MiB；这是进程级峰值观察，不能证明正文大小增加时内存不线性增长。T-012 应以 100 MiB/1 GiB 梯度重新测量。

证据优先级：origin 收发字节与浏览器页面消费为外部真值；终端库/ContentStore 只说明它实际采到了什么。WS 握手由 origin 的 upgrade 日志计数，不把 HTTP `requests` 数为 0 误判成没有 WS。未验证的 CDP stream 变体、代理上传修复、下载和长流补齐继续列为缺口，不能以本矩阵替代 M1 全量验收。
