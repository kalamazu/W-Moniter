const RD = 'F:/code/chrome/README.md'
const API = 'F:/code/chrome/docs/AI-控制面.md'
const MAN = 'F:/code/chrome/docs/使用手册.md'
const D = 'F:/code/chrome/docs/设计文档.md'
export default [
  {
    file: RD,
    label: 'README 命令表 smoke 项数',
    old: `npm run test:smoke         # 全量冒烟（76 项：47 条 HTTP 路由 + 42 个 MCP 工具，一条都不落）`,
    new: `npm run test:smoke         # 全量冒烟（96 项：47 条 HTTP 路由 + 42 个 MCP 工具，一条都不落）`
  },
  {
    file: RD,
    label: 'README 目录结构 smoke 项数',
    old: `  test-smoke.mjs              全量冒烟（76 项：47 条 HTTP 路由 + 42 个 MCP 工具）`,
    new: `  test-smoke.mjs              全量冒烟（96 项：47 条 HTTP 路由 + 42 个 MCP 工具）`
  },
  {
    file: API,
    label: 'AI 控制面 §5 冒烟数字与覆盖说明',
    old: `一条都不落的冒烟在 \`npm run test:smoke\`（**76/76**）：控制面 47 条路由 + MCP 42 个工具
逐个真调用，每条都要给出它自己的真值证据（截图字节数与元数据一致、DOM 树里真有 \`html\`、
规则写完能读回来…）。它盯的是「有没有哪条路根本走不通」，深度交给上面那几条。`,
    new: `一条都不落的冒烟在 \`npm run test:smoke\`（**96/96**）：控制面 47 条路由 + MCP 42 个工具
逐个真调用，每条都要给出它自己的真值证据（截图字节数与元数据一致、DOM 树里真有 \`html\`、
规则写完能读回来、导出文件真的在磁盘上…）。它盯的是「有没有哪条路根本走不通」，深度交给上面那几条。

覆盖是**算出来的**，不是手写的数字：\`api()\` 把每次真实请求的路由记进一个集合，最后断言
「新增的实时分析面 19 条都在里面、总数 ≥ 47」。控制面一共 48 条路由，唯一没走的是
\`POST /sessions/profile\` —— 它要收工重启（几十秒），由 MCP 侧的 \`monitor_switch_profile\` 覆盖。`
  },
  {
    file: MAN,
    label: '使用手册 §5.7 smoke 项数',
    old: `npm run test:smoke    # 全量冒烟：47 条 HTTP 路由 + 42 个 MCP 工具，一条都不落`,
    new: `npm run test:smoke    # 全量冒烟（96 项）：47 条 HTTP 路由 + 42 个 MCP 工具，一条都不落`
  },
  {
    file: D,
    label: '设计文档 §9.2 冒烟数字',
    old: `\`test:smoke\` 是「一条都不落」的那张网：47 条 HTTP 路由 + 42 个 MCP 工具逐个真调用。`,
    new: `\`test:smoke\` 是「一条都不落」的那张网：96 项，47 条 HTTP 路由 + 42 个 MCP 工具逐个真调用
（路由覆盖是运行期算出来的：\`api()\` 记下走过的每条路由，最后断言集合里该有的都在）。`
  }
]