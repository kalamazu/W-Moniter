# Q-005：Controller/ActionRegistry 模块化重构

状态：开发中 · 优先级：P0 · 认领：Codex（2026-09-25） · 基线：`d0fa446`

目标：动作目录和 T025～T029 领域处理器移出 Registry；新增能力通过领域 facade 调用 Controller，停止继续扩大巨型文件。

验收：现有协议与测试不变；Registry 只负责策略、目标、任务和路由；模块可独立单测与回退。

