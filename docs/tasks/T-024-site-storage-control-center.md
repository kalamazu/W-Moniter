# T-024：Cookie 与站点存储控制中心

状态：开发中
蓝图映射：M4 §6.2 / §10.2
优先级：P0
认领：Codex（2026-09-25）
基线 commit：`7108dad`
验收：A-024（完成实现后创建）

## 背景与目标

现有站点数据能力以扫描和局部 API 为主，尚不能让人安全地完成新增、编辑、导入、快照、差异和恢复。本任务交付完整的站点存储工作台，同时保持 workspace/profile/origin/partition/context 的真实边界。

## 范围

- 要实现：Cookie、local/sessionStorage、IndexedDB、CacheStorage、Service Worker 的浏览、编辑、批量导入导出、快照 diff、选择性恢复与读回验证；修改后触发登录 stale。
- 要修改的边界：site-storage 领域服务、浏览器适配、值 ContentRef、审计、StorageWorkbench 和统一动作。
- 非目标：不把 sessionStorage 当作 origin 全局数据恢复，不允许远程页面指定任意本地导入文件。

## 依赖与风险

- 前置任务：T-011、T-013、T-021、T-022。
- 风险：Cookie partition/SameSite/HttpOnly 语义、恢复覆盖登录、跨工作区读取秘密。
- 需要 ADR：完整值授权、导入冲突和选择性恢复策略。

## 验收标准

- 人类可完成编辑、导入、快照、diff、恢复；Agent 以显式 workspace/profile/origin 目标执行同一动作。
- 真实浏览器读回值，并用 fixture 验证 Cookie 是否实际随请求携带；覆盖 partition、IDB、cache 和页面 context。
- 非法字段、过期上下文、部分恢复和跨 scope ID 均明确拒绝并保留审计。

## 完成记录

- 实现 commit：
- 修改文件：
- 测试命令与结果：
- 已知限制：
- 回滚：`git revert <commit>`
