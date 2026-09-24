# A-020：工作区检查点与冷恢复验收

状态：已通过 · 独立复验 2026-09-24 · 实现 `1a08135`、`2253a92` · 对应 [T-020](../tasks/T-020-workspace-checkpoint-restore.md)

## 证据与结论

- `npm run test:workspaces` 9/9：只有 suspended 独立工作区可创建/恢复检查点；统一 Action API 可 create/list/restore。
- 检查点包含 Profile、SQLite、ContentStore、下载、规则和 UI 设置，每个文件记录 size + SHA-256；恢复前重新生成 inventory 并逐项比对。
- 所有组件先复制到同目录 stage，再交换目标；失败反向恢复 old，并另存完整的恢复前备份。
- 恢复后仍为 suspended，工作区明确标注“登录证据需重新验证、扩展下次打开复扫”。

结论：通过。legacy 默认工作区因目录分散被明确拒绝，不伪称可一致恢复。
