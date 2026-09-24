# T-027：批量测试、断言与脚本运行器

状态：已通过
蓝图映射：M6 §7.2
优先级：P1
认领：Codex（2026-09-25）
基线 commit：`19a3c8e`
验收：[A-027](../acceptance/A-027-batch-testing-script-runner.md)

## 背景与目标

单次重放之后，需要一次交付可复用的测试能力，而不是继续堆按钮。本任务把集合、数据集、N 次运行、并发/速率、变量、断言、前后置脚本和报告整合为同一批量运行系统。

## 范围

- 要实现：数据集/测试套件、次数与并发策略、重试/停止条件、变量作用域、状态/header/JSON/body/时间断言、受管脚本进程、运行矩阵与报告。
- 要修改的边界：runner batch/script host、任务调度、testing repository、测试与脚本工作台、Agent 动作。
- 非目标：首版只运行用户信任的本地脚本，不宣称能安全执行任意第三方恶意代码。

## 依赖与风险

- 前置任务：T-026。
- 风险：重复副作用、取消后在飞请求、并发变量串扰、重试统计误导、脚本资源耗尽。
- 需要 ADR：脚本信任模型、变量/秘密、case 与 attempt 计数语义。

## 验收标准

- 同一套件可运行 1/10/100 次，支持串行/并发/间隔/速率，结果准确区分 case、attempt、cancelled、notStarted 和 unknown。
- 每 case 变量隔离，断言能回到实际请求/响应/脚本版本，报告展示失败分组和有样本数的延迟分位数。
- 覆盖取消、超时、重试、脚本异常/超限、断言失败、重启后历史读取和跨工作区拒绝。

## 完成记录

- 实现 commit：`f923b34`
- 修改文件：`src/shared/contracts/testing.ts`、`src/main/testing/service.ts`、`src/main/actions/registry.ts`、`ReplayPanel.tsx`
- 测试命令与结果：`test:execution-centers` 的 T-027 4/4；1/10/100 次、并发、断言、重试和 stopOnFailure 通过。
- 已知限制：可信本地脚本仅有同步 100 ms 超时，不是恶意代码沙箱；暂停/继续和独立 runner 进程留到运行时生产化任务。
- 回滚：`git revert f923b34`（与 T-025/T-026 共用接线，按批次回退）
