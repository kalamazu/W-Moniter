# 智能 Web 管理终端：工程实施蓝图与文件级改造计划

版本：实施草案 v1.0 · 2026-09-22  
对应产品计划：《智能Web管理终端-长期开发计划》v1.1  
核对基线：`F:\code\chrome`，Git `0579ff4`；后续实现进度与当前验收结果见《实施进度与待办》。

> 实施状态、待办与验收证据维护在 [实施进度与待办](实施进度与待办.md)，可认领的实现单元与独立验收维护在 [任务看板](tasks/README.md)。本文保留目标架构与施工约束；实现发生偏离时，必须新增 ADR 并同步更新这些文档。

本文回答“为了实现长期计划，代码具体放在哪里、旧代码怎样接入、新增哪些依赖与资源、怎样迁移和验收”。它是长期施工依据，不代表所有功能已经实现；已落地范围、偏差与证据以《实施进度与待办》为准。

文中仓库文件路径均相对于 `F:\code\chrome`；同一文件单元格内后续只写文件名时，沿用前一个完整路径的目录。`新增` 是拟创建，`修改` 是本轮确认已存在，`扩展` 是前一阶段拟新增文件的后续增强，`生成` 是构建产物，`退役` 必须满足迁移门槛才删除。目录和文件名为建议契约，开发中可经 ADR 调整，但必须同步调用方、打包清单、测试和本文。M0–M10 沿用产品计划，不另起一套产品路线。

## 1. 实施结论与边界

保留 Electron + React + TypeScript、外置真实 Chromium、独立 Node 存储进程与已有 CDP/代理代码。新增工作区领域、统一动作/任务服务、正文文件服务、重放/测试运行器和资源索引；渐进拆解 Controller 与存储巨文件，不全盘重写。

两条基础线同时立规矩：

1. 工作区是持久浏览器状态容器。所有运行、账号证据、插件、配置、历史和资产必须有归属；界面焦点不是执行目标。
2. 完整采集是存储协议的目标。采集上限、保留策略、UI 预览上限分别管理；响应、上传、脚本源码、WS/SSE 都不能靠增加一个常量假装完成。

实现范围仍覆盖全量采集、独立工作区、代理配置、存储编辑、浏览器控制、单次/批量重放、参数与脚本、资源/接口统计、工作流、智能分析、人类可视化和 Agent 接口。技术验证未解决的能力保留为未完成交付项，不用“暂不支持”替代产品目标。

### 1.1 当前证据与直接改造点

| 已核对文件/符号 | 当前事实 | 必须改变的方向 |
| --- | --- | --- |
| `package.json` | runtime 依赖仅 React/React DOM；Electron 33、electron-vite、TS、electron-builder 为现有声明范围 | 不假定已经有状态机、请求运行器或编辑器；新依赖逐阶段引入，锁精确版本 |
| `src/main/index.ts`：`controller`、`BODY_MAX_BYTES`、`PROFILE_DIR`、`RULES_PATH`、IPC 注册 | 单 Controller；默认 256KB body；一个默认资料目录；全局规则文件 | 改组合根；工作区上下文注入；旧环境变量成为兼容导入而非全局运行权威 |
| `src/main/controller.ts`：`start/shutdown/onBody/siteCall/switchProfile` | 浏览器启动、采集、存储、分析、Cookie、控制集中一处 | 拆 BrowserRuntime、CaptureCoordinator、领域服务；旧接口短期由兼容外观转发 |
| `src/main/browser/body-capture.ts`：`BodyCapture` | Fetch 拦截同时承担采集、规则与探针；大正文、流有跳过路径 | 采集与干预分离，但每个 Fetch 请求仍由唯一仲裁器负责放行 |
| `src/main/browser/collector.ts` | `REQ_BODY_MAX=64KB`，`WS_PAYLOAD_MAX=4096`；请求与消息会截取 | 正文/消息 payload 写内容服务；列表留预览，原文通过引用读取 |
| `src/main/storage/client.ts` | body base64 批量传输；队列满会丢弃；主进程计算 hash | 二进制独立通道、落盘回执、限额与缺口事件；去掉大正文主线程搬运 |
| `storage/server.mjs`：`SCHEMA_VERSION=8`、`DDL`、`OPS` | SQLite BLOB 正文及 LRU；12 张现有表；导出/统计/站点数据均在同一文件 | 显式迁移、按域 repository、正文引用、工作区范围校验、后台导出 |
| 同文件 `cookies.key`、`site_origins.origin`、`currentSiteDoc` | Cookie 与站点镜像存在全局主键/查询 | 先补 workspace/profile/partition 归属再允许多个身份同时写入 |
| `control/server.mjs` / `mcp/server.mjs` / `src/main/control/bridge.ts` | 本地 HTTP、手写 MCP 工具清单、桥接 Controller | 一个动作注册表生成跨入口契约，旧路由保留兼容期 |
| `src/renderer/src/App.tsx` / `components/PaneGrid.tsx` | 面板组织、选中 seq、布局与主要交互在 App 中 | WorkspaceShell + 业务工作台；稳定 requestId；布局降为工作区视图偏好 |
| `electron-builder.yml` / `src/main/paths.ts` | 外置 control/mcp/storage/proxy/win/Node 资源；主包仅 out 与 package.json | 新进程入口和依赖必须可打包，不能只在开发机 node_modules 下能运行 |

本轮是静态代码与目录核对，没有重跑整套应用测试；旧计划中的历史测试结果不是本文新增能力的验收证据。

## 2. 架构与运行进程：插入到哪里

### 2.1 保留的骨架与新增边界

```text
React 工作台                    HTTP / MCP / CLI
    │ preload: execute/query           │ control bridge
    └──────────────┬───────────────────┘
                   ▼
          ActionRegistry + TargetResolver
          TaskService + Policy + VersionGuard
                   │
   ┌───────────────┼───────────────────────────┐
   ▼               ▼                           ▼
WorkspaceService  BrowserManager              领域服务
状态机/身份/恢复    多 BrowserRuntime           重放/测试/资源/分析/工作流
   │               │ CDP pipe                  │
   │               ▼                           ▼
   │        受控 Chromium + CaptureCoordinator  runner / indexer
   │               │                           │
   └───────┬───────┴───────────────────────────┘
           │元数据命令                │二进制流
           ▼                          ▼
     storage 进程                 content 进程
     SQLite 单写者                chunks / manifests / staging
           └────持久引用、提交回执、恢复对账────┘
```

代理继续作为独立进程；CDP 和代理的内容通道汇入同一 content 服务。不要让代理绕过引用账本写“另一套资源库”。UI 不访问 SQLite、原始文件路径或浏览器私有资料目录。

### 2.2 进程职责与连接方案

| 进程/位置 | 负责 | 禁止/连接方式 |
| --- | --- | --- |
| Electron main，`src/main/application.ts` | 组合服务、生命周期、权限、轻量动作编排 | 不解析 GB 正文，不同步全文索引，不执行用户测试脚本 |
| BrowserRuntime，`src/main/browser/runtime.ts` | 一身份的一次 Chromium 运行、CDP 会话、generation、能力 | 初期在主进程轻量运行；按身份持有 pipe，不共享当前页面变量 |
| `storage/server.mjs` | 元数据单写者、迁移、事务、范围查询、任务事件 | 保留小消息 NDJSON；不得传整个正文；同步 SQL 只在本进程 |
| 新 `content/server.mjs` | 分块写盘/hash、范围读取、内容校验、空间统计与 GC 执行 | 本地 loopback 随机端口 + 每次运行 token 的二进制流；不信任客户端文件路径 |
| 现有 `proxy/server.mjs` | 网络转发、上游路由、干预、原始流采集 | 大正文 tee 到 content；转发与写盘错误语义独立记录 |
| 新 `runner/server.mjs` | 独立 HTTP 重放、批量调度、脚本宿主、运行日志 | 经 SDK 调动作；用户脚本不能取得主进程对象；独立进程本身不是安全沙箱 |
| 新 `indexer/server.mjs` | 分块提取、搜索索引材料、资源/接口统计计算 | 元数据由 storage 提交；避免第二个任意 SQL 写者；任务可取消 |
| 现有 `control/server.mjs` / `mcp/server.mjs` | 协议适配、认证、订阅、结构化错误 | 不复制领域业务；控制 token 不写 URL 查询串 |

初期沿用现有 CDP pipe。终端崩溃后通常不能假设重新接上旧 pipe：恢复器核对进程身份、标记不可接管，提供关闭并重新启动受管浏览器的明确流程，不静默杀用户普通 Chrome。若未来要求“终端重启而 Chrome 持续受控”，另立 ADR 引入独立 browser-host；本计划的恢复目标可通过受控重启完成，不宣传无缝重连。

### 2.3 三条实际接线链路

- 打开工作区：`WorkspaceSwitcher` → `preload.execute('workspace.open')` → `actions/workspace.ts` → `workspace/service.ts` → 目录租约与期望配置 → `browser/manager.ts` → `runtime.ts` → Collector/CaptureCoordinator → 状态事件 → 首页投影。HTTP/MCP 进入相同 registry。
- 全量采集：Collector 提供请求身份；来源适配器发送字节到 content；content 完成片段并回报 manifest；storage 在事务中登记 body_refs 与完整性；renderer 只收 ID/预览和进度。请求行与正文到达顺序可交换，以稳定 requestId 关联。
- 重放与测试：DetailPanel 创建 RequestTemplate → ReplayWorkbench 编辑新版本 → `replay.run` 冻结身份/代理/变量/正文引用 → runner 或浏览器执行器 → 采集关联 runId → assertions → TestReport；任何一步可追溯原始请求而不覆盖它。

## 3. 目标代码目录与共用契约

新增领域文件仅在其阶段创建，禁止一次性生成几百个空壳。沿用 root 下 `.mjs` 的独立进程源文件；主应用领域继续 TypeScript。跨边界 schema 由构建脚本产出 JS/JSON，不让 Node 进程直接 import 未编译的 TS。

### 3.1 M0 必须建立的公共文件

| 操作 | 文件 | 职责与接入点 |
| --- | --- | --- |
| 新增 | `src/shared/contracts/identity.ts` | Workspace/Profile/Browser/Tab/Capture/Request/Run ID 与 TargetRef；CDP sessionId 另命名不混用 |
| 新增 | `src/shared/contracts/action.ts` | schemaVersion、action、target、params、expectedVersion、idempotencyKey、timeout、完成条件 |
| 新增 | `src/shared/contracts/result.ts` | status、observedState、warnings、evidenceRefs、稳定错误码、mayHaveEffect |
| 新增 | `src/shared/contracts/task.ts` | queued/running/waiting/succeeded/failed/cancelled/unknown；游标、取消与任务租约 |
| 新增 | `src/shared/contracts/workspace.ts` | 生命周期、登录证据、插件期望/实际、检查点、数据新鲜度 |
| 新增 | `src/shared/contracts/content.ts` | BodyRef、manifest、流、完整性、表示方式、范围读取、缺口原因 |
| 新增 | `src/shared/contracts/catalog.ts` | 全部动作的输入/输出 schema 与能力/风险标签，生成 API/MCP 描述的唯一源 |
| 修改 | `src/shared/types.ts` | 先 re-export 新类型并保留旧类型别名；阶段性删除重复定义，禁止两个同名模型各自演进 |
| 新增 | `src/main/application.ts` | 组合根、服务依赖与统一 shutdown 顺序；由 index.ts 启动 |
| 新增 | `src/main/actions/registry.ts`、`target-resolver.ts`、`policy.ts` | schema 校验、显式对象定位、作用域检查、版本冲突和动作许可 |
| 新增 | `src/main/actions/legacy-adapter.ts` | 旧 monitor 调用转到明确默认身份，运行前固定目标；多对象歧义返回错误 |
| 新增 | `src/main/tasks/service.ts`、`scheduler.ts`、`events.ts` | 持久任务、按对象串行、事件游标、取消、未知结果与重试限制 |
| 新增 | `storage/repositories/tasks.mjs` | M0 落地 task/幂等/事件/outbox 基础；M8 在同一文件扩展流程恢复，不能另建第二套任务真相 |
| 新增 | `src/main/ipc/register.ts` | preload 白名单 execute/query/subscribe；校验 sender、输入与订阅范围 |
| 修改 | `src/main/index.ts`、`src/preload/index.ts`、`src/renderer/src/env.d.ts` | index 只装配；preload 暴露最小桥；所有窗口/Agent 使用一致结果结构 |
| 修改 | `src/main/control/bridge.ts` | `attach(Controller)` 逐步改为 attach(ActionRegistry)；保留旧状态装饰适配 |
| 修改 | `control/server.mjs`、`mcp/server.mjs` | 先新增版本化入口，旧路由转发；清单从生成的 catalog 读取 |
| 新增 | `scripts/generate-contracts.mjs`、`scripts/build-runtime.mjs`、`tsconfig.runtime.json` | 生成 schema、声明和独立进程 bundle；开发/打包走同一链路 |
| 生成 | `runtime-dist/contracts/catalog.json`、`runtime-dist/contracts/index.mjs` | 由 schema 源生成，不手改；CI 检查生成物一致性 |

`TargetRef` 最少包含 workspaceId、profileId；浏览器动作增加 browserId、generation、tabId/frameId（按动作要求）；资源动作使用 artifactId/requestId。版本是领域对象版本，不拿时间戳当并发锁。无副作用的查询允许显式跨工作区范围，写动作不接受模糊的“当前全部”。

动作提交幂等键按 workspace + action + key 唯一，并保存输入 hash。相同 key 不同输入返回冲突；相同输入返回原 task，不盲目再次发出网络请求。恢复发现远端结果不明时记 unknown，不能推断“没响应就是没执行”。

### 3.2 构建及依赖装载先行

| 文件 | 计划修改 |
| --- | --- |
| `package.json`、`package-lock.json` | 按阶段添加已验证依赖和 test/build 脚本；锁文件由包管理器生成；不在本文虚构精确最新版 |
| `electron.vite.config.ts` | 新 main 依赖显式 bundle，或明确复制其完整 runtime 依赖；建议 main/preload 仅 external electron 与 node 内置模块，移除“所有依赖都外置”的默认假设；preload 不引入领域实现 |
| `electron-builder.yml` | 原始 runtime 目录转为 `runtime-dist` 的受控资源清单；content/runner/indexer/generated schemas/SQL/许可证/Node 都进入包外 resources；先验证再移除旧资源映射 |
| `src/main/paths.ts` | 统一 resolveRuntimeFile 的逻辑名称映射；开发与打包不各写一套路径；新增进程均由此定位 |
| `src/main/storage/locate-node.ts` | 启动前探测打包 Node 的 sqlite、FTS5及需用 API；版本兼容清单不只检查“大于某个数字” |
| `tsconfig.node.json`、`tsconfig.web.json` | 覆盖新 contracts；renderer 禁止导入 main/Node 实现；runtime 另行 typecheck/checkJs |
| `.gitignore` | 排除 runtime-dist、测试数据、正文、用户 profiles；不得排除迁移 SQL、fixture 源、schema 源与锁文件 |

新 runtime 依赖用 esbuild 产出 `.mjs` bundle（Node built-ins 外置）；动态资源显式 copy。不得以“开发环境可以 import”替代便携包验收。不要先升级 Electron/React 再做领域重构；安全维护升级可独立 PR，并跑相同基线。

## 4. M1：完整正文、上传、实时流与存储改造

### 4.1 文件清单与插入点

| 操作 | 文件 | 功能与替换位置 |
| --- | --- | --- |
| 新增 | `src/main/capture/coordinator.ts`、`source-router.ts` | 统一 capture/request 身份、来源选择、覆盖报告；接 Collector 和 ProxyClient，不重复记录同一交换 |
| 新增 | `src/main/capture/fetch-arbiter.ts` | 合并采集/规则/探针 Fetch pattern，唯一拥有 pause→continue/fulfill/fail 的完成权 |
| 新增 | `src/main/capture/cdp-source.ts`、`proxy-source.ts`、`download-source.ts` | 来源适配；缓存/SW/下载/上传分别报告能力及字节表示，不默认一条路径包办 |
| 新增 | `src/main/capture/completeness.ts`、`coverage.ts` | 请求/响应/消息各自完整性；真实捕获字节、缺口、采集边界与来源冲突 |
| 新增 | `src/main/content/client.ts` | begin/append/finalize/abort/readRange；二进制流、有界缓冲和接收确认；主进程只协调 |
| 新增 | `content/server.mjs`、`writer.mjs`、`reader.mjs` | 接收流、分块 hash、范围读取、传输校验；不靠单次 Buffer.concat 累积整个正文 |
| 新增 | `content/manifest.mjs`、`recovery.mjs`、`gc.mjs` | 原子发布 manifest、启动恢复、隔离损坏片段、按 storage 授权可回收集合清理 |
| 新增 | `storage/db.mjs`、`storage/migrate.mjs`、`storage/repositories/content.mjs` | 提取连接/迁移；登记正文与引用；finalize 幂等，不把文件 rename 当 DB 事务 |
| 新增 | `storage/repositories/requests.mjs`、`streams.mjs` | 从原 OPS 分离请求与消息索引；分页/游标，payload 改引用 |
| 修改 | `src/main/browser/body-capture.ts` | 新入口委托 arbiter/source-router；保留规则和探针语义，去掉默认按大小/流跳过的产品策略 |
| 修改 | `src/main/browser/collector.ts` | onRequestWillBeSent/onWsFrame/onEvent 传原始片段到内容链路；列表预览与原文引用分开；重定向每跳独立 |
| 修改 | `src/main/browser/script-capture.ts` | Debugger 可获得的源码进入 BodyRef；采集失败保留证据；并发限制不能替代源码完整性 |
| 修改 | `src/main/storage/client.ts` | 删除大正文队列/base64/hash 职责；元数据有界批处理、ACK、水位和失败账本 |
| 修改 | `src/main/controller.ts`：`onBody/getBody/fetchBodyNow` | 接 coordinator/content；按 requestId 与 generation 查找，不再仅依赖当前 seq |
| 修改 | `proxy/server.mjs`、`src/main/proxy/client.ts` | 上传/下载流 tee；代理 body 事件改 manifest/ref；重写缓冲上限不成为采集上限 |
| 新增 | `proxy/capture-tee.mjs` | 背压、短写、磁盘满与中断；捕获失败是否停网络由显式策略决定，失败必须反映缺口 |
| 修改 | `storage/server.mjs`：`appendBodies/getBody/prune/exportHar/exportBodies` | 旧 BLOB 兼容读；新正文走内容服务；导出转后台流式任务；prune 不静默淘汰有引用原文 |
| 新增 | `src/main/actions/content.ts` | 内容范围读、下载/导出、完整性、采集健康；给 UI/API 同一入口 |
| 新增 | `src/renderer/src/components/content/BodyViewer.tsx`、`ContentHealth.tsx` | 分块文本/JSON/二进制/媒体预览、继续读取与完整下载；不在渲染线程解析巨文件 |
| 修改 | `src/renderer/src/components/DetailPanel.tsx`、`WsPanel.tsx`、`ScriptPanel.tsx`、`RequestTable.tsx` | 接 BodyRef 和完整性标记；响应、上传和消息原文均可取回 |

### 4.2 采集技术验证，不得跳过的技术门槛

在 `scripts/probes/capture-paths.mjs` 中比较：现有 Fetch、可用 CDP 正文/流接口、代理边转发边写盘，以及下载/缓存/SW 场景。每条路径报告页面是否正常消费、内存峰值、原文 hash、时序变化、压缩前后表示与未覆盖原因。Fetch 获取流后如何恢复页面消费必须通过 fixture 验证，不能只知道 API 名就切主路径。参考 [CDP Fetch 官方协议](https://chromedevtools.github.io/devtools-protocol/tot/Fetch/)。

如果标准接口无法完整取得某类内容，新增 `src/main/capture/browser-adapter.ts` 和 `docs/adr/0004-capture-coverage.md`，列出扩展辅助/浏览器定制方案、打包与维护成本，建立补齐测试；此时 M1 对该矩阵仍未达标。不得把全量降级成“只抓可抓的小响应”。

有界缓冲耗尽时：可背压的流执行背压；不能安全背压的浏览器事件报告 lost range 并触发停止/降速策略。默认完整采集不等于物理资源无限；绝不将丢弃后请求标 complete。长流的活跃片段和中断片段都能读取，最终 hash 仅在 EOF 后生成。

## 5. M2：工作区状态容器与多浏览器

### 5.1 后端文件与职责

| 操作 | 文件 | 功能与接入点 |
| --- | --- | --- |
| 新增 | `src/main/workspace/service.ts`、`machine.ts` | 创建/打开/保存/休眠/关闭/归档；串行状态转换，接 ActionRegistry 与 BrowserManager |
| 新增 | `src/main/workspace/profile-store.ts`、`lease.ts` | profile 唯一目录、所有权、目录管理锁、PID+启动时间+runId/generation 验证 |
| 新增 | `src/main/workspace/reconciler.ts`、`projection.ts` | 期望/实际/历史三分；进程/配置/任务对账；生成 UI/Agent 共享摘要 |
| 新增 | `src/main/workspace/checkpoint.ts`、`restore.ts`、`clone.ts` | 逻辑检查点与关闭后一致备份；分阶段恢复/回退；结构复制与带身份复制分开 |
| 新增 | `src/main/workspace/history.ts` | 访问/标签/下载/请求/脚本/笔记/报告统一索引和来源，不伪造采集前正文 |
| 新增 | `src/main/browser/manager.ts`、`runtime.ts`、`target-registry.ts` | Map<browserId, runtime>；运行级 CDP/Collector/规则；标签/iframe/worker 明确区分 |
| 修改 | `src/main/browser/launch.ts`、`locate.ts`、`cdp.ts`、`pipe-transport.ts` | 显式身份目录/代理/版本、进程退出回执、启动诊断与 generation 生命周期；不改变普通浏览器默认资料 |
| 修改 | `src/main/controller.ts` | 启动与运行方法迁入 runtime，查询与分析迁领域服务；剩余旧调用转 registry；新代码不再 import Controller |
| 新增 | `src/main/auth/service.ts`、`observer.ts`、`adapters/fixture.ts` | 登录台账；Cookie 线索与已验证身份区别；通用被动观察 + 受控站点验证 |
| 新增 | `src/main/extensions/service.ts`、`adapter.ts`、`reconciler.ts` | 插件清单、安装/启停/卸载任务、desired/observed、版本/权限漂移、重启与不支持原因 |
| 新增 | `src/main/extensions/companion-adapter.ts` | 技术验证通过后接自有辅助扩展；不得默认能静默安装任意第三方扩展 |
| 新增 | `storage/repositories/workspaces.mjs`、`profiles.mjs`、`auth.mjs`、`extensions.mjs`、`checkpoints.mjs`、`history.mjs` | 对应领域持久化；每个查询/写入校验 scope；事件与领域变更同事务 |
| 新增 | `src/main/actions/workspace.ts`、`browser.ts`、`auth.ts`、`extensions.ts` | describe/open/close/checkpoint/restore、对象枚举、认证验证、插件管理；风险与效果可见 |
| 修改 | `src/main/rules/store.ts`、`src/main/rules/engine.ts` | 按工作区/运行加载版本化规则，不共享可变全局实例；matcher/sandbox 保留经验证实现 |
| 修改 | `src/main/window/settings.ts`、`src/main/window/dock.ts` | 终端窗口设置与 workspace 布局分开；吸附明确目标 browserId，不随后台任务改变 |

### 5.2 工作区首页及界面迁移

| 操作 | 文件 | 人类体验/数据来源 |
| --- | --- | --- |
| 新增 | `src/renderer/src/workspace/WorkspaceShell.tsx`、`WorkspaceSwitcher.tsx` | 左侧工作区与八个工作台；顶部身份/浏览器/标签；切换仅改变焦点 |
| 新增 | `src/renderer/src/workspace/WorkspaceHome.tsx`、`WorkspaceSettings.tsx` | 登录站点、插件、历史、网络、任务、检查点；配置期望与生效结果分开 |
| 新增 | `src/renderer/src/workspace/AuthLedger.tsx`、`ExtensionsPanel.tsx`、`CheckpointPanel.tsx` | 证据时间/新鲜度、插件漂移与权限、备份覆盖范围、恢复预览与结果 |
| 新增 | `src/renderer/src/workspace/WorkspaceContext.tsx`、`useWorkspace.ts` | 聚焦工作区上下文、事件订阅；不是状态机权威；缓存 key 带 workspace/profile/generation |
| 新增 | `src/renderer/src/components/TaskDrawer.tsx`、`EvidenceLink.tsx`、`ScopeBadge.tsx` | 后台任务、取消/接管、可打开证据和当前查询范围，跨工作区结果有明显标签 |
| 新增 | `src/renderer/src/api/client.ts`、`useTask.ts`、`useEvents.ts` | preload 统一包装、游标续订、断线重建摘要；禁止切页时取消另一工作区任务 |
| 修改 | `src/renderer/src/App.tsx`、`App.css` | 变为壳与主题；选中请求改 requestId；网络面板进入工作台 |
| 修改 | `src/renderer/src/components/PaneGrid.tsx`、`SessionsPanel.tsx` | 自由分栏作为高级视图保留；Sessions 展示 capture/运行历史，不冒充 WorkspaceManager |
| 修改 | `src/renderer/src/hooks/useRequests.ts`、`src/renderer/src/format.ts` | 查询、分页和事件按 scope 隔离；切换时丢弃旧请求回包，保留该工作区草稿与滚动 |

状态机沿用产品计划：creating/closed/opening/running/checkpointing/suspended/recovering/error/archived。在线逻辑检查点回 running；工作区休眠完成必须所有所属浏览器退出。站点登录、插件同步和任务是正交子状态，不用笛卡尔积枚举。登录恢复后 stale；插件配置不可导出时必须列在备份未覆盖清单。

插件可行性需要 `scripts/probes/extension-management.mjs` 与 `fixtures/extensions/state-probe/manifest.json`、`background.js`、`options.html`：枚举、启停、版本/权限变化、配置重启保留。自有受控辅助扩展候选路径为 `browser-extension/manifest.json`、`background.js`、`bridge.js`；来源/安装策略/权限经过验证才进入发布资源。Chrome 的 management 能力处于扩展 API 权限与交互约束中，并不等于桌面端能任意静默安装扩展。参考 [Chrome management 官方文档](https://developer.chrome.com/docs/extensions/reference/api/management)。

## 6. M3–M4：代理、环境、存储编辑与浏览器控制

### 6.1 M3 文件改造

| 操作 | 文件 | 功能与插入点 |
| --- | --- | --- |
| 新增 | `src/shared/contracts/environment.ts` | ProxyConfig、RouteRule、EnvironmentVersion、SecretRef、AppliedConfig |
| 新增 | `src/main/environment/service.ts`、`resolver.ts`、`secrets.ts` | 工作区模板→身份覆盖→运行冻结；秘密由 OS 加密保护，摘要仅引用 |
| 新增 | `src/main/proxy/manager.ts`、`diagnostics.ts` | 每身份/路由配置的代理进程及端口；HTTP/SOCKS 上游、认证、DNS/出口检测 |
| 新增 | `proxy/upstream.mjs`、`routing.mjs`、`config.mjs` | 按配置版本选直连/HTTP CONNECT/SOCKS；超时、认证、TLS、回退策略 |
| 修改 | `proxy/server.mjs`、`cert.mjs`、`src/main/proxy/client.ts`、`rules.ts` | 流水线插路由与诊断；证书指纹/密钥受管；不隐式关闭上游 TLS 校验 |
| 修改 | `src/main/browser/launch.ts`、`src/main/index.ts` | 不再全局 MONITOR_PROXY 决定所有浏览器；应用配置并记录是否必须重启 |
| 新增 | `storage/repositories/environments.mjs`、`src/main/actions/environment.ts` | 版本、引用和生效读回；任务记录实际出口与代理版本 |
| 新增 | `src/renderer/src/environment/EnvironmentWorkbench.tsx`、`ProxyEditor.tsx`、`ProxyDiagnostics.tsx` | 路由路径、凭据引用、测试与应用结果；直连/失败/待重启不混淆 |
| 修改 | `src/renderer/src/components/EnvPanel.tsx`、`RulePanel.tsx` | 原环境观测与规则编辑接新的工作区范围，不重复新建第二份规则存储 |

代理认证密码不进启动参数、普通日志或导出模板。秘密可由 Electron safeStorage 包装本机主密钥/密文；跨机导出单独要求用户提供可移植加密方案，禁止宣称复制文件即可解密。多实例共享代理只允许不可变配置与严格流归属均已验证的优化，首版优先每身份隔离。

### 6.2 M4 文件改造

| 操作 | 文件 | 功能与插入点 |
| --- | --- | --- |
| 新增 | `src/main/site-storage/service.ts`、`snapshot.ts`、`restore.ts` | Cookie/local/session/IDB/Cache/SW 统一入口；范围、快照差异、恢复协调和验证 |
| 修改 | `src/main/browser/site-data.ts` | 扩展现有读写能力；完整值与预览分离；storageKey/partition/frame 上下文显式 |
| 新增 | `src/main/site-storage/cookie-codec.ts`、`import-export.ts` | Cookie schema、格式转换与导入预检；保存后读回/实际携带验证 |
| 新增 | `src/main/browser/tabs.ts`、`downloads.ts`、`waits.ts` | 新建/关闭/导航/分组，上传下载任务，事件条件等待与超时 |
| 修改 | `src/main/browser/automation.ts`、`dom.ts`、`screenshot.ts`、`collector.ts` | 显式 Tab/Frame、document generation、失效元素引用、对话框归属与完成条件 |
| 新增 | `src/main/auth/adapters/registry.ts`、`session-probe.ts` | 可版本化站点认证检查，不把任意 401 判整个身份退出；用户自定义检查经过权限约束 |
| 新增 | `src/main/actions/site-storage.ts`、`storage/repositories/site-storage.mjs` | 审计、快照和范围化镜像；Cookie 修改事件触发 auth stale |
| 新增 | `src/renderer/src/storage/StorageWorkbench.tsx`、`CookieEditor.tsx`、`StorageEditor.tsx`、`StorageDiff.tsx` | 新增/编辑/批量导入/导出，分区、JSON 校验、恢复预览和失败项 |
| 新增 | `src/renderer/src/browser/BrowserWorkbench.tsx`、`TabTree.tsx`、`DownloadPanel.tsx` | 浏览器及目标树、预览、控制与下载；历史标签与活跃标签区分 |
| 修改 | `src/renderer/src/components/SitePanel.tsx`、`DomPanel.tsx` | 复用已有扫描与 DOM 展示，接领域服务；SitePanel 保留站点概览，不再兼任巨型存储编辑器 |

更改 Cookie/storage 后必须校验实际浏览器值、作用域和登录新鲜度；sessionStorage 与具体页面上下文关联，不能按 origin 全局还原。上传使用受管文件引用与用户选择，不让远程网页指定任意本地文件。下载路径经过规范化，防止文件名逃逸工作区目录。

## 7. M5–M6：请求重放、批量测试与脚本

### 7.1 M5 单次重放

| 操作 | 文件 | 功能与插入点 |
| --- | --- | --- |
| 新增 | `src/shared/contracts/replay.ts` | RequestTemplate/Collection/BodySpec/ExecutorMode/IdentityPolicy/ResolvedRequest |
| 新增 | `src/main/replay/service.ts`、`template.ts`、`resolver.ts` | 从原始请求派生模板；版本化编辑；发送前冻结代理、变量、身份与正文引用 |
| 新增 | `src/main/replay/browser-executor.ts` | 在明确 Tab/Frame 执行浏览器语义请求；报告 CORS、受限 header、SW、Cookie 与模式约束 |
| 新增 | `src/main/replay/runner-client.ts`、`cookie-policy.ts` | 独立执行器桥接；captured/live/explicit Cookie 优先级，禁止隐式回写浏览器 jar |
| 新增 | `src/main/replay/import-har.ts`、`import-curl.ts` | 有界流式解析、预检与模板创建；cURL 作为数据解析，绝不通过 shell 执行粘贴命令 |
| 新增 | `src/main/replay/diff.ts`、`src/main/actions/replay.ts` | 状态/header/结构/字节差异；原请求与实际执行关联；任务查询与取消 |
| 新增 | `runner/server.mjs`、`http-executor.mjs`、`body-reader.mjs`、`cookie-jar.mjs` | 独立 HTTP 流式请求、重定向、正文输入/输出引用、显式 Cookie jar |
| 新增 | `storage/repositories/templates.mjs`、`collections.mjs`、`runs.mjs` | 模板版本、集合顺序、运行冻结输入、请求/响应和未知结果 |
| 新增 | `src/renderer/src/replay/ReplayWorkbench.tsx`、`RequestEditor.tsx`、`BodyEditor.tsx`、`ReplayResult.tsx` | 全宽 URL/query/header/body/身份编辑、发送前预览、运行结果及 diff |
| 修改 | `src/renderer/src/components/DetailPanel.tsx`、`EndpointsPanel.tsx` | “发送到重放/加入集合”；携带 requestId/workspaceId，不复制截断预览当正文 |

BodySpec 使用 tagged union：none/text/json/form/multipart/contentRef；multipart 文件与二进制引用由内容服务提供重开读取能力。重复 query/header 保留有序数组，不转普通对象丢值。修改正文后重算 Content-Length/编码语义，保留 raw bytes 与 decoded 表示，不把压缩头配到解码正文上。

浏览器执行器和独立 HTTP 执行器必须有不同能力报告；实现不能承诺字节级复制浏览器 TLS/HTTP 指纹。独立模式将实际发送的头、重定向、Cookie、协议、输入 hash 记入 run；敏感值仅在授权详情显示。请求签名/CSRF/nonce 由明确前置脚本刷新，缺失时给出可解释错误。

### 7.2 M6 批量与脚本

| 操作 | 文件 | 功能与插入点 |
| --- | --- | --- |
| 新增 | `src/shared/contracts/testing.ts` | Dataset、Case、Assertion、BatchPolicy、ScriptVersion、RunSummary |
| 新增 | `src/main/testing/service.ts`、`datasets.ts`、`report.ts` | 测试套件/数据集/版本；执行数量预估、批量任务、汇总与结果资源 |
| 新增 | `runner/batch.mjs`、`rate-limit.mjs`、`retry-policy.mjs` | N 次、并发、间隔、速率、停止条件、取消/在飞请求状态；独立算 attempt 与 case |
| 新增 | `runner/assertions.mjs`、`variables.mjs`、`metrics.mjs` | 状态/header/JSON 路径/schema/body/存储/时间断言；作用域和延迟分位数 |
| 新增 | `runner/script-host.mjs`、`script-worker.mjs`、`sdk.mjs` | 前/后置脚本、日志、资源限制、SDK RPC；每脚本/运行隔离变量，异常不炸采集 |
| 新增 | `src/main/scripts/service.ts`、`permissions.ts`、`src/main/actions/testing.ts` | 版本、权限预检、执行租约、代码变更后重新确认范围；提供 Agent 入口 |
| 新增 | `storage/repositories/testing.mjs`、`scripts.mjs` | 数据集、脚本版本、测试断言、case/attempt、冻结结果与日志引用 |
| 新增 | `src/renderer/src/testing/TestWorkbench.tsx`、`BatchConfig.tsx`、`DatasetEditor.tsx`、`AssertionEditor.tsx`、`TestReport.tsx` | 显式组合方式/总量，运行矩阵、失败分组、逐条证据、p95 的样本数 |
| 新增 | `src/renderer/src/scripts/ScriptEditor.tsx`、`ScriptConsole.tsx` | 代码补全/示例、权限与日志；不同于现有“捕获站点 JS”的 ScriptPanel |
| 扩展 | `src/main/tasks/scheduler.ts`、`src/renderer/src/components/TaskDrawer.tsx` | 批量进度、取消、暂停/继续条件；队列时间与网络时间分开 |

变量规则：工作区环境 → 集合 → run → case → step，后者覆盖前者但不自动持久写回；并发 case 不共享可变对象。结果包含 planned/started/completed/cancelled/notStarted/unknown 数量，重试单独计 attempt，禁止将“100 次运行”误显示为“成功 100 个业务写入”。

脚本首版是用户信任的本地代码运行模式，并明确其能力。独立进程 + 超时/内存上限只能改善可靠性，不能宣称防御恶意代码。任意第三方不可信脚本要先通过独立安全评审：受限解释器/OS 隔离、禁止裸 Node import、文件网络经 SDK、逃逸测试；未完成前不开放自动下载并执行脚本。已有 rules sandbox 不直接当新测试运行器的安全保证。

## 8. M7–M9：资源研究、工作流和智能能力

### 8.1 M7 站点/资源/接口资产化

| 操作 | 文件 | 功能与插入点 |
| --- | --- | --- |
| 新增 | `src/shared/contracts/resources.ts`、`sites.ts` | ResourceVersion、Visit、EndpointRevision、EvidenceEdge、Note |
| 新增 | `src/main/resources/service.ts`、`versions.ts`、`search.ts`、`export.ts` | URL/内容版本、资料目录、分块检索、导出任务、来源关系 |
| 新增 | `src/main/sites/service.ts`、`endpoints.ts`、`relations.ts` | 站点档案、接口模板归类与人工纠正、统计范围、事实/推断关系 |
| 新增 | `indexer/server.mjs`、`extract.mjs`、`text-chunks.mjs`、`aggregate.mjs` | 背景文本提取、分段索引、接口统计及可取消大分析；进程调度低于采集 |
| 新增 | `storage/repositories/resources.mjs`、`sites.mjs`、`analytics.mjs`、`search.mjs` | 资源/访问引用，分块 FTS，接口版本与聚合结果；每结果带范围/版本 |
| 修改 | `storage/server.mjs`：`buildContract/endpointProfiles`、关系分析与导出段 | 将已有算法迁上述 repository/后台计算，保持旧 fixture 结果再增强；不是另起重复分析数据库 |
| 新增 | `src/main/actions/resources.ts`、`sites.ts` | search/list/version/diff/export/endpoint.merge/split/note；导出也是 task |
| 新增 | `src/renderer/src/resources/ResourceWorkbench.tsx`、`ResourceTree.tsx`、`ResourceGrid.tsx`、`ResourceDiff.tsx` | 站点/批次/类型视图，图片/媒体/源码，固定版本与完整取回 |
| 新增 | `src/renderer/src/sites/SiteDossier.tsx`、`EndpointEditor.tsx`、`EvidenceGraph.tsx` | 站点档案、纠正接口归类、关系图与列表互切、点击回证据 |
| 修改 | `src/renderer/src/components/EndpointsPanel.tsx`、`GraphPanel.tsx`、`StatsPanel.tsx`、`Waterfall.tsx` | 复用原图表，接 scope/运行比较/新索引；统计样本与排除项可见 |

接口自动归类不是不可逆迁移：自动建议、用户覆盖、算法版本分开保存。资源源文件与分析摘要分离；索引坏了可重建，原始采集证据不可由摘要重造。中文文本搜索要在 M7 验证分词/子串效果；FTS5 默认配置不等于满足中文使用体验。

### 8.2 M8 工作流与 Agent 协作

| 操作 | 文件 | 功能与插入点 |
| --- | --- | --- |
| 新增 | `src/shared/contracts/workflow.ts` | 有版本的节点/边、变量、等待条件、重试、安全边界与检查点 |
| 新增 | `src/main/workflow/service.ts`、`engine.ts`、`recovery.ts`、`handoff.ts` | 持久 DAG/顺序流程；调既有 actions；等待事件、人类接管、恢复不重发未知写动作 |
| 新增 | `storage/repositories/workflows.mjs` | 流程版本、节点执行与运行引用 |
| 扩展 | `storage/repositories/tasks.mjs` | M0 基础上扩展事件游标、租约 fencing、流程任务快照及恢复点 |
| 新增 | `src/main/actions/workflow.ts`、`capabilities.ts` | 工作流执行/检查/取消/接管，按浏览器/身份能力报告可行动作 |
| 新增 | `src/renderer/src/workflow/WorkflowWorkbench.tsx`、`WorkflowEditor.tsx`、`RunTimeline.tsx`、`HandoffPanel.tsx` | 图形编辑 + 等价表格编辑；时间线/结果/证据/暂停接管 |
| 新增 | `cli/server.mjs` | 本地 CLI 调用版本化 HTTP actions；支持 JSON 输出、等待游标与退出码，不再实现一套业务 |
| 修改 | `control/server.mjs`、`mcp/server.mjs`、`src/main/control/bridge.ts` | 长任务立即返回 taskId；状态/事件/wait/result/cancel；内容按引用与范围读取 |
| 修改 | `src/preload/index.ts` | UI 对相同 taskId 订阅；打开证据深链接，跨工作台定位对象 |
| 扩展 | `src/renderer/src/api/client.ts` | 订阅/深链接/长任务恢复沿用 M2 创建的统一客户端 |

M0 的任务基础不能拖到 M8；M8 是把已交付动作组合成持久流程。工具权限按工作区/动作/资源范围授权；计划执行前展示外部写入风险，人工接管使旧执行租约失效。网页和捕获脚本属于不可信输入，不得影响 Agent 的授权范围或偷换工作区。

### 8.3 M9 智能档案、高级协议与实验

| 操作 | 文件 | 功能与插入点 |
| --- | --- | --- |
| 新增 | `src/main/intelligence/service.ts`、`evidence-builder.ts`、`provider.ts` | 选择工作区证据、生成可追溯摘要/异常解释/测试建议；模型供应商可替换，不绑定单一云 |
| 新增 | `src/main/intelligence/redaction.ts`、`review.ts` | 发送模型前预览/脱敏/范围；总结版本、人工纠正与事实/推断标记；无模型也能访问原始档案 |
| 新增 | `resources/prompts/site-summary.md`、`test-suggestions.md` | 版本化提示模板；要求证据 ID 和不确定项，不允许模板直接执行动作 |
| 新增 | `runner/ws-executor.mjs`、`sse-executor.mjs` | 消息脚本、等待/断言、关闭/重连/取消，保存消息方向/时间和会话边界 |
| 新增 | `src/main/experiments/network.ts`、`offline.ts` | 断网/延迟/错误/阻断实验；按资源 manifest 进行可验证离线回放 |
| 修改 | `src/main/rules/engine.ts`、`proxy/server.mjs` | 故障计划作用域与实际生效事件，隔离其他工作区；实验完成恢复此前配置 |
| 扩展 | `src/main/browser/runtime.ts` | 为 M9 实验接入浏览器网络模拟及配置读回，结束时恢复此前版本 |
| 新增 | `storage/repositories/intelligence.mjs`、`experiments.mjs`、`src/main/actions/intelligence.ts`、`experiments.ts` | 总结/纠正/实验版本和证据引用；生成建议与执行测试分开动作 |
| 新增 | `src/renderer/src/intelligence/InsightPanel.tsx`、`EvidenceReview.tsx`、`ExperimentPanel.tsx` | 对比变化、证据跳转、纠正、测试建议预览与实验状态 |

离线回放必须显示缺失资源、动态 API、登录/跨域/SW 限制；资源导出成功不等于站点离线行为完整。模型只能生成待审阅模板或调用已授权动作；不能在总结阶段静默重放请求。可选本地模型/向量检索须由可测收益决定，不作为 V1 必须启动的后台服务。

## 9. M10 与贯穿全程的交付工程

| 操作 | 文件 | 功能/时点 |
| --- | --- | --- |
| 新增 | `src/main/maintenance/backup.ts`、`restore.ts`、`diagnostics.ts` | 数据根整体备份、兼容恢复、脱敏诊断包；M2 有基础，M10 完成长期交付版 |
| 新增 | `scripts/build-manifest.mjs`、`verify-runtime.mjs`、`check-licenses.mjs` | commit/dirty/build时间/Node/Chrome适配/依赖/hash/许可证；校验包外资源和来源 |
| 生成 | `resources/runtime-manifest.json` | 构建来源与资源hash；不把凭据或资料写入安装包 |
| 新增 | `THIRD_PARTY_NOTICES.md` | 记录依赖再分发声明，随依赖版本更新 |
| 新增 | `scripts/test-upgrade.mjs`、`test-recovery.mjs`、`test-soak.mjs`、`test-packaged.mjs` | 升级回退、故障注入、24h/72h、无全局 Node/无仓库依赖的便携包验证 |
| 修改 | `scripts/app-harness.mjs` | 独立临时数据根、运行清单、显式子进程跟踪、日志与证据定位、可靠清理 |
| 修改 | `scripts/verify-completeness.mjs` | 新能力和限制逐条对照；拒绝以旧通过数量替代新功能完成度 |
| 修改 | `electron-builder.yml`、`package.json`、`README.md` | 完整构建流程、版本与产物标记、便携升级方法；签名政策与发布校验 |
| 修改 | `docs/设计文档.md`、`技术方案.md`、`多会话监视器设计.md`、`AI-控制面.md`、`使用手册.md`、`P4-P7-待办与阻塞.md` | 每阶段同步旧决定变更、新架构、协议兼容、使用流程和完成证据；旧计划标历史，不静默覆盖历史结论 |
| 新增 | `docs/architecture/implementation-map.md`、`storage-layout.md`、`action-protocol.md`、`recovery-runbook.md` | 开发启动时将本文纳入仓库文档体系；明确一份当前权威，不让 outputs 与 docs 长期独立修改 |

维护工作贯穿 M0 起；M10 是集中验证，不是到最后才做迁移、打包和安全。发布签名/更新下载属于未来实施范围，本轮不申请证书、不签发发布、不上传用户数据。

## 10. 存储结构、数据目录与迁移方案

### 10.1 数据根布局

默认继续使用现有 DATA_DIR 机制；代码只通过新的 `src/main/workspace/profile-store.ts` 与 `src/main/paths.ts` 解析，不把用户机器绝对路径写入可移植模板。

```text
<DATA_DIR>/
  monitor.db                         # 延续现有名称，迁移后的唯一元数据写库
  monitor.db-wal / monitor.db-shm     # SQLite 管理；不能手工当备份遗漏
  workspaces/<workspaceId>/
    profiles/<profileId>/chromium/   # 可变身份目录；仅一个受管写进程
    downloads/                      # 完成下载可另登记 content 引用
    exports/                        # 用户明确导出的副本
  content/
    chunks/<prefix>/<chunkHash>      # 不可变分块
    manifests/<bodyId>.json          # 版本化提交清单，DB 引用后才可见为完整
    staging/<writeId>/               # 接收中片段及恢复日志
    quarantine/                     # hash/长度异常待诊断，不当作正常正文
  checkpoints/<checkpointId>/        # manifest + 身份备份；资源以固定引用复用
  backups/<backupId>/                # 数据迁移/升级前一致备份
  runtime/                          # 本次进程端点、租约、token；不导出
  secrets/                          # OS 保护的密文，不作明文 json
  logs/                             # 脱敏运行日志，轮转不影响原始证据
  ui-settings.json                  # 终端窗口级偏好；工作区布局存库
```

正文可跨工作区物理去重，但 BodyRef 的访问授权始终检查 workspace 归属。仅知道 hash 不足以读取另一工作区文件。若以后要求每工作区独立加密密钥/彻底密码学隔离，改为按密钥域去重，不能保持跨域去重同时承诺该隔离。

### 10.2 表设计：字段、索引与归属

以下为逻辑 schema，SQL 在相应迁移中落实。所有业务 ID 建议 UUID；旧数字 inst/seq 保留为兼容标识。scope 不依赖 UI 传入可信值：服务和 repository 都校验对象实际归属。

| 表/组 | 关键字段与约束 | 主要索引/用途 | 阶段 |
| --- | --- | --- | --- |
| `schema_migrations`、`migration_jobs` | version/checksum/appliedAt；job/cursor/status/sourceVersion | 唯一版本；文件回填可续跑 | M0 |
| `workspaces` | id/name/state/version/defaultProfileId/createdAt/archivedAt | state、updatedAt；defaultProfile 必须属于本 workspace | M0基础/M2 |
| `browser_profiles` | id/workspaceId/path/desiredConfigVersion/version | 规范化 path 唯一；(workspaceId,id) 唯一供复合外键 | M0基础/M2 |
| `browser_runs`、`capture_sessions` | browserId/profileId/workspaceId/generation/pid/startToken/state；captureId/startedAt/endedAt | profile+时间；运行代次唯一；旧实例映射 | M1/M2 |
| `legacy_id_map` | kind/oldId/newId/workspaceId/sourceDbId | sourceDbId+kind+oldId 唯一；旧 inst 不推断账号 | M0/M1 |
| `requests`（扩展旧表） | 稳定 id 对外映射、workspace/profile/browser/capture/run、redirectParent、正文引用 | workspace+capture+startTs+稳定ID；保留旧 inst/seq 约束至退役 | M1 |
| `bodies`（旧表只读过渡）、`content_objects` | 新 bodyId/state/representation/totalBytes/fullHash?/source/manifestVersion | hash+representation；不存在文件不能标 complete | M1 |
| `content_chunks`、`body_chunks` | chunkHash/size/path；bodyId/ordinal/offset/length/hash | bodyId+ordinal 唯一；连续区间、部分片段可校验 | M1 |
| `body_refs` | workspaceId/bodyId/ownerKind/ownerId/role/pinnedAt | owner+role；bodyId；存请求/脚本/流/检查点引用 | M1 |
| `stream_messages` | workspace/capture/connection/messageId/direction/opcode/time/bodyId/state | connection+time+id；替代 ws_frames.payload 大文本 | M1 |
| `workspace_events`、`event_outbox` | workspaceId/eventSeq/entityId/version/type/actor/generation/evidence/time | workspace+eventSeq 唯一；投影与订阅断点 | M0/M2 |
| `workspace_views`、`visits`、`tab_snapshots` | workspace/profile、视图布局/访问来源/恢复信息、采样时间 | workspace+时间；sessionStorage 另绑定页面上下文 | M2 |
| `site_identities`、`auth_observations` | workspace/profile/site/accountContext；lastState/checkState/checkedAt/evidenceRef | 身份+站点+上下文；历史观察追加，当前摘要可重建 | M2 |
| `extension_bindings`、`extension_observations` | workspace/profile/extensionId/desired/observed/permissions/configRef/status | profile+extensionId 唯一；状态版本+时间 | M2 |
| `checkpoints`、`checkpoint_refs` | workspace/type/coverage/manifestRef/compatibility/status | workspace+时间；固定 body 引用和完整性标记 | M2 |
| `environment_versions`、`proxy_configs`、`rule_versions`、`secret_refs` | workspace/version/configJson/secretRef；冻结配置 | workspace+对象+version 唯一；密文不存普通配置 | M3 |
| `cookie_snapshots`、`site_storage_snapshots` | workspace/profile/origin/storageKey/partition/context/valueRef/observedAt | Cookie 真实身份含 domain/path/name/partition；快照有覆盖范围 | M2隔离/M4编辑 |
| `templates`、`template_versions`、`collections`、`collection_items` | workspace/version/bodySpec/originRequestRef；集合顺序 | workspace+updatedAt；版本不可变、草稿乐观锁 | M5 |
| `tasks`、`runs`、`run_steps`、`artifacts` | workspace/target/inputVersion/status/leaseToken/effectState/contentRef | task状态+更新时间；幂等键唯一；证据可定位 | M0基础/M5扩展 |
| `datasets`、`scripts_v2`、`test_suites`、`test_cases`、`test_attempts`、`assertion_results` | 工作区/版本/数据与代码引用/运行统计 | run+case+attempt；scripts_v2 不与捕获 JS 的旧 scripts 表混名 | M6 |
| `resource_versions`、`resource_refs`、`sites`、`endpoint_revisions`、`relation_edges`、`notes` | URL/内容/访问关联、人工覆盖、算法版本、evidence/fact/inference | workspace+site+type+time；URL+hash不覆盖历史 | M7 |
| `search_chunks`、`search_fts`、`index_jobs` | workspace/body/chunkOffset/text/indexVersion/coverage | FTS5+scope 过滤；索引状态及未索引原因 | M7 |
| `workflow_versions`、`workflow_nodes`、`workflow_executions` | 工作区/流程版本/步骤/输入/恢复点 | workflowVersion+run；执行租约 | M8 |
| `insights`、`insight_evidence`、`insight_corrections`、`experiments` | 工作区/模型或算法版本/结论/证据/人类修正 | site+时间；实验配置版本 | M9 |

元数据事务内同时修改领域行、workspace_events 和 outbox，提交后通知。外部浏览器副作用是 task/saga，不在数据库事务里假装原子完成。scope 关键关系使用 `(workspace_id,id)` 复合外键或等价强制校验；打开 foreign_keys 并测试。核心查询一律以 scope 开头，专门测试通过另一 workspace 的 ID 越界访问。

### 10.3 内容提交协议

1. content 分配 writeId，创建 staging；预登记 receiving 对象，保存 requestId/representation/source。
2. 流按建议 4MiB 初始块尺寸写入，hash、长度、offset 与回执分别记录；尺寸需负载测试调优，不是单正文上限。
3. 已持久片段可范围读取；未 EOF 的内容保持 receiving/interrupted，没有伪造 fullHash。
4. EOF 后验证片段连续性与预期长度（若语义可比较），发布不可变 manifest；fsync/rename 的平台行为做故障测试。
5. storage 收到幂等 finalize，在事务中登记 chunks/body_refs/complete；随后发布完成事件。写文件成功但 DB 未提交只算可恢复孤儿，不能提前显示完成。
6. 重启扫描“已提交 DB 却缺文件”“manifest 已发布但未被引用”“staging 未结束”；分别报损坏、重挂引用或隔离回收，绝不重发原网络请求补洞。

GC 以引用表为权威，不以缓存 refCount 作为唯一判断。先标候选、宽限期、再次检查任务/检查点/导出 pin 与写入租约，再由 content 删除并记录审计；不得误清 B 正在使用的共享文件。保留策略由用户设置，默认不按内部 LRU 删除历史唯一正文。

### 10.4 从 schema v8 的迁移步骤

迁移编号为计划预留，合并前读取实际当前版本，禁止覆盖其他已落地迁移。建议文件如下：

| 新增文件 | 迁移内容 | 回退/验收 |
| --- | --- | --- |
| `storage/migrations/009-foundation.sql` | workspaces/profiles/legacy映射/tasks/events/版本账本；默认“导入的旧环境” | 不改原始 inst；空库/v8/中断重入三类 fixture |
| `storage/migrations/010-content.sql` | body/chunk/ref/stream、请求稳定身份与 scope 索引 | 双读但仅新写；旧 BLOB 仍留存；引用一致性校验 |
| `storage/migrations/011-workspace-state.sql` | 运行、登录、插件、历史、检查点；全局 Cookie/site 迁 scope 表 | 无可靠身份来源的镜像放“历史未归属”记录，不复制成多个账号事实 |
| `storage/migrations/012-environments.sql` | 代理/环境/规则版本、SecretRef | rules.json 导入为一版，保留原文件；秘密单独迁移 |
| `storage/migrations/013-site-storage.sql` | 完整存储快照与值引用、分区/context | 旧被截断值标 incomplete，不作为完整恢复来源 |
| `storage/migrations/014-replay.sql` | 模板/集合/run输入与输出/重放结果 | 原 requests 不覆盖，旧 API 经 legacy map 仍可查 |
| `storage/migrations/015-testing.sql` | 脚本/参数/断言/case/attempt | 捕获脚本与用户脚本不同表；变量秘密不写普通日志 |
| `storage/migrations/016-resource-index.sql` | 资源版本/接口归类/关系/FTS/索引任务 | 索引可删重建但原文不可清除；统计旧新结果对比 |
| `storage/migrations/017-workflows.sql` | 流程版本/执行状态 | 运行中旧任务保留版本，未知效果不自动重试 |
| `storage/migrations/018-intelligence.sql` | 智能结论/证据/修正/实验 | 模型结论不写回原始事实 |
| `storage/backfill-v8.mjs` | 分批旧 BLOB/source/WS payload→content；保存游标/hash/引用 | 可暂停恢复；原本 too_large/evicted/truncated 的数据标真实缺失 |
| `scripts/test-migrations.mjs` | 迁移前后数量、hash、外键、scope、失败/恢复与备份回滚 | 使用临时副本，不直接拿日常用户库做破坏性演练 |

流程：停止写入并取得维护锁 → 一致备份数据库及依赖资料（不能仅复制打开中的 .db 忽略 WAL）→ schema 事务 → 创建旧环境映射 → 分批内容回填 → 验证后切新读路径 → 记录兼容版本。大文件回填不放一个超长 SQLite 事务内。

旧版本启动新库应被兼容门禁拒绝，不允许其“ensureColumn”逻辑覆盖 schema_version。回退使用迁移前完整备份，在单独数据根验证；回退会丢失备份之后的新写入，必须预先导出/保留增量并告知。不能承诺任意版本无损降级。

M0/M1 先为唯一旧环境补 scope；在 M2 所有旧全局读写改完以前，多身份并发入口保持不可用并明确提示。不能只给新表加 workspaceId 而让旧 Cookie 查询继续返回所有账号。

## 11. 新框架、开源能力与资源引入清单

选型状态区分“保留”“拟引入”“条件引入”“暂不引入”。下列公开资料在 2026-09-22 核对；它们证明候选库的用途，不证明与本项目打包 Node/Electron 版本已经兼容。实施前记录精确版本、许可证/NOTICE、安全维护状态、体积、Node/TS 要求、离线安装与便携包验证。本轮未安装任何依赖。

### 11.1 依赖决策表

| 决策/阶段 | 能力与候选 | 插入文件 | 为什么用/验收门槛 |
| --- | --- | --- | --- |
| 保留，全程 | Electron/React/TypeScript + 自有 CDP transport | 现有主应用 | 不换桌面/前端框架；协议能力和目标定位在现有基础增强 |
| 保留，M0/M1 | 独立 Node `node:sqlite` | `storage/db.mjs` | 已有路径；不把 native SQLite 再塞回 Electron 主进程。使用实际打包 Node 支持的 API，不能照最新文档直接假定可用。[官方资料](https://nodejs.org/api/sqlite.html) |
| 拟引入，M0 | `zod` | `src/shared/contracts/*.ts` | 输入运行时校验、类型与 JSON Schema 一源；验证严格模式和生成 schema 覆盖契约，拒绝只做 TS 编译检查。[官方资料](https://zod.dev/) |
| 拟引入，M0/M2 | `xstate` 的验证后稳定版本 | `src/main/workspace/machine.ts` | 分层状态机/事件/守卫；DB 事务与副作用仍由 service 管理，不把 actor 内存快照当持久业务真相。不跟随 alpha 自动升级。[官方资料](https://stately.ai/docs/xstate) |
| 拟引入，M0 | `esbuild`（显式 devDependency） | `scripts/build-runtime.mjs` | 可重现构建独立 Node bundle；动态 SQL/资源仍须 copy，不能依赖 Vite 的传递依赖偶然存在。[官方资料](https://esbuild.github.io/getting-started/) |
| 条件引入，M3 | `https-proxy-agent` / `socks-proxy-agent` | `proxy/upstream.mjs` | 给 Node http/https transport 接上游；与 Undici Dispatcher 是不同接口，禁止直接混塞；测试 DNS、认证和断连。[官方仓库](https://github.com/TooTallNate/proxy-agents) |
| 保留系统能力，M3 | Electron `safeStorage` | `src/main/environment/secrets.ts` | 保护本机秘密；验证加密后端和不可用策略；不是正文数据库全盘加密，也不是跨机恢复方案。[官方资料](https://www.electronjs.org/docs/latest/api/safe-storage) |
| 拟引入，M5 | `undici` | `runner/http-executor.mjs` | 独立 HTTP 请求/流/连接管理；冻结兼容版本；与浏览器模式分开，不据此承诺 Chrome 协议/TLS 等价。[官方仓库](https://github.com/nodejs/undici) |
| 拟引入，M5 | `tough-cookie` | `runner/cookie-jar.mjs` | 独立 HTTP 模式的 Cookie jar；分区/SameSite/站点上下文与真实 Chrome 的差异逐项测试，不当浏览器 Cookie 数据库替代品。[官方仓库](https://github.com/salesforce/tough-cookie) |
| 拟引入，M5/M6 | CodeMirror 模块包（state/view/lang-json/lang-javascript 等按需） | 新增 `src/renderer/src/components/CodeEditor.tsx`；BodyEditor/ScriptEditor 复用 | 请求/脚本编辑体验；编辑器只装合理工作集，大正文用 BodyViewer 分块读。官方 GitHub 开发库已标迁址，锁版本时核对新上游；不复制整个开发仓库。[官方项目说明](https://github.com/codemirror/dev) |
| 拟引入，M6 | `ajv` | `runner/assertions.mjs` | 对用户提供的响应 JSON Schema 做断言；与 Zod 的内部动作契约职责分开；编译缓存、schema复杂度和超时需要限制。[官方资料](https://ajv.js.org/guide/getting-started.html) |
| 条件启用，M7 | SQLite FTS5 | `storage/repositories/search.mjs` | 不新增搜索服务器；检测构建是否包含 FTS5，测中文/代码/超大资源；索引范围与完整性可见。[官方资料](https://www.sqlite.org/fts5.html) |
| 条件引入，M8 | `@xyflow/react` | `WorkflowEditor.tsx`、`EvidenceGraph.tsx` | 可交互节点图，不承担工作流执行；表格编辑同样有效；10k关系用聚合/分页而非全部渲染。[官方资料](https://reactflow.dev/learn) |
| 拟引入，M9 | `ws` | `runner/ws-executor.mjs`、协议 fixture | WS 客户端/服务端测试；消息级与网络帧级真实性分开；SSE 另用流解析器。[官方仓库](https://github.com/websockets/ws) |
| 保留并扩展，M0起 | Node `node:test` + 现有验收脚本 | `tests/unit/`、`scripts/test-*.mjs` | 单测/集成不强制再引入整个测试框架；TS 单测先构建到 work 测试目录。[官方资料](https://nodejs.org/api/test.html) |
| 条件引入，M0起 | Playwright Electron 测试能力 | `tests/e2e/`、`scripts/test-packaged.mjs` | 补人类流程自动化；官方标实验性，必须在本项目版本验证；保留 app-harness 与现有 UI 测试备用。[官方资料](https://playwright.dev/docs/api/class-electron) |

HTTP transport 选择具体落地：独立直连/HTTP 代理优先验证 Undici 的 Dispatcher；SOCKS 通过明确 adapter 接 Node http/https + socks agent，或实现并测试兼容 connector。结果记录 transportKind，不能在 UI 背后静默切模式。URL、headers、Cookie 与正文的实际出站行为都由 origin fixture 确认。

暂不引入：Redis/Kafka/PostgreSQL（本机单用户不需要服务集群）、大型 ORM（先稳定 scope 和迁移）、全量 Redux 重构（React context+订阅足够先落地）、第二个独立代理产品替换现有实现（先完成兼容/流式验证）、向量数据库与特定 Agent 框架（证据索引与动作协议先行）。这些不是永久禁止；只有明确瓶颈、对比实验和 ADR 才改变。

### 11.2 非代码资源与 fixture

| 新增资源 | 放置路径 | 使用与管理 |
| --- | --- | --- |
| 能力/兼容矩阵 | `resources/capabilities/browser-matrix.json` | 浏览器版本、接口能力、扩展适配和已知缺口；附证据版本，不靠 UA 猜测 |
| 初始工作区模板 | `resources/templates/workspace-default.json`、`workspace-lab.json` | 非秘密默认配置；不包含用户 Cookie、代理密码或真实访问历史 |
| 测试/工作流模板 | `resources/templates/replay-suite.json`、`login-and-verify.json` | 用户可复制编辑；站点使用 fixture 域，不附通用真实账号 |
| 本地真值站点 | `fixtures/origin/server.mjs`、`payloads.mjs`、`auth.mjs`、`storage.mjs` | 动态生成确定性大小正文/上传回显/账号过期/分区存储；不把 1GB 样本提交 Git |
| 页面 fixture | `fixtures/pages/index.html`、`worker.js`、`service-worker.js` | iframe/worker/SW/cache/重定向/下载/DOM 等待；明确预期覆盖范围 |
| 流协议 fixture | `fixtures/streams/server.mjs` | SSE、WS、消息方向、断开/重连、大消息、未知长度流 |
| 代理 fixture | `fixtures/proxy/server.mjs`、`generate-cert.mjs` | CONNECT/SOCKS/认证失败/链路/延迟；测试证书临时生成，不提交私钥，不安装到用户系统证书库 |
| 扩展 fixture | `fixtures/extensions/state-probe/` | 版本、权限、设置持久化、请求修改；源文件入库，运行用户数据不入库 |
| 迁移 fixture | `fixtures/migrations/create-v8.mjs`、`expected.json` | 构建合成旧库、部分正文/全局镜像/重复 URL/分区数据；禁用真实 Cookie 样本 |
| 发布资源 | `.buildtools/node/`、`resources/runtime-manifest.json`、`THIRD_PARTY_NOTICES.md` | 固定来源/校验值/再分发许可；源码、构建产物、用户数据严格分开 |

## 12. 修改与删除边界：旧实现如何退出

本轮不删除任何项目文件。未来删除也不是“目录太大就删”，而是以替代入口、数据迁移、兼容期和回归证据为条件。

| 对象/文件 | 计划动作 | 替代位置 | 最早时点与删除门槛 |
| --- | --- | --- | --- |
| `src/main/controller.ts` | 先拆职责，再物理删除旧外观 | application + BrowserRuntime + 领域 services + legacy-adapter | M8 后候选/M10 前复核；无源代码 import，旧路由回归通过，控制/采集/分析功能逐项对照，不只查类名 |
| `src/main/browser/body-capture.ts` | 先适配，迁完后物理删除 | capture/fetch-arbiter + cdp-source + 原 rules/probe | M2 后候选；Fetch 请求唯一释放、规则/探针/全量采集矩阵全过；否则保留小适配器，不同时跑双拦截 |
| `storage/server.mjs` 中巨型 DDL、分析与导出函数块 | 删除已迁出的重复代码；保留 server.mjs 入口 | migrations/repositories/indexer/export service | 每个域独立迁移后；旧新输入输出对比通过，不删除旧 schema fixture |
| `src/main/storage/client.ts` 中 body base64 队列、主线程 hash、大正文牺牲策略 | 删除实现块 | content/client + content writer + completeness ledger | M1；大正文/上传/断连/磁盘满真值测试通过 |
| `src/main/index.ts` 全局 Controller 与运行配置单例代码块 | 删除并用组合根替换 | application + workspace/env resolver | M2/M3；多工作区配置不串台；启动参数兼容测试通过 |
| `collector.ts` 的请求/WS 原文 slice、`script-capture.ts` 的原文容量淘汰路径 | 删除其“原文限制”用途，预览限制可保留 | BodyRef/stream完整采集 | M1；完整源字节已确认落盘，不是简单删常量导致内存无界 |
| `storage/server.mjs` 的有引用 BLOB LRU 淘汰 | 删除默认行为；新留存策略独立 | body_refs + pin + retention/GC | M1；保留/删除语义及共享引用测试通过 |
| `bodies.blob`、`requests.req_body`、`ws_frames.payload` 等旧值列 | 先停写+兼容读，之后专门迁移清理 | content objects/refs/messages | M10 后经用户迁移确认与回退窗口；先证明全部可迁数据 hash 一致，缺失状态有记录 |
| 数据根旧 `rules.json`、`browser-profile/` | 导入/登记，非立即删除 | rule_versions / 工作区独立 profile | M2/M3；关闭浏览器后复制校验、保留可回退副本；任何运行中 profile 绝不移动 |
| `control/server.mjs` 的 query token 接受方式 | 兼容警告后移除；更新调用方 | Bearer header/安全订阅方式 | M0–M2；UI/SSE/MCP/脚本全部已迁；token不进入日志 |
| `src/shared/types.ts` 重复类型 | 逐项删定义，文件可保留 re-export | shared/contracts | 对应域迁移后，编译/生成schema/旧入口兼容测试通过 |
| `mcp/server.mjs` 手写重复 schema/route mapping | 删除重复块，不删 MCP 入口 | 生成 catalog + action adapter | M8；全部旧工具名有别名/迁移说明，兼容快照测试通过 |
| `electron-builder.yml` 原始 runtime 资源复制条目 | 删除旧映射，不删源文件 | runtime-dist bundle+资源清单 | M0 构建路径验证后；干净机器便携包可以定位每个进程/SQL/依赖 |
| 旧 `docs/P4-P7-待办与阻塞.md` 中互相矛盾的当前结论 | 标历史并链接新 ADR，不物理抹掉 | docs/architecture 与当前能力账本 | 每阶段同步，保留历史出处 |

明确保留：`pipe-transport.ts`、`cdp.ts`、已验证的 rules matcher/engine、proxy/correlate、win/dock-helper、已有网络/DOM/统计组件、原有测试 fixture 与验收脚本。PaneGrid、SessionsPanel、ScriptPanel 各有持续用途，不因为新工作台出现就删除。

旧测试若断言“大 body 必须跳过”应改为验证旧历史标记与新完整采集，不整份删除测试来得到绿灯。删除门槛检查同时覆盖 import、runtime 路径、MCP/HTTP、打包资源与用户数据迁移，单独 `rg` 无引用不证明完成。

## 13. 验证文件、阶段门槛与证据产物

### 13.1 新增与修改的测试入口

| 阶段 | 新增测试文件 | 核心真值 | 需持续运行的现有入口 |
| --- | --- | --- | --- |
| M0 | `tests/unit/contracts.test.mjs`、`state-machine.test.mjs`、`target-resolver.test.mjs`；`scripts/test-actions.mjs` | schema拒绝非法输入、代次失效、幂等冲突、旧调用歧义 | typecheck/build、test:control、test:smoke |
| M1 | `scripts/test-capture-full.mjs`、`test-content-store.mjs`、`test-content-recovery.mjs` | 256KB/100MB/1GB上传响应hash，SSE/WS原文，缓存/SW，失速/断写/GC引用 | test:storage、test:proxy、test:proxy:e2e、test:correlate、test:realtime、test:rules:e2e |
| M2 | `scripts/test-workspaces.mjs`、`test-auth-ledger.mjs`、`test-extensions.mjs`、`test-checkpoints.mjs` | A/B alice/bob、不同插件/history、双运行、目录锁、恢复与登录stale | test:sessions、test:sitedata、test:layout、test:dock、test:control |
| M3 | `scripts/test-environments.mjs`、`test-proxy-routing.mjs` | 实际出站路径/账号/认证失败；无静默直连；秘密不出日志 | test:proxy、test:proxy:e2e、test:rules |
| M4 | `scripts/test-storage-editor.mjs`、`test-browser-targets.mjs` | Cookie读回及请求携带、partition/IDB/cache、表单上传、下载、旧元素拒绝 | test:sitedata、test:input、test:dom、test:origin |
| M5 | `scripts/test-replay.mjs`、`test-imports.mjs` | origin收到的真实请求、重复header/multipart/二进制、两模式差异、原请求不变 | test:detail、test:control、test:smoke |
| M6 | `scripts/test-batch.mjs`、`test-script-runner.mjs`、`test-assertions.mjs` | 1/10/100 次、并发/重试计数、取消在飞、参数隔离、超时未知效果 | test:storage、test:control；原 test:scripts 仍测捕获脚本 |
| M7 | `scripts/test-resources.mjs`、`test-search.mjs`、`test-endpoint-versions.mjs` | 原文/版本/hash、中文搜索与索引缺口、人工纠正、跨scope拒绝 | test:analytics、test:ui-perf |
| M8 | `scripts/test-workflows.mjs`、`test-agent-workspace-drill.mjs` | UI/MCP/HTTP同run，等待/断线恢复/接管，不重发未知写请求 | test:drill、test:control、test:smoke |
| M9 | `scripts/test-insight-evidence.mjs`、`test-stream-replay.mjs`、`test-network-experiments.mjs` | 证据引用/纠正、模型不能越权、WS/SSE脚本、故障与离线缺口 | test:realtime、test:proxy:e2e |
| M10 | `scripts/test-upgrade.mjs`、`test-recovery.mjs`、`test-soak.mjs`、`test-packaged.mjs` | v8迁移、crash/disk-full/升级失败、24h/72h、独立便携包整流程 | 全部适用测试 + verify + page/ui perf |

表中的 `test:origin` 是拟在 package.json 增加的别名，对应已经存在的 `scripts/test-origin.mjs`；不能把文件存在误认为 npm script 已注册。新增文件都需要在 package.json 或总验证器显式登记，未接 CI 的测试不算阶段门槛。

新增 UI 流程文件：`tests/e2e/workspace.spec.ts`、`storage.spec.ts`、`replay.spec.ts`、`workflow.spec.ts`、`layout.spec.ts`。覆盖 900/1360/1920 CSS px、系统缩放、键盘、运行中切页、编辑草稿恢复、大数据量与错误态；由实际 UI 操作触发业务，不只调后台 API。截图/可访问性定位与任务证据关联。

每次验收产物写测试专用数据根：`manifest.json`（版本、机器、参数、fixture种子）、`origin-truth.jsonl`、`app-events.jsonl`、`checks.json`、UI截图及失败日志。大 fixture 动态生成，测试清理由 harness 验证绝对目录后执行，不扫用户 DATA_DIR。

### 13.2 必须新增的交叉验收

- 代理上传：当前 handleRequest 会收集 chunks 后 Buffer.concat；改造必须证实采集开/关、正文超旧阈值时服务器收到的上传都完整，不能让采集缓冲决定实际转发字节。
- 工作区隔离：不能只验证数据库加了 workspaceId；用独立服务端确认 alice/bob，检查实际扩展启用、目录锁、另一工作区内容访问被拒、切页不改任务 target。
- 宕机窗口：在“写片段前/后、manifest前/后、DB提交前/后、通知前/后”注入故障，证明不会虚报 complete、丢引用或误 GC。
- 恢复：当前运行先安全关闭、备份有效、临时恢复校验、失败回退；登录改 stale，旧 generation 动作拒绝；默认不自动提交历史表单。
- 取消与重试：服务器已收到但客户端超时的请求标 unknown；不自动重发业务写入；批量 planned=各终态+尚未执行数量。
- 原文/预览：下载结果 hash 对齐 fixture；折叠/省略号只是显示；原文不可被摘要、模型建议或人工编辑覆盖。
- 控制权限：本机 API 认证、Origin/CSRF 防护、路径规范化、scope校验、秘密脱敏；允许任务范围内的本地站点测试，不粗暴禁止所有内网 URL。
- 内容展示：捕获 HTML/脚本不在终端特权上下文执行；默认源码预览，交互预览在隔离沙箱且无 preload/Node 权限。Markdown/报告净化、外链协议白名单与资源读取 scope 均有测试，防止访问网页反过来控制终端。
- 打包：清空外部开发依赖的隔离环境启动便携包，确认 Node/每个 runtime/SQL/schema/模板可用；无源码仓库路径、无全局 npm 包假依赖。

每个里程碑至少通过：功能真值 + UI流程 + Agent等价动作 + scope隔离 + 崩溃/取消 + 打包运行。性能沿用产品计划目标：10万请求列表、1GB单正文/累计10GB、关键交互200ms反馈、取消2秒UI确认、24h/72h长稳，实际硬件与限制记录在报告；不是本文宣称已经达到。

## 14. 按 PR/任务执行的实施顺序

### 14.1 首批可领取任务（映射原计划 A01–A12）

每行可拆多个小 PR，但不能只交空文件。基础阶段优先做可运行纵向切片。

| 工程任务 | 对应 | 主要文件/产物 | 依赖 | 验收完成条件 |
| --- | --- | --- | --- | --- |
| E01 基线与能力账本 | A01 | 新 `docs/architecture/capability-ledger.md`，现有测试/打包基线记录 | 无 | 当前/目标/缺口/入口/证据分开，检查git与schema版本 |
| E02 契约与显式目标 | A02 | contracts、registry、target-resolver、legacy-adapter；旧IPC/bridge适配 | E01 | 同一动作UI/API结果一致；旧seq/inst有映射，歧义写操作被拒 |
| E03 构建与测试骨架 | 支撑A06/A09 | runtime构建、生成schema、打包资源、临时fixture/harness | E01/E02 | 新进程最小ping与schema在便携包通过，不需全局Node |
| E04 三类技术验证 | A03/A11 | capture-paths、extension-management、auth fixture；新 ADR | E01/E02 | 全量路径、插件能力、登录证据有独立真值和明确未决项 |
| E05 页面与状态原型 | A04/A10 | WorkspaceShell/Home、machine单测、恢复守卫表 | E02 | 可交互A/B视图；状态转换不依赖UI；不宣称静态页面已有浏览器隔离 |
| E06 元数据基础迁移 | A02/A05 | migrate/db/009、legacy映射、scope repositories、test-migrations | E02/E03 | v8→基础模型可回退；旧环境历史可读，旧工具不串目标 |
| E07 内容存储纵向切片 | A05 | content进程、manifest、readRange、010、旧BLOB双读 | E03/E04/E06 | 1GB模拟流内存有界、hash一致、断写可恢复、GC不误删 |
| E08 全量接线 | A07 | coordinator、arbiter、collector、proxy tee、script capture | E04/E07 | 真浏览器上传/响应/WS/SSE/cache/SW矩阵；待补能力不伪达标 |
| E09 任务基础 | A06 | tasks service/repository、outbox、游标、取消/幂等/unknown | E02/E06 | UI/API可查同task；断线续订；不可重复外部写 |
| E10 正文可视化与导出 | A08 | BodyViewer/Detail/Ws/Script、content actions、流式导出 | E07/E08/E09 | 原文可完整取回，大正文不锁UI；导出可取消 |
| E11 双工作区运行 | A12 | manager/runtime/lease、011、首页、scope迁移全部调用方 | E05/E06/E09；接E08 | 两身份同时访问同站不同账号、插件/历史隔离，切页不串任务 |
| E12 登录/插件/恢复闭环 | A10/A11/A12 | auth/extensions/checkpoint/restore及UI、A/B验收 | E04/E11 | 过期/漂移/休眠/崩溃恢复真实可见；旧引用失效；B不受A恢复影响 |
| E13 基础版发布门槛 | A09 | 迁移/打包/文档/能力矩阵/旧限制退役 | E08/E10/E12 | M1/M2所需证据齐全；未过项目留显式阻塞，不靠跳测试放行 |

“并行”仅表示工程依赖允许，不要求自动开启多个开发 Agent。E11 可以先基于稳定契约做受控原型，但最终交付必须接完整采集与持久化；不得长期保留一套假的工作区数据。

### 14.2 全程排期与集成门槛

| 阶段 | 工程量（单名熟悉项目工程师） | 主要集成点 | 离开阶段前必须成立 |
| --- | --- | --- | --- |
| M0 | 3 周 | contracts、构建、基础task、状态/采集/插件技术验证 | E01–E06的基础规格与验证明确；大风险有决策，不只是设计图 |
| M1 | 4–6 周 | content + capture + scoped metadata + BodyViewer | 完整采集矩阵/持久提交/导出通过；开始旧BLOB回填 |
| M2 | 6–10 周 | manager + workspace + auth/extensions + checkpoint + Shell | M2a身份与历史、M2b台账与对账、M2c恢复；A/B真值验收 |
| M3 | 3–4 周 | proxy/environment/rules/SecretRef | 真实路由与实际生效状态，全工作区独立 |
| M4 | 3–5 周 | site-storage/browser/auth adapters | Cookie/存储编辑、精确目标与浏览器动作闭环 |
| M5 | 3–4 周 | templates + runner + browser executor | 两种单次重放、原始记录不变、实际请求证据 |
| M6 | 4–6 周 | batch + scripts + assertions + reports | 次数、并发、变量隔离、取消/未知结果正确 |
| M7 | 3–5 周 | resources + indexer + sites/endpoint UI | 完整原文、可纠正归类、可追溯统计/关系 |
| M8 | 4–6 周 | workflow + Agent协议整合 + timeline | 页面→接口→存储混合流程、人类接管和恢复 |
| M9 | 3–5 周 | intelligence + WS/SSE + experiments | 证据化建议与纠正、协议实验、离线范围真实 |
| M10 | 2–4 周 | migration/backup/packaging/soak | 便携版整流程和长期运行证据，维护手册与退役审计 |

合计沿用产品计划的 **38–58 工程周**，包括本文件的重构/测试/文档，不是在此之外再加一遍。M0 技术验证后必须重估全量采集与插件/恢复；浏览器定制、恶意脚本强隔离、多用户同步等若确实成为实现必需，应显式增加投入，不压缩验收定义。V0.2/V0.3/V0.4/V0.5/V1.0 的发布门槛仍以产品计划为准。

### 14.3 每个任务的交付检查单

```text
任务ID / 产品条目 / M阶段 / 本文小节：
开始前实际commit/schema/工作树：
新增文件（完整相对仓库路径）及职责：
修改文件、函数/组件、接入调用方：
删除对象、替代入口、前置门槛及回退：
依赖精确版本、许可证、资源/打包变更：
schema迁移、数据范围、secret与正文引用：
UI入口 + Agent动作 + 完成/失败/取消/恢复语义：
scope/generation/version/幂等/并发策略：
测试命令、fixture、独立真值、截图与打包证据：
已满足项、未满足项与下一任务：
```

## 15. 设计决策与实施文档的维护规则

M0 新增 `docs/adr/0001-workspace-ownership.md`、`0002-actions-and-tasks.md`、`0003-content-store.md`、`0004-capture-coverage.md`、`0005-extension-management.md`、`0006-runtime-packaging.md`；M6 新增 `0007-script-execution.md`。每份记录选项、证据、选定方案、未决风险、影响文件和重新评估条件。不得用 ADR 将用户已经确定的“全量采集、独立工作区”改成另一目标。

实施中每完成一个领域，同时更新产品计划的状态、本文文件清单、仓库当前能力账本、动作schema和迁移/打包文档。本文的文件清单是覆盖边界而非文件数量 KPI；允许小模块合并，但 UI、Agent、数据归属、原文完整性、恢复证据不能消失。

本文件交付覆盖检查：

| 用户要求 | 文档落点 |
| --- | --- |
| 新文档，服务于整个长期计划 | §1及M0–M10全程，§14排期与任务映射 |
| 新增/修改/删除哪些文件 | §3–§9逐领域文件表，§12退役清单 |
| 每个文件预计增加什么功能、插到哪里 | 职责/插入点列，§2三条调用链 |
| 引入什么新资源/框架/开源能力 | §11依赖决策与fixture/模板/运行资源 |
| 新存储结构与旧数据如何处理 | §10目录、表/索引、内容协议、009–018迁移与回填 |
| 后续能按计划实施并验收 | §13测试矩阵与交叉真值，§14 E01–E13与交付模板 |

推荐第一步是 E01–E04：确认基线、建立目标契约、打通打包链路、验证采集与插件管理。随后沿“持久工作区 + 完整内容”两条基础线推进，再交付重放和智能工作流；不以新增文件数量替代可运行的用户流程。
