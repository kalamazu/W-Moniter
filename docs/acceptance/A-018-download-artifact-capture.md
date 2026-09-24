# A-018：下载文件采集与证据化验收

状态：已通过 · 独立复验 2026-09-24 · 实现 `bfe7cc3`、`56e358b` · 对应 [T-018](../tasks/T-018-download-artifact-capture.md)

## 证据与结论

- `npm run test:realtime`：下载 begin/progress/completed 顺序、URL、最终文件名和 receivedBytes 均有浏览器事件证据。
- completed 后通过文件流写入 ContentStore，不把文件整体载入 Electron 内存；事件附带 artifact hash/size/chunks。
- 验收从 manifest/chunks 还原正文并与 fixture 文本一致；归档成功后工作区下载目录原文件被删除，ContentStore 成为权威副本。
- canceled 或找不到最终文件时记录 `content_error`，不发布 artifact。

结论：通过。
