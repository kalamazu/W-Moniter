import { readFileSync } from 'node:fs'
const MAN = 'F:/code/chrome/docs/使用手册.md'
const sec59 = readFileSync('F:/code/chrome/work/frag-doc-manual-59.md', 'utf8')

export default [
  {
    file: MAN,
    label: '§4.1 十个 → 十四个面板',
    old: `- 每栏栏头那颗胶囊下拉框就是「这一栏显示什么」，**十个面板全在里面**（瀑布图、统计、脚本、规则、
  控制台、环境、DOM、会话都在）；栏头的 \`✕\` 关掉这一栏（只剩一栏时不显示，免得工作区空掉）`,
    new: `- 每栏栏头那颗胶囊下拉框就是「这一栏显示什么」，**十四个面板全在里面**（瀑布图、统计、脚本、规则、
  控制台、环境、DOM、会话、事件流、WebSocket、接口画像、调用图都在）；栏头的 \`✕\` 关掉这一栏
  （只剩一栏时不显示，免得工作区空掉）`
  },
  {
    file: MAN,
    label: '§4.2 标题与表格补四行',
    old: `### 4.2 十个面板`,
    new: `### 4.2 十四个面板`
  },
  {
    file: MAN,
    label: '§4.2 表格补四行',
    old: `| **会话** | 实例列表、Profile 切换、存储分区与各表行数 |
`,
    new: `| **会话** | 实例列表、Profile 切换、存储分区与各表行数 |
| **事件流** | 导航 / console 告警 / 异常 / 下载 / JS 对话框 / WS 生命周期，按 kind 分组；**对话框在这里应答** |
| **WebSocket** | WS / SSE 的帧：左边连接、右边帧正文（\`sent\` = 页面发出），二进制显示真实字节数 |
| **接口画像** | 三页签：接口聚类画像（状态码 / 耗时 / 参数与请求体字段分布 / 节奏）、契约回归、导出（HAR / JSONL / 资源镜像） |
| **调用图** | 两页签：请求调用图（边权重 + 功能簇）、关联分析（共享响应体 / 跳转链 / 共享参数 / 页面 → 域） |
`
  },
  {
    file: MAN,
    label: '§5.7 验收数字',
    old: `npm run test:smoke    # 全量冒烟：29 条 HTTP 路由 + 25 个 MCP 工具，一条都不落
npm run test:drill    # 纯 MCP 端到端演练（agent 视角）`,
    new: `npm run test:smoke    # 全量冒烟：47 条 HTTP 路由 + 42 个 MCP 工具，一条都不落
npm run test:drill    # 纯 MCP 端到端演练（agent 视角）
npm run test:realtime # 实时分析面（事件流 / WS / 画像 / 调用图 / 导出 / 契约回归）`
  },
  {
    file: MAN,
    label: '插入 §5.9',
    old: `## 6. 环境变量速查
`,
    new: sec59 + `## 6. 环境变量速查
`
  },
  {
    file: MAN,
    label: '§6 补 MONITOR_DOWNLOAD_DIR',
    old: `| \`MONITOR_DATA_DIR\` | 数据目录（库 / 规则 / profile / control.json） | Electron userData |`,
    new: `| \`MONITOR_DATA_DIR\` | 数据目录（库 / 规则 / profile / control.json / exports / downloads / screenshots） | Electron userData |
| \`MONITOR_DOWNLOAD_DIR\` | 被监控页面下载的文件落到哪；设成**空串** = 交回浏览器默认位置 | \`<数据目录>/downloads\` |`
  },
  {
    file: MAN,
    label: '§7.2 路由表标题 29 → 47',
    old: `### 7.2 路由表（29 条）`,
    new: `### 7.2 路由表（47 条）`
  },
  {
    file: MAN,
    label: '§7.2 读表补实时分析路由',
    old: `| \`/dom/tree\` · \`/dom/inspect\` | DOM 树（\`?nodeId=&depth=\`）/ 元素检查（\`?selector=\` 或 \`?nodeId=\`） |
`,
    new: `| \`/dom/tree\` · \`/dom/inspect\` | DOM 树（\`?nodeId=&depth=\`）/ 元素检查（\`?selector=\` 或 \`?nodeId=\`） |
| \`/events\` · \`/events/stats\` | 事件流水 / 按 kind·level 计数。\`since\` 是**自增 id 游标**，用返回的 \`nextSince\` 反复拉就只拿新增 |
| \`/events/stream\` | **SSE** 增量推事件（\`?since=&interval=\`），与轮询读同一份数据 |
| \`/ws\` · \`/ws/connections\` | WS / SSE 帧明细 / 按连接汇总（\`direction\`：\`sent\` = 页面发出） |
| \`/endpoints\` · \`/endpoints/detail\` | 接口画像 / 单端点详情（含响应结构、字段分布） |
| \`/graph\` | 请求调用图（节点 / 边 / 功能簇） |
| \`/relations\` | 关联分析（共享响应体 / 跳转链 / 跨域加载 / 共享参数） |
| \`/contracts\` · \`/contracts/:id\` · \`/contracts/:id/diff\` | 契约快照列表 \`{ rows, total }\` / 取一份 / 与当前比对 |
| \`/exports/download\` | 取回 \`exports/\` 下已导出的文件（\`?path=\`，只允许该目录内） |
`
  },
  {
    file: MAN,
    label: '§7.2 写表补实时分析路由',
    old: `| \`/clear\` · \`/console/clear\` | — | 清采集缓冲（计数同时归零，库里的历史不动）/ 清 console |
`,
    new: `| \`/clear\` · \`/console/clear\` | — | 清采集缓冲（计数同时归零，库里的历史不动）/ 清 console |
| \`/contracts\` | \`{ label, sampleLimit, domain }\` | 给接口契约拍快照，回 \`{ id, endpoints, truncated }\` |
| \`DELETE /contracts/:id\` | — | 删掉一份快照 |
| \`/export/har\` · \`/export/jsonl\` · \`/export/bodies\` | \`{ query, includeBodies, maxRows, dir }\` | 导出 HAR / JSONL / 资源镜像，回落盘**绝对路径**与计数 |
| \`/dialog\` | \`{ accept, promptText }\` | 应答 JS 对话框 —— 不应答页面一直卡着 |
`
  },
  {
    file: MAN,
    label: '§8.3 工具数 25 → 42',
    old: `### 8.3 25 个工具`,
    new: `### 8.3 42 个工具`
  },
  {
    file: MAN,
    label: '§8.3 补实时分析工具组',
    old: `**会话**：\`monitor_sessions\` · \`monitor_switch_profile\` · \`monitor_clear\`
`,
    new: `**会话**：\`monitor_sessions\` · \`monitor_switch_profile\` · \`monitor_clear\`

**实时分析**：\`monitor_events\` · \`monitor_event_stats\` · \`monitor_ws_frames\` ·
\`monitor_ws_connections\` · \`monitor_endpoints\` · \`monitor_endpoint\` · \`monitor_graph\` ·
\`monitor_relations\` · \`monitor_export_har\` · \`monitor_export_jsonl\` ·
\`monitor_collect_resources\` · \`monitor_contract_snapshot\` · \`monitor_contracts\` ·
\`monitor_contract\` · \`monitor_contract_diff\` · \`monitor_contract_delete\` · \`monitor_dialog\`

要「实时」就在 \`monitor_events\` / \`monitor_ws_frames\` 上带 \`since\`，用返回里的 \`nextSince\`
接着调 —— 只拿新增，不重复。
`
  }
]