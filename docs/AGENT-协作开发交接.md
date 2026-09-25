# 智能 Web 管理终端：Agent 协作开发交接

更新时间：2026-09-25  
工程目录：`F:\code\chrome`  
远程仓库：`https://github.com/kalamazu/W-Moniter.git`  
当前分支：`main`  
最近核心实现提交：`4600f4d refactor(core): isolate replay worker and harden tasks`（本文档提交以 `git log -1` 为准）

> 本文是新 Agent 的单一入口。先完整阅读本文，再阅读蓝图和所领取的任务卡。不要仅根据提交数量、代码行数或旧验收单判断完成度。

## 1. 接手时必须先确认的仓库状态

本文档提交后，交接工作区应保持干净，本地 `main` 比 `origin/main` **超前 24 个提交**。远程仓库并不包含全部现状；如果后来发生推送或新增提交，以 `git status -sb` 的实时结果为准。

新 Agent 的第一组只读检查：

```powershell
Set-Location F:\code\chrome
git status -sb
git log --oneline --decorate -15
git remote -v
```

不要 reset、checkout 或覆盖本地 `main`。需要推送时先确认远程没有新的分叉，再执行普通 `git push origin main`。未经用户要求，不要改写提交历史或强制推送。

## 2. 产品最终目标

这不是一个普通抓包器，也不只是 Electron 包装的 Chrome。目标是一个“智能 Web 管理终端”：

1. **工作区是浏览器状态容器和状态机**：每个工作区拥有独立浏览器 Profile、登录状态、Cookie/站点存储、插件状态、网络环境、历史资料、内容证据、规则、下载、任务和知识资产。
2. **尽可能完整采集，同时诚实标记缺口**：正文、大 body、上传、下载、WebSocket、SSE、Cache/Service Worker 等都应进入内容寻址存储；浏览器未交付的 opaque/内部流量必须留下明确缺口证据，不能伪装为成功。
3. **完全控制浏览器**：稳定的 Browser/Tab/Frame 对象、代次校验、导航、刷新、上传、对话框、Cookie/Storage、环境/代理、请求重放和批量测试。
4. **证据优先**：分析、测试、重放、工作流和 Agent 输出都应能追溯到请求、正文 hash、时间线或人工修订，不把推断冒充事实。
5. **Agent 友好且人类可视化**：能力通过统一 Action/Task/Target 契约暴露给 UI、HTTP、MCP、CLI；人类界面采用工作台式信息架构，而不是把所有功能堆在一个页面。
6. **插件化演进**：领域能力应逐步从巨型 Controller/Registry 中退出，形成可发现、可授权、可测试、可回退的模块。插件不是简单 UI 插槽，还需要权限、版本、状态和证据边界。

最高设计约束是 [工程实施蓝图](智能Web管理终端-工程实施蓝图.md)，产品方向见 [设计文档](设计文档.md) 和 [长期开发计划](智能Web管理终端-长期开发计划.md)。

## 3. 完成度口径：最容易犯错的地方

项目此前出现过“流程比结果可靠”的问题：任务卡、验收单和 ADR 很完整，但部分实现是薄壳、JSON 文件或子串搜索，也能通过当时较窄的验收。之后已经纠偏，完成状态必须按 [完成定义](architecture/quality-definition-of-done.md) 解释：

- **开发中**：代码或证据不完整。
- **纵向首版通过**：真实核心链路能运行，但没有满足蓝图的完整生产化标准。
- **完整验收通过**：任务卡的规模、安全、恢复、UI 和边界均满足。
- **生产可用**：还需升级、打包、长稳、安全和运维验证。

当前真实结论：

- T-000～T-024：已通过各自验收，但仍不等于整个产品生产可用。
- T-025～T-029：仅为**纵向首版通过**，不能统计成蓝图终态完成。
- Q-002：独立执行基础已通过。
- Q-001、Q-003、Q-004、Q-005：仍在开发中。
- T-030（M9 智能分析与协议实验）：尚未认领。
- M10（交付、升级、备份、长稳）：尚未正式展开。

精简进度看 [实施进度与待办](实施进度与待办.md)，任务状态以 [任务看板](tasks/README.md) 为准。

## 4. 当前运行架构

### 4.1 进程与职责

```text
React Renderer
    │ preload / IPC
Electron Main
    ├─ WorkspaceService：工作区目录、生命周期、检查点
    ├─ Controller：Chrome/CDP、采集、站点状态、浏览器控制
    ├─ WorkspaceActionRegistry：策略、Target、Task 和领域路由（目前过大）
    ├─ TaskService：幂等、取消、结果、unknown 恢复、事件 cursor
    └─ ExecutionWorkerClient
          └─ workers/server.mjs：独立 HTTP Runner、正文解码

独立子进程
    ├─ storage/：SQLite 存储进程
    ├─ content/：内容服务
    ├─ proxy/：可选本地代理
    ├─ control/：本地 HTTP 控制面
    ├─ mcp/：Agent MCP 入口
    └─ win/：Windows 窗口吸附助手
```

这些可执行资源必须位于 asar 外，打包配置在 `electron-builder.yml`。

### 4.2 核心目录

| 路径 | 当前职责 |
| --- | --- |
| `src/main/index.ts` | 应用装配、工作区 Controller、IPC、控制面和 Worker 接线；仍偏大 |
| `src/main/controller.ts` | Chrome/CDP 与大量浏览器能力；Q-005 要继续拆分 |
| `src/main/actions/registry.ts` | 统一动作目录和路由；目前是巨型 switch，Q-005 核心对象 |
| `src/main/actions/task-service.ts` | Task journal、幂等、取消、unknown、事件 cursor |
| `src/main/workspace/` | 工作区状态与路径隔离 |
| `src/main/content/` | ContentStore、证据、治理与保留策略 |
| `src/main/replay/` | 请求模板与重放领域服务 |
| `src/main/testing/` | 批量测试、断言、重试和报告 |
| `src/main/resources/` | 资源版本、站点档案、搜索、diff 和人工修订 |
| `src/main/workflow/` | DAG、等待、变量、lease/fencing 和恢复 |
| `src/main/repositories/` | 当前版本化 JSON repository 基础 |
| `src/main/workers/`、`workers/` | Worker 客户端和独立执行服务 |
| `control/`、`mcp/`、`cli/` | HTTP、MCP、CLI 的 Agent 入口 |
| `src/renderer/` | 工作台 UI |
| `scripts/` | 端到端和专项验收；项目可信度依赖这些真实测试 |

### 4.3 数据边界

每个工作区有独立 Profile、SQLite、ContentStore、下载、规则和 UI/环境文件。`WorkspaceService.pathsFor(id)` 是路径真值来源，不要自行拼接另一个“当前工作区”目录。

正文应进入 ContentStore，业务记录保存 hash/ref；SQLite 或 JSON 中不应继续复制大正文。所有写动作应显式携带 `TargetRef.workspaceId`，禁止失败时静默回退到当前焦点工作区。

## 5. 最近完成的质量改造

提交 `4600f4d` 完成：

- 独立 HTTP 重放从 Electron 主进程迁到 `workers/server.mjs`。
- 资源索引的正文解码通过 Worker RPC 执行。
- Worker 有 request id、超时、AbortSignal 取消、health、崩溃隔离和下一次调用自动重启。
- Task 取消成为幂等操作，不再产生重复 canceled 终态。
- Task 事件支持单调 cursor，sidecar 超过 8 MiB 会压缩到最近 10,000 条。
- Replay/Resource 的 mutation 使用 repository `update()`，减少读—改—写覆盖。
- HTTP 已有 `/actions/start`、`/tasks/:id`、`/tasks/events?after=`，真实 800ms 工作流证明 start 非阻塞。
- `test:quality-core` 验证 Worker PID 隔离、退出后恢复，以及 repository 迁移/CAS。

注意：Q-002 验收只说明“独立执行基础”完成。当前资源检索仍是 JSON 派生文档加子串扫描，不是 FTS，也不是完整独立 Indexer。

## 6. 当前最重要的技术债务与建议顺序

### P0-1：完成 Q-003 正式 Repository

现状：`VersionedJsonRepository` 已有 envelope、revision、原子 rename、旧文件备份、损坏隔离和 CAS。Replay/Resource 部分 mutation 已改为 `update()`。

缺口：

- TestingService、WorkflowService 仍需逐个审计 mutation，消除裸 read-modify-write。
- 当前仍主要是领域 JSON 文件，不是蓝图定义的正式 SQLite/query repository。
- 尚无可靠跨进程写锁、迁移账本和完整仓库诊断 API。
- 需要旧 replay/testing/knowledge/workflow fixture 原位升级测试、并发写测试、损坏恢复测试。

不要为了“完成 Q-003”只再包一层接口；验收必须证明旧数据保留、并发不丢写、损坏可恢复。

### P0-2：完成 Q-004 跨入口长任务协议

现状：HTTP 非阻塞 start、task result、事件 cursor、取消和重启 unknown 已有基础验证。

缺口：

- MCP 和 UI/preload 还没有与 HTTP 对等的 start/get/events 体验。
- 事件仍是 JSONL sidecar，不是正式事件表。
- 缺任务数量/结果保留上限、慢消费者语义、游标过期响应和事件损坏诊断。
- Worker crash、应用 crash、任务 cancel 之间需要更完整的状态映射和恢复矩阵。

### P0-3：完成 Q-005 Core 模块化

现状：`WorkspaceActionRegistry` 同时持有动作目录、领域 service cache、巨大 switch 和部分业务编排；`Controller`、`index.ts` 也继续偏大。

目标拆法：

1. 把动作类型与 descriptor catalog 移到独立模块。
2. 按 browser/replay/testing/resources/workflow/content/workspace 划分 handler/facade。
3. Registry 只保留 catalog lookup、policy、target resolution、Task 包装和 handler dispatch。
4. Controller 只暴露窄能力接口，领域服务不得继续直接依赖巨型 Controller。
5. 每个领域 handler 可独立单测；公共协议和现有 14/14 Action 回归必须保持不变。

不要一次重写全部 Controller。优先抽 T-025～T-029 新领域，因为边界较清楚且最容易阻止 Registry 继续膨胀。

### P1：把 M5～M8 从纵向首版推进到正式能力

- 重放：Cookie 策略、流式请求/响应、multipart 编辑、代理/证书、请求链证据。
- 测试：独立脚本沙箱、资源限制、暂停/继续、可复现报告与差异比较。
- 资源：FTS/增量索引、结构化 endpoint/schema、源码映射、大规模检索。
- 工作流：事件订阅、可视化图编辑、补偿语义、人工审批、更完整 lease。

### P1/P2：T-030 与 M10

在 Q-003～Q-005 地基收口前，不建议大规模堆 M9 智能功能。智能分析首先要有稳定证据引用、可复现实验和明确事实/推断边界。M10 需要覆盖升级、备份恢复、便携包、许可证、24h/72h 长稳和退役审计。

## 7. 开发 SOP

1. 从蓝图抽象一个可纵向验收的任务；先写或更新 `docs/tasks/` 任务卡，明确范围、非目标、依赖、风险和验收。
2. 在任务看板登记认领者、基线 commit 和状态。
3. 只实现该任务需要的能力；不得用隐藏测试后门、静态假数据或仅为通过断言的薄壳替代真实执行路径。
4. 先跑针对性测试，再跑受影响领域回归；关键结论必须有失败/恢复/边界用例。
5. 实现完成后先标“待验收”；验收单放入 `docs/acceptance/`。验收不满足就返工或回滚，不改低标准迁就实现。
6. 更新 `docs/实施进度与待办.md`，只记录有实现位置和测试证据的结果。
7. 每个任务使用可独立回退的提交。不要把多个无关任务塞入同一 commit。

涉及持久化模型、进程边界、安全策略或不可逆兼容取舍时，先新增/更新 `docs/adr/`。

## 8. 编码约束与常见陷阱

- 工作区可能有多个 Controller 并发运行；`controller` 全局变量只是 UI/Agent 当前焦点，不是所有状态的唯一来源。
- 写动作必须显式目标化，不得以“当前工作区”作为隐式兜底。
- 不要把大 body 放回 SQLite、Redux 或普通 JSON；使用 ContentStore 引用和范围/流式读取。
- “采集不到”必须形成 evidence gap，不能吞错或返回空字符串冒充空正文。
- 重放和脚本属于高风险能力；写请求需要显式确认，脚本需要隔离、资源上限和可信来源。
- 浏览器对象必须校验 document generation，避免对刷新后的旧 Tab/Frame 引用执行动作。
- 恢复运行中任务时，远端副作用默认是 `unknown`，不能自动重发。
- 不要把 JSON repository 叫作数据库层，也不要把正文 decoder worker 叫作完整 Indexer。
- 不要因已有验收单就跳过阅读任务卡的“已知限制”。
- 保留用户已有改动；禁止 `git reset --hard`、强制 checkout 和无确认的大范围删除。

## 9. 验证命令

基础门槛：

```powershell
npm run typecheck
npm run build
```

当前质量与核心回归：

```powershell
npm run test:quality-core
npm run test:actions
npm run test:execution-centers
npm run test:knowledge-workflow
npm run test:resource-scale
```

交接时最近结果：

- `test:quality-core`：3/3
- `test:actions`：14/14
- `test:execution-centers`：11/11
- `test:knowledge-workflow`：9/9
- `test:resource-scale`：2/2
- `typecheck`、`build`：通过

更广回归入口都在 `package.json`，包括 workspace、content、capture、stream、proxy、control、UI、smoke 等。修改底层存储、Controller、ContentStore 或打包配置时，不能只跑上述五组。

## 10. 推荐给接手 Agent 的第一项任务

优先领取 **Q-005 的第一阶段：ActionRegistry 领域拆分**，但不要在同一任务中重写 Controller。

建议验收范围：

1. 抽离 catalog/descriptors。
2. 把 replay/testing/resources/workflow handler 移入独立 execution-domain router/facade。
3. Registry 的对应 case 被移除，仅做统一策略、Target 和 Task 包装。
4. `test:actions` 14/14、`test:execution-centers` 11/11、`test:knowledge-workflow` 9/9 全部保持通过。
5. 新增领域 router 单测，证明未注册 action、错误 target、取消信号和领域异常仍使用统一结果语义。

完成这一阶段后，再领取 Q-003 的 Testing/Workflow mutation 原子化。这样可以先稳定代码边界，再迁移持久化，降低同时修改路由和数据模型的风险。

## 11. 阅读顺序

新 Agent 建议按以下顺序进入项目：

1. 本文。
2. [工程实施蓝图](智能Web管理终端-工程实施蓝图.md) 第 1～3、10、13～15 节。
3. [完成定义](architecture/quality-definition-of-done.md)。
4. [任务看板](tasks/README.md) 和 Q-003～Q-005 任务卡。
5. 与所领任务对应的 ADR、实现文件和验收脚本。
6. 开始修改前运行基础门槛及相关现有回归，建立自己的干净基线。

如果本文与蓝图冲突，以蓝图为产品/架构最高约束；如果本文与仓库实际代码或测试冲突，以可复现证据为准，并立即修正文档，不要默默沿用过时结论。
