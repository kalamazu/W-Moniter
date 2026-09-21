import { readFileSync } from 'node:fs'
const D = 'F:/code/chrome/docs/设计文档.md'
const sec74 = readFileSync('F:/code/chrome/work/frag-doc-design-74.md', 'utf8')
const d11 = readFileSync('F:/code/chrome/work/frag-doc-design-d11.md', 'utf8')

export default [
  {
    file: D,
    label: '表结构补 ws_frames / contracts 与 events.level',
    old: `| \`events\` | 生命周期事件流水 | \`inst,ts\` |
`,
    new: `| \`events\` | 生命周期事件流水（v7 起带 \`level\`：\`info\` / \`warn\` / \`error\`） | \`inst,ts\` |
| \`ws_frames\` | WebSocket / SSE 的帧（\`direction\` 相对浏览器，二进制 payload 是 base64） | \`inst,ts\`、\`request_id\` |
| \`contracts\` | 接口契约快照（整个契约序列化成一列 JSON） | \`id DESC\` |
`
  },
  {
    file: D,
    label: '插入 §7.4 分析层',
    old: `## 8. 关键设计决策（含踩坑）
`,
    new: sec74 + `## 8. 关键设计决策（含踩坑）
`
  },
  {
    file: D,
    label: '插入 D11',
    old: `## 9. 测试与验收策略
`,
    new: d11 + `## 9. 测试与验收策略
`
  },
  {
    file: D,
    label: '§9.2 分层表补实时分析行',
    old: `| 控制面 | \`test:control\`、\`test:drill\`、\`test:smoke\` | HTTP / MCP 真调用 |
`,
    new: `| 控制面 | \`test:control\`、\`test:drill\`、\`test:smoke\` | HTTP / MCP 真调用 |
| 分析 | \`test:analytics\`、\`test:realtime\` | 前者不起浏览器（纯算），后者真开 Chrome 且 origin 自己记 HTTP + **WS 双向**日志当真值 |
`
  },
  {
    file: D,
    label: '§9.2 冒烟数字',
    old: `\`test:smoke\` 是「一条都不落」的那张网：29 条 HTTP 路由 + 25 个 MCP 工具逐个真调用。
\`test:drill\` 是唯一**纯 MCP** 的端到端演练（agent 视角走完整条链路，到「规则真的生效」为止）。`,
    new: `\`test:smoke\` 是「一条都不落」的那张网：47 条 HTTP 路由 + 42 个 MCP 工具逐个真调用。
\`test:drill\` 是唯一**纯 MCP** 的端到端演练（agent 视角走完整条链路，到「规则真的生效」为止）。

\`test:realtime\` 的做法值得单独说一句：它起一个**受控 origin**，origin 侧记 HTTP access log 与
**双向 WS 帧日志**（自己实现 RFC6455 的握手与编解码，不引第三方库），页面再把「我看到了什么」
回报一份 —— 于是「库里说的」和「服务端说的」可以逐字比对，而不是拿引擎自己的话说服自己。`
  },
  {
    file: D,
    label: '§9.3 端口分区补实时分析',
    old: `- **端口分区**避免撞车：detail \`9487\` · drill \`9488\`/\`9495\` · smoke \`9507\`/\`9498\` · layout \`9721\` · 调试 \`9511–9532\``,
    new: `- **端口分区**避免撞车：detail \`9487\` · drill \`9488\`/\`9495\` · smoke \`9507\`/\`9498\` · layout \`9721\` ·
  realtime origin \`8821\` + CDP \`9730\` + API \`9731\`（跨域那条关联会再起一个随机端口的 peer origin）· 调试 \`9511–9532\``
  }
]