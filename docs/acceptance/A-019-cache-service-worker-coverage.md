# A-019：缓存与 Service Worker 响应覆盖验收

状态：已通过 · 独立复验 2026-09-24 · 实现 `bfe7cc3` · 对应 [T-019](../tasks/T-019-cache-service-worker-coverage.md)

## 证据与结论

- 非代理 `npm run test:capture-paths` 3/3：force-cache 第二次命中只产生一次 origin 请求，记录来源为 `disk_cache` 且正文 hash/size 完整。
- Service Worker fixture 先访问 origin、再构造响应；页面外层记录来源为 `service_worker`，origin 仍有独立真值，正文 hash/size 与 ContentStore 一致。
- Fetch 对 SW 外层返回空正文时，采集器在 `Network.loadingFinished` 后用 `Network.getResponseBody` 获取最终缓冲，避免把可得正文误记为 empty。

结论：通过。opaque 等浏览器明确不交付的正文继续标 gap，不用内层网络响应冒充经 SW 变换后的外层正文。

