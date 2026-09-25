# A-028：站点档案与资源知识库验收

状态：纵向首版通过 · 验收 2026-09-25 · 实现 `d77dd1a`、`b89b0db` · 对应 [T-028](../tasks/T-028-site-resource-knowledge-base.md)

## 证据与结论

- `test:knowledge-workflow` T-028 4/4：真实请求与 ContentStore 重建资源索引；同 URL 不同 bodyHash 形成独立版本；中文正文、URL/源码搜索返回 coverage、request seq 和正文 hash 证据。
- 资源版本 diff、站点 dossier、笔记版本和 endpoint merge/split 人工 override 均可读写；重建只替换派生 resources/documents/coverage，保留 notes/overrides 和原始证据。
- `test:resource-scale` 2/2：实际 ResourceKnowledgeService 在 30 秒门槛内构建 100,000 个版本，末页 100 条分页和第 99,999 条搜索准确；取消后 coverage 明确为 canceled，部分派生索引自洽。
- 所有 Action 需要显式 workspace TargetRef；不同工作区使用独立 `knowledge.json` 与 ContentStore，不做跨 scope 聚合。

结论：M7 本地首版通过。索引正文大小、中文子串算法和未来独立 indexer/FTS 的升级条件已写入 ADR-0012，不把派生摘要当成事实源。
