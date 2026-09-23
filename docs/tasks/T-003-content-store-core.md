# T-003：ContentStore 内容寻址与分块写入

状态：已通过
蓝图映射：M1 §4
优先级：P0
依赖：T-002

## 目标

建立独立于 SQLite BLOB 的内容服务核心：分块写入、SHA-256 内容引用、manifest、范围读取与完整性校验。它只处理字节，不决定浏览器采集策略。

## 验收

- 大于旧 256KB 上限的随机二进制可完整写入、按 hash 读取并校验。
- 相同内容去重，不重复占用数据文件。
- 未完成 staging 文件不会被当作已提交内容读取。
- A-003 覆盖分块、去重、范围读取和损坏检测。

## 完成记录

- 认领：Codex · 2026-09-23；基线：`1c36c1d`。
- 实现：`ContentStore` 以 SHA-256 manifest 和 1MiB chunk 原子落盘；SQLite 只保存引用。
- 实现 commit：`2014701`；回滚：`git revert 2014701`。
- 验证：`npm run test:content`、`npm run typecheck`。
