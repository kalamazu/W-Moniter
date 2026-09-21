import { readFileSync } from 'node:fs'
const API = 'F:/code/chrome/docs/AI-控制面.md'
const read = readFileSync('F:/code/chrome/work/frag-doc-api-read.md', 'utf8')
const write = readFileSync('F:/code/chrome/work/frag-doc-api-write.md', 'utf8')
const sec33 = readFileSync('F:/code/chrome/work/frag-doc-api-33.md', 'utf8')

export default [
  {
    file: API,
    label: '读路由表补 8 行',
    old: `| GET | \`/dom/tree\` · \`/dom/inspect\` | DOM 树（\`nodeId\`/\`depth\`）/ 元素检查（\`selector\` 或 \`nodeId\`） |
`,
    new: `| GET | \`/dom/tree\` · \`/dom/inspect\` | DOM 树（\`nodeId\`/\`depth\`）/ 元素检查（\`selector\` 或 \`nodeId\`） |
` + read
  },
  {
    file: API,
    label: '写路由表补 4 行',
    old: `| POST | \`/clear\` · \`/console/clear\` | 清采集缓冲（\`/status\` 的计数同时归零；库里的历史不动）/ 清 console |
`,
    new: `| POST | \`/clear\` · \`/console/clear\` | 清采集缓冲（\`/status\` 的计数同时归零；库里的历史不动）/ 清 console |
` + write
  },
  {
    file: API,
    label: '插入 §3.3 实时分析面',
    old: `## 4. MCP server
`,
    new: sec33 + `## 4. MCP server
`
  },
  {
    file: API,
    label: 'MCP 工具清单 25 → 42',
    old: `工具清单（**25 个**，与 HTTP 一一对应）：

\`monitor_status\` · \`monitor_capabilities\` · \`monitor_requests\` · \`monitor_request\` ·
\`monitor_body\` · \`monitor_fetch_body\` · \`monitor_stats\` · \`monitor_timeline\` ·
\`monitor_scripts\` · \`monitor_script_source\` · \`monitor_console\` · \`monitor_evaluate\` ·
\`monitor_dom_tree\` · \`monitor_dom_inspect\` · \`monitor_dom_highlight\` · \`monitor_input\` ·
\`monitor_rules_get\` · \`monitor_rules_set\` · \`monitor_rules_stats\` · \`monitor_probe\` ·
\`monitor_navigate\` · \`monitor_screenshot\` · \`monitor_sessions\` · \`monitor_switch_profile\` ·
\`monitor_clear\``,
    new: `工具清单（**42 个**，与 HTTP 一一对应）。

采集与观测（25 个）：\`monitor_status\` · \`monitor_capabilities\` · \`monitor_requests\` ·
\`monitor_request\` · \`monitor_body\` · \`monitor_fetch_body\` · \`monitor_stats\` ·
\`monitor_timeline\` · \`monitor_scripts\` · \`monitor_script_source\` · \`monitor_console\` ·
\`monitor_evaluate\` · \`monitor_dom_tree\` · \`monitor_dom_inspect\` · \`monitor_dom_highlight\` ·
\`monitor_input\` · \`monitor_rules_get\` · \`monitor_rules_set\` · \`monitor_rules_stats\` ·
\`monitor_probe\` · \`monitor_navigate\` · \`monitor_screenshot\` · \`monitor_sessions\` ·
\`monitor_switch_profile\` · \`monitor_clear\`

实时分析面（17 个）：\`monitor_events\` · \`monitor_event_stats\` · \`monitor_ws_frames\` ·
\`monitor_ws_connections\` · \`monitor_endpoints\` · \`monitor_endpoint\` · \`monitor_graph\` ·
\`monitor_relations\` · \`monitor_export_har\` · \`monitor_export_jsonl\` ·
\`monitor_collect_resources\` · \`monitor_contract_snapshot\` · \`monitor_contracts\` ·
\`monitor_contract\` · \`monitor_contract_diff\` · \`monitor_contract_delete\` · \`monitor_dialog\`

要「实时」就在 \`monitor_events\` / \`monitor_ws_frames\` 上带 \`since\`（自增 id 游标），
把返回里的 \`nextSince\` 拿回来反复调 —— 只拿新增，不重复（见 §3.3）。`
  },
  {
    file: API,
    label: '验收段数字与新增实时分析面验收',
    old: `3. **MCP**：走真正的 stdio JSON-RPC —— \`tools/list\` 要列全（25 个且关键的都在）、`,
    new: `3. **MCP**：走真正的 stdio JSON-RPC —— \`tools/list\` 要列全（42 个且关键的都在）、`
  },
  {
    file: API,
    label: '冒烟段数字',
    old: `一条都不落的冒烟在 \`npm run test:smoke\`（**59/59**）：控制面 29 条路由 + MCP 25 个工具
逐个真调用，每条都要给出它自己的真值证据（截图字节数与元数据一致、DOM 树里真有 \`html\`、
规则写完能读回来…）。它盯的是「有没有哪条路根本走不通」，深度交给上面那几条。`,
    new: `一条都不落的冒烟在 \`npm run test:smoke\`（**76/76**）：控制面 47 条路由 + MCP 42 个工具
逐个真调用，每条都要给出它自己的真值证据（截图字节数与元数据一致、DOM 树里真有 \`html\`、
规则写完能读回来…）。它盯的是「有没有哪条路根本走不通」，深度交给上面那几条。

实时分析面自己有完整的一条：\`npm run test:realtime\`（**47/47**）。它用一个受控 origin 当靶子 ——
origin 自己记 HTTP access log 与 **WS 双向帧日志**当服务端侧真值，页面另把「我看到了什么」回报一份，
判据全是「库里说的」与「origin 说的」逐字对上：WS 帧条数与方向、事件游标的单调与去重、
接口画像的调用次数、契约回归能不能看出新字段、导出文件在磁盘上真的多出来、下载文件真的落地。
同一批数据同时走 HTTP API 与 MCP 两条路，结果要求**逐字一致**（\`monitor_events\` / \`monitor_endpoints\` /
\`monitor_ws_frames\` / \`monitor_contracts\`）。`
  },
  {
    file: API,
    label: '边界：事件推送那条已过时',
    old: `- **没有事件推送**。MCP 侧没有 resources / SSE，HTTP 侧没有 WebSocket；
  agent 要「等新请求」是轮询 \`GET /requests?since=…\`。做推送要先想清楚
  「谁背压、断了怎么续」，不在第一版里。`,
    new: `- **推送只有一条，而且是「查库 + 增量」**：HTTP 侧有 \`GET /events/stream\`（SSE，按 \`interval\`
  查库推新事件），MCP 侧仍然只有拉取 —— 没有 resources、没有订阅。这是有意的：推送要么自己维护
  一套和库并行的广播（迟早和库里对不上），要么就是现在这样「查库 + id 游标」。
  agent 要「等新的东西」就带上 \`since\` 循环调 \`monitor_events\` / \`monitor_ws_frames\`，
  它们和 SSE 读的是同一份数据，不会出现两条路各说各话。`
  }
]