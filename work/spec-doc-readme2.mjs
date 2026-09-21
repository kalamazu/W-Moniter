const RD = 'F:/code/chrome/README.md'
export default [
  {
    file: RD,
    label: '目录结构：MCP 工具数与 smoke 数字',
    old: `mcp/server.mjs                MCP server（stdio，把控制面映射成 25 个工具）`,
    new: `mcp/server.mjs                MCP server（stdio，把控制面映射成 42 个工具）`
  },
  {
    file: RD,
    label: '目录结构：补两条验收脚本',
    old: `  test-smoke.mjs              全量冒烟（59 项：29 条 HTTP 路由 + 25 个 MCP 工具）`,
    new: `  test-smoke.mjs              全量冒烟（76 项：47 条 HTTP 路由 + 42 个 MCP 工具）
  test-analytics.mjs          分析层协议级验收（40 项，纯算不起浏览器）
  test-realtime.mjs           实时分析面验收（47 项：事件流 / WS / 画像 / 调用图 / 导出 / 契约）`
  },
  {
    file: RD,
    label: '环境变量 UI_TAB 面板清单',
    old: `| \`MONITOR_UI_TAB\` | 开局面板（\`list\` / \`waterfall\` / … / \`sessions\`）；给 list / waterfall 开局是「它 + 详情」两栏，其它单栏铺满。**优先于落盘布局** |`,
    new: `| \`MONITOR_UI_TAB\` | 开局面板（\`list\` / \`waterfall\` / … / \`sessions\` / \`events\` / \`ws\` / \`endpoints\` / \`graph\`）；给 list / waterfall 开局是「它 + 详情」两栏，其它单栏铺满。**优先于落盘布局** |`
  }
]