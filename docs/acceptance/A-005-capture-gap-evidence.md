# A-005：采集缺口、保留与证据独立验收

状态：待独立验收 · 实现 `94958b0` · 对应 [T-005](../tasks/T-005-capture-gap-evidence.md)

自动证据：`npm run test:actions` 13/13（模拟超时缺口、请求级证据、篡改检测）；`npm run test:content` 7/7（2 MiB 正文、显式删除、原因、缺口汇总、休眠后查询）。`npm run test:smoke` 129/129 验证旧资源导出仍可读取 ContentStore。

独立复核：人工或其他 Agent 检查真实 CDP 超时与内容盘写失败时状态是否一致；检查清理中断后 `retention_intent` 是否足够恢复；检查被清理内容的全部引用。哈希链不是本机所有者不可篡改存储，见 [ADR-0002](../adr/0002-content-evidence-and-retention.md)。完成这些复核前不标“通过”。
