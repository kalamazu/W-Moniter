# T-028：站点档案与资源知识库

状态：待验收
蓝图映射：M7 §8.1
优先级：P1
认领：Codex（2026-09-25）
基线 commit：`11f98e1`
验收：[A-028](../acceptance/A-028-site-resource-knowledge-base.md)

## 背景与目标

请求、接口画像和导出已经存在，但长期资料仍按会话和面板分散。本任务把站点、资源版本、接口修订、关系、笔记和搜索做成可持续积累、可纠正且能回到原始证据的知识库。

## 范围

- 要实现：站点档案、访问/资源版本、资源树与网格、源码/中文搜索、版本 diff、接口 merge/split 人工纠正、证据关系、笔记和可取消导出/索引任务。
- 要修改的边界：资源/站点领域服务、后台 indexer、FTS/索引 coverage、既有接口画像与关系图迁移、资源工作台。
- 非目标：不让分析摘要替代原始正文；不把自动归类写成不可逆事实。

## 依赖与风险

- 前置任务：T-021、T-022、T-026。
- 风险：大资源索引拖慢采集、中文搜索效果、算法升级覆盖人工纠正、跨 scope 搜索泄漏。
- 需要 ADR：索引覆盖、人工覆盖优先级和资源版本身份。

## 验收标准

- 用户能从站点进入资源、接口、关系和历史版本，搜索结果显示索引覆盖并可一键回到正文/请求证据。
- 自动建议与人工归类分别版本化；索引删除后可重建且不影响原始证据。
- 覆盖同 URL 多版本、中文/代码/二进制、10 万资源分页、取消重建和跨工作区拒绝。

## 完成记录

- 实现 commit：`d77dd1a`、`b89b0db`
- 修改文件：`src/shared/contracts/resources.ts`、`src/main/resources/service.ts`、`KnowledgePanel.tsx`、`scripts/test-{resources-workflow,resource-scale}.mjs`
- 测试命令与结果：`test:knowledge-workflow` 的 T-028 4/4；`test:resource-scale` 2/2，真实服务完成 100,000 资源与取消重建。
- 已知限制：正文索引每版本 1 MiB、diff 2 MiB；中文为确定性子串检索；大规模全文与并发写入达到瓶颈后迁独立 indexer/FTS。
- 回滚：先 `git revert b89b0db`，再 `git revert d77dd1a`（后者与 T-029 共用 Action/UI 接线）。
