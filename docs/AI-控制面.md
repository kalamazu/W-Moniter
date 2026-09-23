# AI 控制面：本地 HTTP API 与 MCP server

> 目标：让 agent 能像人用看板一样控制这个应用 —— 查请求、看 body、检查 DOM、跑规则、
> 做拟人化输入、切 Profile。两条入口共用同一份后端，行为一致。

## 1. 架构：一个桥，两种前端

```
        ┌─────────── agent / 脚本 ───────────┐
        │                                    │
   HTTP JSON API                        MCP (stdio)
        │                                    │
        └────────► control/server.mjs ◄──────┘
                          │
                NDJSON over stdin/stdout
                          │
              Electron 主进程（ControlBridge）
                          │
                    Controller（采集/规则/探针/DOM/输入）
```

- **控制进程**（`control/server.mjs`）：与存储、代理同一个模式 —— 独立 Node 进程，
  主进程只做编排。它崩了不影响采集，也不把 Web 服务器塞进 UI 进程。
- **主进程的桥**（`src/main/control/bridge.ts`）：把控制进程的方法名映射到 `Controller`
  的公开方法上。方法名与 `ControllerApi`（`src/shared/types.ts`）一一对应。
- **MCP server**（`mcp/server.mjs`）：**只做转发** —— 没有自己的状态、不缓存、不解释结果。
  这样 CLI / HTTP / MCP 三条路径的行为天然一致，也便于用同一条验收脚本覆盖。

## 2. 地址发现与鉴权

主进程启动时把下面这份文件写到数据目录，agent 与 MCP server 都读它：

```json
// <dataDir>/control.json
{ "version": 1, "service": "monitor-control", "host": "127.0.0.1",
  "port": 52137, "token": "<32 字节 hex>", "pid": 12345, "startedAt": 1789784000000 }
```

- 只绑 `127.0.0.1`，**所有接口（除 `/health`）都要 `Authorization: Bearer <token>`**。
  也接受 `?token=`（给不方便设 header 的客户端）。
- token 每次启动随机生成，跟着数据目录走；`control.json` 收工时删除。
- 端口默认 `0`（系统分配），可用 `MONITOR_API_PORT` 固定。
- `MONITOR_API=0` 整体关掉 —— 做「零额外监听面」的隐蔽性验收时用得上。
- 状态里也带一份（`GET /status` 的 `control` 字段），面板与 agent 都读得到。

MCP server 的地址发现顺序：

1. `--url=http://127.0.0.1:<port>?token=<token>` 或 `MONITOR_CONTROL_URL`
2. `<dataDir>/control.json`（`--data-dir=` / `MONITOR_DATA_DIR` / `MONITOR_DB` 推断）
3. 当前目录与 `.userdata/`

## 3. HTTP API

全部返回 JSON。约定：列表/详情类接口**原样返回业务对象**；动作类接口返回
`{ ok: true, ... }`；出错返回 `{ ok: false, error: "..." }` 且 HTTP 状态码为 4xx/5xx。

### 读

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 探活（不需要 token），带上游是否可用 |
| GET | `/status` | 会话状态：内核、target、请求数、Profile、`control` 端点、`dock`（窗口吸附） |
| GET | `/capabilities` | 能力矩阵（domain 白名单、探针、输入） |
| GET | `/requests` | 查请求，分页 `{ total, rows }`；见下面的过滤字段 |
| GET | `/requests/:seq` | 一条请求的完整详情 `{ request, body, … }`：含 `req_headers` / `resp_headers`（JSON 字符串）与 `initiator_stack`（发起链） |
| GET | `/requests/:hash/body` | 按 body hash 取正文（`withData=0` 只要摘要） |
| GET | `/requests/:seq/body-live` | 库里没有就去浏览器缓冲现捞一次 |
| GET | `/stats` | 聚合统计（类型/域/状态分组） |
| GET | `/timeline` | 瀑布图时间线（五段网络分段） |
| GET | `/scripts` | 已采集 JS，分页 |
| GET | `/scripts/stats` | 脚本统计 |
| GET | `/scripts/:hash` | 脚本源码 |
| GET | `/console` | 页面 console 回流（最多 500 条） |
| GET | `/rules` · `/rules/stats` | 规则集 / 命中统计 |
| GET | `/workspaces/:id/rules` · `/workspaces/:id/capture/summary` · `/workspaces/:id/requests/:seq/body-evidence` | 显式工作区规则与采集证据；返回 ActionResult |
| GET | `/workspaces/:id/content/:hash/verify` · `/workspaces/:id/content/:hash/range?start=&end=` | 校验与至多 1 MiB 范围读取（base64）；不返回磁盘路径 |
| GET | `/workspaces/content-stats` · `/tasks/diagnostics` | 各工作区正文/缺口摘要与任务 journal 诊断 |
| GET | `/instances` · `/sessions` | 实例列表 / 会话视图（含存储分区） |
| GET | `/dom/tree` · `/dom/inspect` | DOM 树（`nodeId`/`depth`）/ 元素检查（`selector` 或 `nodeId`） |
| GET | `/events` · `/events/stats` | 事件流水（导航 / console 告警 / 异常 / 下载 / 对话框 / WS 生命周期）与按 kind·level 的计数；`since` 是**自增 id 游标**，拿返回里的 `nextSince` 反复拉就只拿新增 |
| GET | `/events/stream` | **SSE**：按 `since` 增量推事件（`interval` 毫秒为周期查库，`event: events` 一帧一批）。断了重连照旧从 `since` 续，不会丢也不会重 |
| GET | `/ws` · `/ws/connections` | WebSocket / SSE 的帧明细与按连接汇总（`direction` 相对浏览器：`sent` = 页面发出去） |
| GET | `/endpoints` · `/endpoints/detail` | 接口画像（路径模板聚类 + 状态码 / 耗时 / 参数 / 请求体字段分布 + 调用节奏）与单端点详情（含从**真实响应体**推出来的响应结构） |
| GET | `/graph` | 请求调用图：节点、边（次数 / 失败数 / 平均耗时）、连通分量（互相牵动的功能簇） |
| GET | `/relations` | 关联分析：共享响应体 / 重定向链 / 跨域加载关系 / 跨端点复用的 query 取值 |
| GET | `/contracts` · `/contracts/:id` · `/contracts/:id/diff` | 契约快照列表 / 取一份 / 与「现在」比对（新增或消失的端点、字段、状态码） |
| GET | `/exports/download?name=` | 取回 `exports/` 下已经导出的文件；只收纯文件名（见 §3.3） |
| GET | `/cookies` | **库里的 cookie 镜像**（不是浏览器现况），分页 `{ total, rows }`；过滤 `domain`(含子域) / `name` / `path` / `search` / `session` / `crossSite` / `sameSite` / `secure` / `httpOnly` / `partitioned` / `sort` / `limit` / `offset`（见 §3.4） |
| GET | `/cookies/stats` | cookie 画像：总数 / 域数 / 会话与持久 / Secure·HttpOnly 覆盖 / SameSite=None / 跨站使用 / 分区 / 总体积 + 最大的、出现域最多的、活得最久的、被带出去最多的 |
| GET | `/sites` | 域清单 `{ rows, total }`（`limit` / `onlyScanned=1`）；每行给出 cookie 数、local/session 键数、IDB 库数、缓存条数、SW 数、配额。`scanned=false` = 见过但还没扫过 |
| GET | `/sites/detail` | 单域明细（`origin`）：cookie（含值）/ local·session 键值 / IDB 库与对象仓结构 / 缓存 URL 清单 / SW 注册 / 用量配额。**结果是平铺的**，没有 `{ found, detail }` 包壳 |
| GET | `/sites/snapshots` | 站点快照列表 `{ rows, total }`（`limit`） |
| GET | `/sites/snapshots/:id/diff` | 快照 vs「现在的实况」：新增/消失的域、增删改的 cookie（含改了哪几个字段）、内容变了的 localStorage 键 |
**请求过滤字段**（`/requests`，也用于 `/timeline`、`/scripts`）：
`urlPattern`（别名 → `url`）、`domain`（→ `host`）、`q`（→ `search`）、
`method`、`type`（→ `resourceType`）、`initiator`（→ `initiatorType`，取值
`script` / `parser` / `preload` / `preflight` / `signedExchange` / `other`）、
`status`、`statusMin`/`statusMax`、`since`/`until`、`minSize`/`maxSize`、
`path`、`scheme`、`limit`、`offset`、`order`。

> 别名是为了让 agent 好写：引擎内部认的是 `url`/`host`/`search`，
> 映射表在 `control/server.mjs` 的 `QUERY_ALIASES`，只有一处。

注意 `host` 字段**带端口**（`127.0.0.1:8802`），过滤时要拿列表里的真值。

`/status` 里的 `dock`（窗口吸附，见设计文档 D9 / 使用手册 §5.8）是**只读**的，也是 `monitor_status`
返回的同一个对象：`enabled`（用户开着吗）/ `available`（这台机器支不支持）/ `attached`（真吸上了吗）/
`side`（`left` / `right`）/ `reason`（没吸上的原因：`no-window` / `no-room` / `not-windows` / 具体错误）。
控制面里没有对应的写路由 —— 吸附会挪用户桌面上的窗口，只能从控制窗口顶栏开。

工作区布局（`ui-settings.json` 的 `layout`：几栏、每栏哪块面板、占比、横竖）同样是**渲染层私有**的，
HTTP / MCP 都没有读写路由。它是给坐在屏幕前的人摆的：agent 想「看某一块面板」应该走 `/screenshot`
或直接读对应的数据接口，而不是替用户重排界面（设计文档 D10）。

### 写

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/navigate` | `{ url }` 让被监控页面跳转（只放 http/https，等 load 后回读落地 URL/标题，见 §3.2） |
| POST | `/screenshot` | `{ format?, quality?, fullPage?, nodeId?, inline? }` 截图；只读，只是把图片落盘（见 §3.1） |
| POST | `/evaluate` | `{ expression }` 页面求值（Profile L 专用） |
| POST | `/probe` | `{ options? }` 跑检测探针，返回四组报告 |
| POST | `/input` | `{ kind, … }` 拟人化输入：move / click / type / scroll；`click` / `type` 可只给 `selector`（见 §3.2） |
| POST | `/dom/highlight` | `{ nodeId, on }` 页面里高亮节点 |
| POST | `/workspaces/:id/rules` | `{ set: RuleSet, expectedVersion?, idempotencyKey? }`；显式目标覆盖式保存，返回 ActionResult.output.invalid |
| POST | `/workspaces/:id/content/:hash/revoke` | `{ reason, idempotencyKey? }`；先记录清理意图，再删内容与引用，返回 ActionResult |
| POST | `/sessions/profile` | `{ profile }` 切 Profile（**收工重启**，不是热切） |
| POST | `/clear` · `/console/clear` | 清采集缓冲（`/status` 的计数同时归零；库里的历史不动）/ 清 console |
| POST | `/contracts` | `{ label?, sampleLimit?, domain? }` 给当前接口契约拍快照，回 `{ id, endpoints, truncated }` |
| DELETE | `/contracts/:id` | 删掉一份契约快照 |
| POST | `/export/har` · `/export/jsonl` · `/export/bodies` | 导出 HAR 1.2 / JSONL / 资源镜像，返回落盘的**绝对路径**与计数 |
| POST | `/sites/scan` | `{ origin?, limit?, cookies? }` **去浏览器真扫一遍并落库**（见 §3.4）：给 `origin` 只扫它，否则扫最近有流量的前 `limit` 个域（默认 20）；`cookies:false` 跳过罐对账 |
| POST | `/cookies` | `{ name, value, domain? \| url?, path?, secure?, httpOnly?, sameSite?, expires?, maxAge? }` 往浏览器罐里写一条（`Storage.setCookies`）。`maxAge: 0` = 立刻作废；都不给 = 会话 cookie |
| DELETE | `/cookies` | 条件走 query：`name` / `domain` / `host` / `url` / `path` / `crossSite=1`。**一个都不给会被拒**（`{ ok:false, deleted:0 }`，HTTP 仍是 200） |
| POST | `/sites/clear` | `{ origin, types? }` 清这一域的站点数据；`types` ∈ `cookies`/`local_storage`/`session_storage`/`indexeddb`/`cache_storage`/`service_workers`/`file_systems`/`all`（不填 = all），清完自动重扫 |
| POST | `/sites/storage` | `{ origin, area, action, key?, value? }` 改 localStorage / sessionStorage：`action` = `set`/`remove`/`clear`，写完自动重扫 |
| POST | `/sites/idb/delete` | `{ origin, name }` 删**整个** IndexedDB 库（不是某张表），删完自动重扫 |
| POST | `/sites/cache/delete` | `{ origin, name, url? }` 删 Cache Storage：给 `url` 就只删那一条，删完自动重扫 |
| POST | `/sites/sw/unregister` | `{ scopeURL }` 注销一个 Service Worker 注册（如 `https://example.com/`） |
| POST | `/sites/snapshots` | `{ label? }` 拍一份站点快照（拍之前先扫一遍，免得基线陈旧） |
| DELETE | `/sites/snapshots/:id` | 删掉一份快照 |
| POST | `/dialog` | `{ accept, promptText? }` 应答 JS 对话框 —— **不应答页面就一直卡着** |
### 3.1 截图

三种取景：默认**当前视口**；`fullPage: true` **整页**（按 `cssContentSize`，超过 16000px 会截断并在结果里标 `clamped`）；
给了 `nodeId` 就**只截那个元素**（节点来自 `/dom/tree`、`/dom/inspect`；`display:none` 这类没有布局的节点会明确报错）。

`format` 默认 `png`，可换 `jpeg`（`quality` 默认 80）。图片落盘在 `<数据目录>/screenshots/`，结果里给**绝对路径**——
几 MB 的图片没必要从 JSON 里过一遍。`inline: true` 时另外带 `dataBase64`（超过 4MB 就不带，回 `inlineSkipped`，仍然给路径）。
MCP 侧默认 `inline: true`，并把 base64 单独放成 `image` 内容块（文本块里不留同一张图）。

宽度/高度是从**图片头里读出来的真实像素**，不是 CDP 报的 CSS 像素——验收就是拿它跟页面的文档尺寸对的。

截图目录只保留最近 200 张，更早的自动删掉 —— agent 可能成环地截图（拿图 → 判断 → 再截），不设上限数据目录会无声地涨。

### 3.2 导航与「说选择器，不说坐标」

`POST /navigate { url }` 只接受 http/https，别的协议直接拒。它等 `Page.loadEventFired`
（最长 15 秒，超时也如实返回当前状态），再用 `Page.getNavigationHistory` 回读**真实落地**的 URL 与标题：
请求的 URL 和落地的 URL 可能不是同一个（重定向），所以两个都给 ——
`{ ok, requestedUrl, url, title, durationMs }`。

`POST /input` 的 `click` / `type` 可以直接给 `selector`：

- 走 `DOM.getContentQuads`（拿不到再退回 `getBoxModel`）算出元素中心，之后照常走贝塞尔轨迹；
- `type` + `selector` 会**先点一下聚焦**再敲键，否则键会打到别处；
- 选择器解不出来就**如实报错**，不会静默点 (0,0) —— 静默点错地方比报错危险得多；
- `DOM` 域只在这条路上按需开（`css` / `overlay` 不碰），Profile H 下同样可用。

被监控浏览器是带着**抗节流三开关**起的（`--disable-backgrounding-occluded-windows`、
`--disable-renderer-backgrounding`、`--disable-features=CalculateNativeWinOcclusion`，见
`src/main/browser/launch.ts`）。不关这三个，窗口一被别的窗口盖住，Chromium 就按「不可见」
节流渲染：鼠标事件回执被拖到 ~5s（实测 8 点轨迹 40s、80 点轨迹 80s，调用方 12s 的超时必然
踩空），`mousemove` 还会被按帧合并（轨迹里凭空多个 600px 的跳步、滚轮总量少 12%）。

还有一条要记住：**`/input` 返回 ≠ 页面已经收到**。DevTools 的回执只说明浏览器收下了，
浏览器还要按渲染进程的回执节奏排队投递 —— 实测动作返回后 150ms 内页面还会再收到 30 多个点。
要「点完立刻读结果」的 agent，读之前留 ~200ms，或者把要读的东西并进同一次 `/evaluate`。

### 3.3 实时分析面（事件流 / WebSocket / 接口画像 / 调用图 / 关联 / 契约 / 导出）

这一层是给「研究 + 自动化测试」用的：把会话里发生的事，算成能**直接下判断**的形状。

**增量游标**：`/events` 与 `/ws` 的 `since` 是**自增 id**，不是时间戳（时钟会回拨，id 不会）。
把返回里的 `nextSince` 直接拿回来当下一次的 `since`，就只拿新增的，不会重复吐已经消费过的。
验收里有一条专门盯这个：追平之后再问，必须回空数组且 `nextSince` 不动。

**事件 kind**：`navigation` / `console` / `exception` / `websocket` / `download` / `dialog` /
`target` / `rule` / `overflow` / `cookie` / `storage`（后两个来自站点资源面，见 §3.4）；`level` 是 `info` / `warn` / `error`。
`console` 只收 error / warning / assert —— 全量 log 走 `/console`，否则事件流会被日志淹掉。

**WebSocket 帧的方向是相对浏览器说的**：`sent` = 页面发出去，`received` = 服务端推过来。
二进制帧的 `payload` 是 base64（`binary: true` 标出来），`size` 已按 4/3 换算回**真实字节数**。

**接口画像的路径模板是保守替换**：`/user/42` 与 `/user/43` 并成 `/user/{int}`，
`{uuid}` / `{hex}` / `{date}` / `{token}` / `.{hash}.` 同理。宁可多出两个模板，
也不要把 `/users/me` 和 `/users/1` 并成一个 —— 合错了会把两个接口的契约搅在一起。

**`optional` 的语义是「不是每个样本都有」**：字段出现次数 `seen < count` 就标 `optional`，
而且父层的可选会往子层传（整个 `bonus` 只在一半样本里出现时，`bonus.deep` 也是可选的）。
契约回归正是靠这个抓「新字段只在部分请求里出现」。

**契约回归的标准动作**：跑一遍 → `POST /contracts` 拍基线 → 改代码 / 改配置 → 再跑一遍 →
`GET /contracts/:id/diff`。返回 `{ summary, added, removed, changed, base, current }`，
`added` / `removed` / `changed` 都是**逐端点**的；`changed` 里再分响应字段、请求字段、状态码与调用次数。

**导出落在 `<数据目录>/exports/`**：

- **HAR 1.2**（DevTools 能直接打开）：CDP 伪头（`:method` 这类）会被剔除，否则 DevTools 打开就报错；
  `connect` 段是 TCP + TLS 之和；每条另带 `_monitor` 段（seq / targetType / 关联状态）。
- **JSONL**：一行一条，含完整请求 / 响应头与正文（二进制 base64），适合丢给脚本再算。
- **资源镜像**：按类型（`document` / `script` / `image` / `font` / …）分子目录，
  文件名 = `正文 hash 前 8 位 + 原文件名`；同一份正文只写一次，另写 `manifest.json` 记
  「每个文件来自哪些 URL」。**同一份响应体被两个不同地址取到，只会落成一个文件** ——
  这正是「共享响应体」能被关联分析抓到的那条线索。

导出的文件可以用 `GET /exports/download?name=<文件名>` 取回。**只收导出目录下的纯文件名**：
带路径分隔符、带 `..` 一律 400 —— 图省事收「路径」的话，这个口就变成任意文件读取了。

**下载落到 `<数据目录>/downloads/`**（`MONITOR_DOWNLOAD_DIR` 可覆盖，设成空串 = 交回浏览器默认）。
自动化跑一遍不该往用户的下载夹里丢东西；而且「文件真的落了盘」是事后取证要的外部证据。
下载的 `begin` / `inProgress` / `completed` 都进事件流，`completed` 带 `receivedBytes`。

### 3.4 站点资源（Cookie 与站点存储）

给「研究 + 自动化测试」用的另一只眼睛：**我们拉起的那个浏览器**攒下来的 cookie 与站点存储，
agent 能读、能写、能删、能拍快照比差异。

**cookie 罐以浏览器为权威，我们只做「对账」。** 控制面不解析 `Set-Cookie` —— domain/path 匹配、
Max-Age、SameSite 的默认值，每一条自己实现一遍都会和浏览器对不上。做法是每 5s 用
`Storage.getCookies` 把**全量罐**读回来，与库里的上一轮比出 `added` / `changed` / `removed`，
增量写进 `cookies` 表；收到 `Set-Cookie` 时再补一次（250ms 防抖）。`Set-Cookie` 只用来回答
「是谁改的」—— 变化记录里带上 `source: 'set-cookie'` 与那条响应的 URL（cookie 行本身只记事实，
不记来源）。对账口径两边必须一致：
`domain|path|name|partition`（域去前导点并小写，path 空按 `/`）。

**`GET /cookies` 读的是库里那份镜像**，`POST /sites/scan` 才是「去浏览器现读一遍」。
要拿「现在到底有什么」下判断，先扫。

**站点存储是「点了才扫」。** 每个域要连问好几条 CDP（`DOMStorage` / `IndexedDB` / `CacheStorage` /
`ServiceWorker` / `Storage.getUsageAndQuota`），不像 cookie 罐那样便宜，所以只在
`POST /sites/scan` 时才去读（不传 `origin` 就扫最近有流量的前 `limit` 个域，默认 20）。
`/sites` 里 `scanned=false` 的域 = 见过（见过它的请求）但还没扫过。

**写操作返回的是「改完之后重扫的真实结果」**，不是「已提交」的口头保证：`/sites/storage`、
`/sites/clear`、`/sites/idb/delete`、`/sites/cache/delete`、`/sites/sw/unregister` 干完都会
自动重扫该域。代价是这些调用比读慢（要等 CDP 回包），换来的是「响应即真值」。

**删 cookie 必须给条件。** `name` / `domain` / `host` / `url` / `path` / `crossSite` 至少一个，
一个都不给会被**应用层拒绝**：回 `{ ok: false, deleted: 0 }`，HTTP 仍是 200
（这是「拒绝执行」，不是「请求写错了」）。`crossSite=1` 删的是所有「被发往过非自身站点」的 cookie ——
清第三方 cookie 用它：库先查出主键清单，再交给 CDP 按 key 精确删。

**快照与 diff**：`POST /sites/snapshots` 拍一份（拍之前先扫一遍，免得基线陈旧），
`GET /sites/snapshots/:id/diff` 拿它与「现在的实况」比 —— 新增/消失的域、增删改的 cookie
（含改了哪几个字段）、内容变了的 localStorage 键。`summary` 里是能直接下判断的数字。

## 4. MCP server

stdio 传输，换行分隔的 JSON-RPC 2.0。

```bash
node mcp/server.mjs --data-dir=<数据目录>          # 让 agent 自己接
node mcp/server.mjs --url=http://127.0.0.1:52137?token=…
```

实现的方法：`initialize` / `notifications/initialized` / `ping` /
`tools/list` / `tools/call`；未知方法回 `-32601`，未知工具回 `isError: true`
（**不会断连接** —— 出错之后还能继续用，验收里专门测了这一条）。

工具清单（**58 个**，与 HTTP 一一对应）。

采集与观测（25 个）：`monitor_status` · `monitor_capabilities` · `monitor_requests` ·
`monitor_request` · `monitor_body` · `monitor_fetch_body` · `monitor_stats` ·
`monitor_timeline` · `monitor_scripts` · `monitor_script_source` · `monitor_console` ·
`monitor_evaluate` · `monitor_dom_tree` · `monitor_dom_inspect` · `monitor_dom_highlight` ·
`monitor_input` · `monitor_rules_get` · `monitor_rules_set` · `monitor_rules_stats` ·
`monitor_probe` · `monitor_navigate` · `monitor_screenshot` · `monitor_sessions` ·
`monitor_switch_profile` · `monitor_clear`

实时分析面（17 个）：`monitor_events` · `monitor_event_stats` · `monitor_ws_frames` ·
`monitor_ws_connections` · `monitor_endpoints` · `monitor_endpoint` · `monitor_graph` ·
`monitor_relations` · `monitor_export_har` · `monitor_export_jsonl` ·
`monitor_collect_resources` · `monitor_contract_snapshot` · `monitor_contracts` ·
`monitor_contract` · `monitor_contract_diff` · `monitor_contract_delete` · `monitor_dialog`

站点资源（16 个）：`monitor_cookies` · `monitor_cookie_stats` · `monitor_cookie_set` ·
`monitor_cookie_delete` · `monitor_sites` · `monitor_site_detail` · `monitor_site_scan` ·
`monitor_site_clear` · `monitor_site_storage_edit` · `monitor_site_idb_delete` ·
`monitor_site_cache_delete` · `monitor_site_sw_unregister` · `monitor_site_snapshot` ·
`monitor_site_snapshots` · `monitor_site_snapshot_diff` · `monitor_site_snapshot_delete`

要「实时」就在 `monitor_events` / `monitor_ws_frames` 上带 `since`（自增 id 游标），
把返回里的 `nextSince` 拿回来反复调 —— 只拿新增，不重复（见 §3.3）。

工具的 `description` 写的是「什么时候用、参数什么意思、有什么坑」（比如
`monitor_switch_profile` 明说这是收工重启，`monitor_evaluate` 明说 H 下不可用），
因为 agent 是靠这段文字决定要不要调它的。

## 5. 验收

`npm run test:control` —— **33/33**，判据分三层：

1. **发现与鉴权**：`control.json` 写出来且带 port/token；不带 token 必须 401；
   `/health` 免鉴权可用；不存在的接口回 404 而不是崩掉。
2. **数据面**：每个接口的返回都要与**同一份数据的另一处真值**对上 ——
   假过滤条件必须查不到、真条件必须查得到；`/requests/:seq` 与列表里那条必须是同一个请求
   （url/seq 逐字比）；`/dom/tree` 里必须真有 `html`/`body`；`/dom/inspect` 必须给出
   盒模型 / 命中样式 / 监听器三块；`/screenshot` 落盘的图片，尺寸要与图片头、
   以及页面自报的文档尺寸都对上（MCP 侧还要带回 `image` 块）；`/probe` 必须真的跑出检测项。
3. **MCP**：走真正的 stdio JSON-RPC —— `tools/list` 要列全（58 个且关键的都在）、
   每个工具都要有 description 与 inputSchema；`monitor_status` / `monitor_requests`
   的结果要和**直接 HTTP 调用逐字一致**（同一份数据，不是两条路各说各话）；
   未知工具要回 `isError` 且之后连接还能用。

另外两条更细的验收：`npm run test:detail`（**8/8**）盯详情面板那条链 —— 页面里发一个
`fetch`，库里第一帧函数名必须逐字是它、`initiator` 过滤要真生效、`/requests/:seq` 里要真能读到
`initiator_stack`；`npm run test:drill`（**39/39**）是**纯 MCP 的端到端演练**（见 §7.4），
判据落在页面侧与库里的真值上（拦掉的请求必须真的不再 200、截图的字节数必须与落盘一致）。

一条都不落的冒烟在 `npm run test:smoke`（**129/129**）：控制面 64 条路由 + MCP 58 个工具
逐个真调用，每条都要给出它自己的真值证据（截图字节数与元数据一致、DOM 树里真有 `html`、
规则写完能读回来、导出文件真的在磁盘上…）。它盯的是「有没有哪条路根本走不通」，深度交给上面那几条。

覆盖是**算出来的**，不是手写的数字：`api()` 把每次真实请求的路由记进一个集合，最后断言
「新增的实时分析面 19 条 + 站点资源面 16 条都在里面、总数 ≥ 63」。控制面一共 64 条路由，唯一没走的是
`POST /sessions/profile` —— 它要收工重启（几十秒），由 MCP 侧的 `monitor_switch_profile` 覆盖。

实时分析面自己有完整的一条：`npm run test:realtime`（**47/47**）。它用一个受控 origin 当靶子 ——
origin 自己记 HTTP access log 与 **WS 双向帧日志**当服务端侧真值，页面另把「我看到了什么」回报一份，
判据全是「库里说的」与「origin 说的」逐字对上：WS 帧条数与方向、事件游标的单调与去重、
接口画像的调用次数、契约回归能不能看出新字段、导出文件在磁盘上真的多出来、下载文件真的落地。
同一批数据同时走 HTTP API 与 MCP 两条路，结果要求**逐字一致**（`monitor_events` / `monitor_endpoints` /
`monitor_ws_frames` / `monitor_contracts`）。

站点资源面自己有一条：`npm run test:sitedata`（**30/30**）。真开浏览器 + 受控 origin，判据逐条对 CDP 真值 ——
cookie 罐的 added / changed / removed 与「是谁改的」归因、六个存储块逐条对得上、写删双向（含
「无条件删被拒」）、快照 diff、clear 之后真空、跨站 cookie 的口径，再验 HTTP 与 MCP 两条路逐字一致
以及面板 DOM 真的渲染出行。纯算的那一层（不起浏览器）在 `npm run test:analytics`（**57/57**）。

## 6. 已知边界

- **推送只有一条，而且是「查库 + 增量」**：HTTP 侧有 `GET /events/stream`（SSE，按 `interval`
  查库推新事件），MCP 侧仍然只有拉取 —— 没有 resources、没有订阅。这是有意的：推送要么自己维护
  一套和库并行的广播（迟早和库里对不上），要么就是现在这样「查库 + id 游标」。
  agent 要「等新的东西」就带上 `since` 循环调 `monitor_events` / `monitor_ws_frames`，
  它们和 SSE 读的是同一份数据，不会出现两条路各说各话。
- **`/evaluate` 只在 Profile L 可用**：H 按 §3.4 的设计不开 `Runtime`，这是故意的（见设计文档 §3.4）。
- 截图的边界：全页上限 16000px（`clamped`）；`inline` 上限 4MB base64（超出只给路径）；
  元素截图要求节点有布局（`display:none` 不行）。截图**不做像素级比对**，验收比的是「图片头尺寸 = 页面自报尺寸」。
- 规则写入是覆盖式的（与面板「保存并生效」同一条路径），没有增量 patch 接口；旧 `POST /rules` 也必须提供 `{ workspaceId, set }`，推荐使用显式工作区路由。
- **请求头有内核侧盲区**：头走 `Network.*ExtraInfo`，而 Worker / Service Worker 的会话
  根本不发这两个事件（实测：worker 会话只有 `requestWillBeSent` / `responseReceived`），
  所以那些请求的 `req_headers` / `resp_headers` 是 `null`。页面主线程的请求不受影响。
- 规则集变更后会**对已 attach 的 session 重下发 `Fetch.enable`**（`Fetch` 是覆盖语义），
  所以「运行中新增的规则」下一次请求就生效；但已经在飞的那一条不会被追回去改。
- MCP server 的端点会**自动重新发现**：discovery 拿到的地址失效时（401/403/404 或连接被拒）
  会丢掉缓存再解析一次，所以应用重启换了端口/token，同一个 MCP 连接能自己接回来。
  用 `--url` 钉死地址时不做这件事 —— 那是「我知道它在哪」，重试只会掩盖问题。
- **界面偏好不进控制面**：工作区布局只存在本机 `ui-settings.json`（渲染层私有，D10），
  `/status` 里的 `dock` 也仍然只读 —— 能被 agent 改的只有采集、规则、注入与页面侧动作。

## 7. 把 agent 接上来

三步：**起应用 → 让 MCP server 找到它 → 在 agent 那侧注册**。

### 7.1 起应用

控制服务的端口与 token 由主进程写进数据目录的 `control.json`，agent 与 MCP server 都读它：

```bash
npm run dev                                   # 或 node out/main/index.js
# 想固定数据目录/端口：
MONITOR_DATA_DIR=D:\monitor-data MONITOR_API_PORT=52137 npm run dev
```

### 7.2 MCP server：三种接法

```bash
# a) 让它按 discovery 顺序自己找（最省事）
node mcp/server.mjs --data-dir=D:\monitor-data

# b) 直接给地址（应用已起来，control.json 在别处）
node mcp/server.mjs --url=http://127.0.0.1:52137?token=<token>

# c) 环境变量（脚本/容器里最顺手）
MONITOR_CONTROL_URL='http://127.0.0.1:52137?token=<token>' node mcp/server.mjs
```

`npm run mcp` 等价于 `node mcp/server.mjs`。它是**纯 stdio**：stdout 上只有 JSON-RPC
（进程里根本没有日志输出），诊断信息以 `isError` 的形式回在工具调用结果里，
所以喂给任何 MCP 客户端都不会被杂音打断。

> 用 `--data-dir` 的接法**不要求应用已经起来**：每次调用现读 `control.json`，
> 应用后起也能接上；应用重启换了 token 也不用改配置。

### 7.3 在 Codex / 通用 MCP 客户端里注册

Codex（CLI 与桌面端同一份 `~/.codex/config.toml`）：

```toml
[mcp_servers.monitor]
command = "node"
args = ["F:/code/chrome/mcp/server.mjs", "--data-dir=F:/code/chrome/.userdata/agent"]
```

或者一条命令写完：

```bash
codex mcp add monitor -- node F:/code/chrome/mcp/server.mjs --data-dir=F:/code/chrome/.userdata/agent
```

别的客户端用同一份 JSON：

```json
{
  "mcpServers": {
    "monitor": {
      "command": "node",
      "args": ["F:/code/chrome/mcp/server.mjs", "--data-dir=F:/code/chrome/.userdata/agent"]
    }
  }
}
```

### 7.4 接上之后先跑这条

```bash
npm run test:drill
```

它**只走 `mcp/server.mjs` 的 stdio JSON-RPC**（不 import 项目内部模块、不直接连调试端口），
跑的每一步都是外部 agent 能跑的：发现 → 查请求/详情/body → 读脚本与控制台 → 看 DOM → 截图 →
模拟点击 → 写规则并**验证拦截真的生效** → 跑探针 → 看会话 → 切 Profile（H 下 `evaluate` 被拒）→ 清理。
36 项全绿才算「agent 真接上了」。
