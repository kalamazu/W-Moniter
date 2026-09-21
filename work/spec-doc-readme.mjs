import { readFileSync } from 'node:fs'
const RD = 'F:/code/chrome/README.md'
const frag = readFileSync('F:/code/chrome/work/frag-doc-readme-rt.md', 'utf8')

export default [
  {
    file: RD,
    label: '当前状态补实时分析面',
    old: `DOM 与元素检查、会话管理也已落地；AI 控制面（本地 HTTP API + MCP server）见 \`docs/AI-控制面.md\`）。
只剩 P4（自编译 + patch）与 P7 未做。`,
    new: `DOM 与元素检查、会话管理也已落地；AI 控制面（本地 HTTP API + MCP server）见 \`docs/AI-控制面.md\`）。
**实时分析面**（事件流 / WebSocket 帧 / 接口画像 / 调用图 / 关联分析 / 契约回归 / 导出）也已落地，
面板与 API 都是增量游标式（见 \`docs/AI-控制面.md\` §3.3）。
只剩 P4（自编译 + patch）与 P7 未做。`
  },
  {
    file: RD,
    label: '能力表补实时分析面',
    old: `| 自由工作区：1–4 栏 / 每栏自选面板（十个面板都在栏头下拉框里）/ 可拖分隔条 / 布局落盘 | ✅ 23/23（\`npm run test:layout\`） |`,
    new: `| 自由工作区：1–4 栏 / 每栏自选面板（十四个面板都在栏头下拉框里）/ 可拖分隔条 / 布局落盘 | ✅ 23/23（\`npm run test:layout\`） |
| 事件流：导航 / console 告警 / 异常 / 下载 / JS 对话框 / WS 生命周期（自增 id 游标增量拉） | ✅ |
| WebSocket 帧采集（双向、二进制按真实字节数、请求体一并采集） | ✅ |
| 接口画像：路径模板聚类 + 状态码 / 耗时分位 + query 与请求体字段分布 + 调用节奏 | ✅ |
| 调用图（边权重 + 功能簇）与关联分析（共享响应体 / 跳转链 / 跨域 / 共享参数） | ✅ |
| 契约快照与回归：跑一遍 → 拍基线 → 改 → 再跑 → diff 出新端点 / 新字段 / 新状态码 | ✅ |
| 导出：HAR 1.2（DevTools 直接打开）/ JSONL / 资源镜像（按内容 hash 去重 + manifest） | ✅ |
| 下载落盘到 \`<数据目录>/downloads/\`（\`MONITOR_DOWNLOAD_DIR\` 可覆盖） | ✅ |
| 实时分析四面板：事件流 / WebSocket / 接口画像 / 调用图 | ✅ 47/47（\`npm run test:realtime\`） |`
  },
  {
    file: RD,
    label: '插入实时分析验收小节',
    old: `## 干预规则（P3）
`,
    new: frag + `## 干预规则（P3）
`
  },
  {
    file: RD,
    label: '命令表补两条',
    old: `npm run test:smoke         # 全量冒烟（59 项：29 条 HTTP 路由 + 25 个 MCP 工具，一条都不落）`,
    new: `npm run test:smoke         # 全量冒烟（76 项：47 条 HTTP 路由 + 42 个 MCP 工具，一条都不落）
npm run test:analytics     # 分析层协议级验收（40 项，纯算不起浏览器）
npm run test:realtime      # 实时分析面验收（47 项，真开 Chrome + 受控 origin + peer origin）`
  },
  {
    file: RD,
    label: '命令表 control/drill 数字',
    old: `npm run test:control       # AI 控制面验收（33 项：HTTP API + MCP，真开浏览器）`,
    new: `npm run test:control       # AI 控制面验收（33 项：HTTP API + MCP，真开浏览器）`
  },
  {
    file: RD,
    label: '环境变量补 MONITOR_DOWNLOAD_DIR',
    old: `| \`MONITOR_DB\` / \`MONITOR_PROFILE_DIR\` | 覆盖库路径 / profile 路径 |`,
    new: `| \`MONITOR_DB\` / \`MONITOR_PROFILE_DIR\` | 覆盖库路径 / profile 路径 |
| \`MONITOR_DOWNLOAD_DIR\` | 被监控页面的下载落到哪，默认 \`<数据目录>/downloads\`；设成空串 = 交回浏览器默认位置 |`
  }
]