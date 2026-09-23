# T-014：插件能力验证与工作区期望/实际对账

- 状态：返工
- 蓝图映射：M2 §5.1/§5.2、§13；E04/E12 的插件切片
- 优先级：P1
- 认领：Codex · 2026-09-23
- 基线 commit：`ad590d4`
- 验收：[A-014](../acceptance/A-014-extension-observation.md)

## 背景与目标

当前独立 Chromium Profile 可以保存插件数据，但终端尚不知道每个工作区实际加载了哪些插件、版本/权限是什么、与用户期望是否漂移。先用受控扩展验证可观测与重启行为，再建立只读清单和期望/实际对账，不假装能任意静默安装第三方扩展。

## 范围

- 要实现：`fixtures/extensions/state-probe` 和 `scripts/probes/extension-management.mjs` 验证枚举、启停能力边界、版本/权限与配置跨重启；持久记录 workspace/profile 的期望项和观察项；工作区插件卡片及 HTTP/MCP 查询显示 observed/desired、漂移原因和最后核对时间。
- 要修改的边界：`src/main/extensions/*`、scoped repository、工作区 UI、动作目录；安装/卸载若技术验证不可控，仅报告能力限制，不接危险写动作。
- 非目标：不静默安装任意商店插件，不绕过 Chrome 权限确认，不把插件文件复制视为已经启用。

## 依赖与风险

- 前置任务：T-011；T-010 的能力矩阵格式可复用，但不是硬依赖。
- 风险：CDP target 列表不一定等于完整插件清单；验证必须同时检查 Profile 中实际运行结果和受控扩展行为，区分“未知”与“未安装”。
- 取舍：安装来源、辅助扩展权限和打包策略须先写 ADR；生产写动作待独立任务与明确用户确认。

## 验收标准

- 用户或 Agent 流程：A/B 工作区安装不同受控扩展，清单和漂移提示不串；重启后重新观察，显示实际版本、权限与最近核对时间。
- 自动化测试：`scripts/test-extensions.mjs` 覆盖受控扩展启停/重启、期望与实际漂移、权限变化、跨工作区拒绝，以及 UI/HTTP/MCP 同一摘要。
- 失败与边界：无法枚举时状态为 unknown 并给出原因，不误报空清单；未经能力验证不得执行安装、卸载或启停。

## 完成记录

- 实现 commit：`5ba1686`（本任务独立提交）。
- 修改：v11 scoped 扩展迁移、Profile/CDP 部分观察、期望/实际对账、ActionRegistry、UI/HTTP/MCP、受控 MV3 探针与 A/B 集成测试；架构取舍见 [ADR-0007](../adr/0007-extension-observation.md)。
- 验证：`typecheck`、`build`；Chrome for Testing 154 下 `test:extension-probe` 3/3、`test:extensions` 9/9；`test:scoped-migration` 16/16、`test:auth-ledger` 11/11、`test:storage` 54/54、`test:workspaces` 7/7、`test:actions` 13/13。
- 已知限制：正式 Chrome 153 不加载测试 fixture 的 `--load-extension`；产品未接入可信 `chrome.management` 桥。Profile/CDP 只能做部分观察，缺席为 unknown；插件启停/安装/卸载未执行也未开放。受控探针验证了 API 枚举与跨重启存储，但未验证 `setEnabled` 写入。生产的跨版本/权限漂移只在能够读到元数据时判断，不能保证任意插件实时完整枚举。休眠工作区暂无离线摘要。
- 回滚：`git revert <本任务提交>`；观察记录不应影响浏览器现有扩展状态。
