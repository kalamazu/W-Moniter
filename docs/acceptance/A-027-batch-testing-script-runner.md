# A-027：批量测试、断言与脚本运行器验收

状态：纵向首版通过 · 验收 2026-09-25 · 实现 `f923b34` · 对应 [T-027](../tasks/T-027-batch-testing-script-runner.md)

## 证据与结论

- `test:execution-centers` T-027 4/4：同一模板真实运行 1/10/100 次；总 case、attempt、passed 与延迟样本一致。
- 并发 worker 不共享 case 变量；数据集轮转和 `${variable}` 替换可用；状态/header/body/JSON path/time 五类断言都回到实际响应证据。
- 失败套件以 1 个 case、2 个 attempts（一次重试）、2 个 notStarted 验证 stopOnFailure，不把 attempt 当业务 case。
- 测试套件、不可变版本和最近报告按工作区原子持久化；Action 的 AbortSignal 贯穿批量与 HTTP 执行器，结果模型区分 cancelled/notStarted/unknown。
- 前/后置脚本没有 Node 全局并有 100 ms 同步超时；按 ADR-0011 只允许用户信任的本地代码，不宣称为恶意脚本沙箱。

结论：M6 首版批量、断言、变量、重试、脚本和报告闭环通过。暂停/继续、独立 runner 进程及 OS 级脚本隔离属于后续生产化硬化。
