# A-021：内容治理与统一证据工作台验收

状态：已通过 · 复验 2026-09-25 · 实现 `d1eab06` · 对应 [T-021](../tasks/T-021-content-governance-evidence-workbench.md)

## 证据与结论

- `test:core-centers` 7/7：目录、策略、pin/unpin 和固定正文删除拒绝。
- `test:content` 9/9：跨块范围读取、完整性、工作区隔离、删除与休眠后证据。
- `STREAM_TEST_MIB=10240 STREAM_TEST_LARGE_ONLY=1 npm run test:stream-content`：10240 MiB 流式 hash/manifest/chunks 校验通过；默认 100 MiB 用例同时覆盖长度不符与中断 staging 清理。
- UI 提供 JSON/文本/HEX/图片预览；token、Cookie、密码等字段默认遮罩，只能显式解锁当次预览。

结论：通过。自动定时 GC 不在本卡内；显式 `content.gc` 采用 pin、宽限期、配额和 retention 引用对账。
