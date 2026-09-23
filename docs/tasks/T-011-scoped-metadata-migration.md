# T-011：工作区元数据归属与范围校验迁移

- 状态：已通过
- 蓝图映射：M2 §5、§10.2；E06
- 优先级：P0
- 认领：Codex · 2026-09-23
- 基线 commit：`7186ca2`
- 验收：[A-011](../acceptance/A-011-scoped-metadata-migration.md)

## 背景与目标

目前工作区靠独立目录和 SQLite 文件隔离，查询本身没有统一的 `workspace/profile/partition` 范围约束。将现有 v8 数据明确归属默认工作区，并让新查询按可信工作区上下文校验，为登录、插件和日后统一元数据库奠基。

## 范围

- 要实现：带版本/校验和的下一版 schema 迁移与合成 v8 fixture；为核心请求、Cookie、站点镜像及正文引用补工作区与 profile 归属，Cookie/站点数据保留分区键语义；旧 `inst/seq` 通过映射兼容，repository 对读写范围做强制校验。
- 要修改的边界：`storage/server.mjs` 的迁移/查询入口、`src/main/storage/client.ts` 的可信上下文、`WorkspaceService` 的 profile 身份映射；迁移 SQL 与测试在独立文件维护。
- 非目标：本任务不合并所有工作区的物理数据库，不迁移浏览器 Profile 目录，不删除旧列、BLOB 或 Cookie 数据。

## 依赖与风险

- 前置任务：T-000、T-006；T-005～T-009 独立验收对本轮迁移是回归门槛。
- 风险：旧数据的真实账号/分区无法从单个 URL 推断，只能标记来源和未知字段；迁移前必须制作一致备份并验证可恢复。
- 取舍：阶段性保留“每工作区独立 DB”与最终 scoped schema 的差异，先写 ADR 和后续统一数据库迁移门槛。

## 验收标准

- 用户或 Agent 流程：默认工作区旧历史仍可读；A/B 各自读写请求、Cookie 和站点资料，给另一工作区 ID/引用必须返回范围错误，不退回活动工作区。
- 自动化测试：合成 v8→新版本迁移、重复执行幂等、失败中断/备份恢复、foreign key 与跨范围负例；现有 `test:storage`、`test:workspaces`、`test:sitedata`、控制面回归通过。
- 失败与边界：不明归属标 `legacy_unknown` 或等价状态，不猜账号；迁移失败不启动写入，也不修改运行中的 Chromium Profile。

## 完成记录

- 实现 commit：`faba1d7`（本任务独立提交）。
- 修改文件：`storage/migrations/009-scope.mjs`、`storage/server.mjs`、`src/main/storage/client.ts`、`src/main/controller.ts`、`src/main/index.ts`、`scripts/test-scoped-migration.mjs`、`package.json`、[ADR-0004](../adr/0004-scoped-metadata.md)。
- 验证：`test:scoped-migration` 12/12，`test:storage` 54/54，`test:workspaces` 7/7，`test:sitedata` 30/30，`test:control` 33/33；`typecheck` 与 `build` 通过。
- 已知限制：仍为每工作区单库；旧 `inst/seq` 只在库内唯一；没有合库级联合主键；已迁移的数据不能用 Git 回滚，须用 `.pre-v9-*.bak` 恢复。
- 回滚：`git revert <本任务提交>` 仅回退代码；已迁移用户库须按迁移备份/回退规程处理，不用 Git 操作回滚数据。
