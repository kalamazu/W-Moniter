# ADR-0012：可重建知识索引与工作流 fencing lease

状态：已接受（2026-09-25）
关联：T-028、T-029

## 决策

1. 请求、ContentStore 正文和证据序号是事实源；资源文本、站点聚合和搜索文档都是可删除、可取消、可重建的派生数据。索引失败或算法升级不得修改事实源。
2. 资源版本身份优先使用 `URL + bodyHash`；没有正文时退化到状态、MIME、长度和结束时间摘要，并明确属于元数据版本。相同 URL 的不同内容保留独立版本和请求证据。
3. 自动资源/接口归类与人工 note、merge/split override 分开保存。人工资产追加版本，重建索引时保留，算法不能静默覆盖。
4. 工作流启动时冻结 definition version、workspace 和变量。节点只能调用统一 ActionRegistry，显式目标必须属于运行工作区，网页内容或变量不能扩大权限。
5. 每个 run 持有单调递增的 fencing lease。人类接管会轮换 token；旧执行者写回前必须复核 token。在飞节点转为 `unknown`，只有显式确认后才能重新进入 pending。
6. 进程恢复将 `running` run 改为 `needsReview`，在飞节点改为 `unknown`，不自动重发外部副作用。HTTP、MCP、UI 和 CLI 都只转发同一 Action 契约。

## 证据

- `test:knowledge-workflow` 在真实 Chromium/受控 origin 上验证同 URL 多版本、中文正文检索、证据跳转、人工版本、等待节点、DAG 变量、CLI、接管、跨工作区拒绝和真实进程重启恢复。
- `test:resource-scale` 用真实 ResourceKnowledgeService 构建 100,000 个资源版本，验证末页分页、末端 URL 搜索和取消 coverage。

## 边界与重新评估

- 首版索引按工作区原子 JSON 保存，正文索引每版本最多读取 1 MiB、diff 最多读取 2 MiB；10 万元数据已通过，但大规模全文/并发写入达到瓶颈时迁到蓝图中的独立 indexer + FTS repository。
- 中文首版采用 Unicode 不区分大小写子串匹配，保证可预测召回；需要分词、相关性或模糊检索时必须以独立语料评测决定方案。
- UI 提供 JSON DAG 编辑、资源/站点列表和运行时间线；复杂图形布线、事件流订阅和多用户分布式 lease 不在本地 V1 结论内。

