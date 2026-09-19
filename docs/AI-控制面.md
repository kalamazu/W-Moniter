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
| GET | `/status` | 会话状态：内核、target、请求数、Profile、`control` 端点 |
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
| GET | `/instances` · `/sessions` | 实例列表 / 会话视图（含存储分区） |
| GET | `/dom/tree` · `/dom/inspect` | DOM 树（`nodeId`/`depth`）/ 元素检查（`selector` 或 `nodeId`） |

**请求过滤字段**（`/requests`，也用于 `/timeline`、`/scripts`）：
`urlPattern`（别名 → `url`）、`domain`（→ `host`）、`q`（→ `search`）、
`method`、`type`（→ `resourceType`）、`initiator`（→ `initiatorType`，取值
`script` / `parser` / `preload` / `preflight` / `signedExchange` / `other`）、
`status`、`statusMin`/`statusMax`、`since`/`until`、`minSize`/`maxSize`、
`path`、`scheme`、`limit`、`offset`、`order`。

> 别名是为了让 agent 好写：引擎内部认的是 `url`/`host`/`search`，
> 映射表在 `control/server.mjs` 的 `QUERY_ALIASES`，只有一处。

注意 `host` 字段**带端口**（`127.0.0.1:8802`），过滤时要拿列表里的真值。

### 写

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/navigate` | `{ url }` 让被监控页面跳转（只放 http/https，等 load 后回读落地 URL/标题，见 §3.2） |
| POST | `/screenshot` | `{ format?, quality?, fullPage?, nodeId?, inline? }` 截图；只读，只是把图片落盘（见 §3.1） |
| POST | `/evaluate` | `{ expression }` 页面求值（Profile L 专用） |
| POST | `/probe` | `{ options? }` 跑检测探针，返回四组报告 |
| POST | `/input` | `{ kind, … }` 拟人化输入：move / click / type / scroll；`click` / `type` 可只给 `selector`（见 §3.2） |
| POST | `/dom/highlight` | `{ nodeId, on }` 页面里高亮节点 |
| POST | `/rules` | 整体写规则集（覆盖式），坏规则返回 `invalid` |
| POST | `/sessions/profile` | `{ profile }` 切 Profile（**收工重启**，不是热切） |
| POST | `/clear` · `/console/clear` | 清采集缓冲（`/status` 的计数同时归零；库里的历史不动）/ 清 console |

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

## 4. MCP server

stdio 传输，换行分隔的 JSON-RPC 2.0。

```bash
node mcp/server.mjs --data-dir=<数据目录>          # 让 agent 自己接
node mcp/server.mjs --url=http://127.0.0.1:52137?token=…
```

实现的方法：`initialize` / `notifications/initialized` / `ping` /
`tools/list` / `tools/call`；未知方法回 `-32601`，未知工具回 `isError: true`
（**不会断连接** —— 出错之后还能继续用，验收里专门测了这一条）。

工具清单（**25 个**，与 HTTP 一一对应）：

`monitor_status` · `monitor_capabilities` · `monitor_requests` · `monitor_request` ·
`monitor_body` · `monitor_fetch_body` · `monitor_stats` · `monitor_timeline` ·
`monitor_scripts` · `monitor_script_source` · `monitor_console` · `monitor_evaluate` ·
`monitor_dom_tree` · `monitor_dom_inspect` · `monitor_dom_highlight` · `monitor_input` ·
`monitor_rules_get` · `monitor_rules_set` · `monitor_rules_stats` · `monitor_probe` ·
`monitor_navigate` · `monitor_screenshot` · `monitor_sessions` · `monitor_switch_profile` ·
`monitor_clear`

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
3. **MCP**：走真正的 stdio JSON-RPC —— `tools/list` 要列全（25 个且关键的都在）、
   每个工具都要有 description 与 inputSchema；`monitor_status` / `monitor_requests`
   的结果要和**直接 HTTP 调用逐字一致**（同一份数据，不是两条路各说各话）；
   未知工具要回 `isError` 且之后连接还能用。

另外两条更细的验收：`npm run test:detail`（**8/8**）盯详情面板那条链 —— 页面里发一个
`fetch`，库里第一帧函数名必须逐字是它、`initiator` 过滤要真生效、`/requests/:seq` 里要真能读到
`initiator_stack`；`npm run test:drill`（**39/39**）是**纯 MCP 的端到端演练**（见 §7.4），
判据落在页面侧与库里的真值上（拦掉的请求必须真的不再 200、截图的字节数必须与落盘一致）。

一条都不落的冒烟在 `npm run test:smoke`（**59/59**）：控制面 29 条路由 + MCP 25 个工具
逐个真调用，每条都要给出它自己的真值证据（截图字节数与元数据一致、DOM 树里真有 `html`、
规则写完能读回来…）。它盯的是「有没有哪条路根本走不通」，深度交给上面那几条。

## 6. 已知边界

- **没有事件推送**。MCP 侧没有 resources / SSE，HTTP 侧没有 WebSocket；
  agent 要「等新请求」是轮询 `GET /requests?since=…`。做推送要先想清楚
  「谁背压、断了怎么续」，不在第一版里。
- **`/evaluate` 只在 Profile L 可用**：H 按 §3.4 的设计不开 `Runtime`，这是故意的。
- 截图的边界：全页上限 16000px（`clamped`）；`inline` 上限 4MB base64（超出只给路径）；
  元素截图要求节点有布局（`display:none` 不行）。截图**不做像素级比对**，验收比的是「图片头尺寸 = 页面自报尺寸」。
- 规则写入是覆盖式的（与面板「保存并生效」同一条路径），没有增量 patch 接口。
- **请求头有内核侧盲区**：头走 `Network.*ExtraInfo`，而 Worker / Service Worker 的会话
  根本不发这两个事件（实测：worker 会话只有 `requestWillBeSent` / `responseReceived`），
  所以那些请求的 `req_headers` / `resp_headers` 是 `null`。页面主线程的请求不受影响。
- 规则集变更后会**对已 attach 的 session 重下发 `Fetch.enable`**（`Fetch` 是覆盖语义），
  所以「运行中新增的规则」下一次请求就生效；但已经在飞的那一条不会被追回去改。
- MCP server 的端点会**自动重新发现**：discovery 拿到的地址失效时（401/403/404 或连接被拒）
  会丢掉缓存再解析一次，所以应用重启换了端口/token，同一个 MCP 连接能自己接回来。
  用 `--url` 钉死地址时不做这件事 —— 那是「我知道它在哪」，重试只会掩盖问题。

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