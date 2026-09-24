# T-026：请求模板与单次重放工作台

状态：待验收
蓝图映射：M5 §7.1
优先级：P0
认领：Codex（2026-09-25）
基线 commit：`19a3c8e`
验收：[A-026](../acceptance/A-026-request-replay-workbench.md)

## 背景与目标

请求已经可完整采集，但还不是可执行资产。本任务交付从历史请求创建版本化模板、编辑并单次重放的完整体验，支持浏览器语义和独立 HTTP 两种执行模式，并把实际出站与结果绑定回证据。

## 范围

- 要实现：RequestTemplate/Collection、重复 query/header、有序 BodySpec、Cookie/身份策略、HAR/cURL 安全导入、浏览器与独立执行器、重定向、结果 diff、运行历史和全宽编辑器。
- 要修改的边界：独立 runner、模板/run repository、Action/Task、请求详情“发送到重放”入口。
- 非目标：不在本卡实现批量参数化和任意脚本；不承诺复制浏览器 TLS/HTTP 指纹。

## 依赖与风险

- 前置任务：T-021、T-023～T-025。
- 风险：Cookie/CSRF 泄漏、受限 header、multipart/二进制损坏、重放写请求产生真实副作用。
- 需要 ADR：双执行器能力边界、Cookie 优先级和写请求确认。

## 验收标准

- 从一条真实请求派生模板，修改参数/头/正文后分别用两种模式执行；origin 验证实际字节、Cookie、重定向和次数。
- 原请求不可变；run 冻结输入、环境和身份版本，结果可回到请求/正文并比较状态、头、结构和字节。
- 覆盖重复头、multipart 文件、二进制、取消、超时、CORS、无效 secret 和未知效果。

## 完成记录

- 实现 commit：`f923b34`、`5df97a0`
- 修改文件：`src/shared/contracts/replay.ts`、`src/main/replay/service.ts`、`src/main/controller.ts`、`src/main/actions/registry.ts`、`ReplayPanel.tsx`
- 测试命令与结果：`test:execution-centers` 的 T-026 3/3；受控 origin 实证两种执行器返回 200、正文进入 ContentStore、写请求无确认被拒。
- 已知限制：浏览器模式受页面 CORS/SW/Runtime 能力约束；独立模式不承诺浏览器 TLS/HTTP 指纹；multipart 首版按 raw/base64 正文保存，尚无逐 part 图形编辑器。
- 回滚：先 `git revert 5df97a0`，再 `git revert f923b34`。
