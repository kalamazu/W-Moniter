# T-019：缓存与 Service Worker 响应覆盖收口

状态：可认领
蓝图映射：M1 §4.2、§13.2；E04
优先级：P0
认领：未认领
基线 commit：待认领时填写
验收：A-019（完成实现后创建）

## 背景与目标

代理不能自然看到缓存命中或 Service Worker 本地生成的全部正文，单一 CDP 路径也可能受读取时机限制。本任务要用明确来源路由和真值矩阵收口这两类响应：能获取就完整入库，不能获取就精确留缺口。

## 范围

- 要实现：识别 memory/disk cache、SW pass-through、SW synthetic/offline 来源；在可用的 CDP/CacheStorage/SW 路径中读正文并写 ContentStore；对请求记录 source、representation、completeness 和独立证据。
- 要修改的边界：CaptureCoordinator/source-router、CDP source、缓存/SW 受控 fixture、能力账本和请求详情。
- 非目标：不为了采集默认禁用用户的缓存或 SW；不将 CacheStorage 中同 URL 的任意条目无证据地当作当次响应。

## 依赖与风险

- 前置任务：T-010、T-012；可与 T-016～T-018 并行开发，但最终共用完整性语义。
- 数据/兼容性/安全风险：请求 URL 不足以证明缓存条目归属；必须绑定 request/generation/cache key 并防止跨工作区读取。
- 需要 ADR 的取舍：若标准 CDP 无法覆盖 synthetic response，列出扩展辅助或浏览器适配器方案及成本，不缩小目标。

## 验收标准

- 用户或 Agent 流程：同一页面在首访、内存缓存、磁盘缓存、SW 透传和离线合成时，详情明确显示来源与正文是否完整。
- 自动化测试：每种场景比较 origin 请求数、页面所见 hash 和终端内容 hash；清缓存、更新 SW、skipWaiting 与断网重启均有用例。
- 失败与边界行为：无法确定当次字节来源时标 `unknown_source`/缺口，不得用历史同 URL 正文填充并报 complete。

## 完成记录

- 实现 commit：
- 修改文件：
- 测试命令与结果：
- 已知限制：
- 回滚：`git revert <commit>`
