# Q-002：Runner/Indexer 独立进程基础

状态：已通过 · 优先级：P0 · 认领：Codex（2026-09-25） · 基线：`d0fa446`

目标：建立带请求 ID、超时、取消、健康检查和异常退出处理的独立 worker；正文提取和独立 HTTP 执行不再占用 Electron 主线程。

验收：worker 崩溃/超时可诊断；重放与索引真实走子进程；采集和 UI 主进程保持可用。

实现：`workers/server.mjs` 与 `src/main/workers/client.ts` 建立 JSONL RPC、取消、超时、健康检查、崩溃隔离和自动重启；独立 HTTP socket 与正文解码均已移出 Electron 主进程。打包配置将 worker 作为 asar 外资源交付。

证据：`npm run test:quality-core` 3/3、`test:execution-centers` 11/11、`test:knowledge-workflow` 9/9。验收见 [A-Q002](../acceptance/A-Q002-worker-runtime.md)。完整倒排索引/FTS 属于后续 M7 生产化，不冒充本基础任务已实现。
