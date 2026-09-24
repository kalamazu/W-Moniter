# T-023：代理与环境配置中心

状态：已通过
蓝图映射：M3 §6.1
优先级：P0
认领：Codex（2026-09-25）
基线 commit：`7108dad`
验收：[A-023](../acceptance/A-023-environment-proxy-center.md)

## 背景与目标

现有代理主要由环境变量决定，缺少工作区级版本、上游路由、认证、诊断和真实生效证据。本任务交付可管理的网络环境中心，让每个浏览器身份使用冻结且可回读的配置。

## 范围

- 要实现：环境版本、直连/HTTP CONNECT/SOCKS 上游、域名/网段分流、认证 SecretRef、DNS/出口/TLS 诊断、应用/回滚和待重启状态；配套工作台与 Agent 动作。
- 要修改的边界：代理路由流水线、浏览器启动配置、safeStorage 秘密、环境 repository、规则面板整合。
- 非目标：不承诺绕过站点风控，不把代理密码写入模板、参数、日志或普通数据库列。

## 依赖与风险

- 前置任务：T-000、T-001、T-011、T-022。
- 风险：配置失败后静默直连、DNS 泄漏、跨工作区复用错误凭据、代理循环。
- 需要 ADR：路由优先级、失败是否允许直连、秘密可移植性。

## 验收标准

- 用户可编辑、测试、应用并回滚环境；界面展示实际出口、命中路由、配置版本和是否需要重启。
- fixture 覆盖直连、HTTP/SOCKS、认证成功/失败、超时、DNS、TLS 和 A/B 工作区不同出口。
- 必须代理的路由失败时不得静默直连；日志和导出中无明文秘密。

## 完成记录

- 实现 commit：`d1eab06`、`9678c69`
- 修改文件：`src/main/environment/repository.ts`、`src/main/index.ts`、`EnvPanel.tsx`、ActionRegistry。
- 测试命令与结果：`test:core-centers` 7/7，含真实 HTTP CONNECT 上游命中、失败诊断、版本应用与明文秘密拒绝。
- 已知限制：SecretRef 在没有本机秘密提供器时 fail-closed；不会退化为无认证或直连。PAC 复杂规则依赖 Chromium PAC 语义。
- 回滚：`git revert 9678c69 d1eab06`
