# A-017：WebSocket 与 SSE 原文内容链路验收

状态：已通过 · 独立复验 2026-09-24 · 实现 `bfe7cc3` · 对应 [T-017](../tasks/T-017-realtime-content-streams.md)

## 证据与结论

- `npm run test:realtime` 48/48：WS 双向方向、顺序和服务端真值一致，每帧均有完整 ContentRef；SQLite payload 仅保留 4 KiB 预览。
- 代理矩阵 3/3：活跃 SSE 在连接未结束时产生 `stream` 事件，带 `flowId/cursor/hash/size/chunks`，可直接交给范围读取动作；已提交分段不依赖整条流 EOF。
- 20,000 帧采集上限和 2,048 条写队列仍是显式保护边界；溢出进入 health dropped 计数，不会被误报为完整。

结论：通过。当前代理不处理 WebSocket upgrade，WS 由 CDP 采集、SSE 由代理原始分段采集，两者都使用统一 ContentStore。

