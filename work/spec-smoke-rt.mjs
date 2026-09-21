import { readFileSync } from 'node:fs'
const SM = 'F:/code/chrome/scripts/test-smoke.mjs'
const block = readFileSync('F:/code/chrome/work/frag-smoke-rt.mjs', 'utf8')

const REQUIRED = `  const REQUIRED_TOOLS = [
    'monitor_status', 'monitor_capabilities', 'monitor_requests', 'monitor_request', 'monitor_body',
    'monitor_fetch_body', 'monitor_stats', 'monitor_timeline', 'monitor_scripts', 'monitor_script_source',
    'monitor_console', 'monitor_evaluate', 'monitor_dom_tree', 'monitor_dom_inspect', 'monitor_dom_highlight',
    'monitor_input', 'monitor_rules_get', 'monitor_rules_set', 'monitor_rules_stats', 'monitor_probe',
    'monitor_navigate', 'monitor_screenshot', 'monitor_sessions', 'monitor_switch_profile', 'monitor_clear',
    'monitor_events', 'monitor_event_stats', 'monitor_ws_frames', 'monitor_ws_connections', 'monitor_endpoints',
    'monitor_endpoint', 'monitor_graph', 'monitor_relations', 'monitor_export_har', 'monitor_export_jsonl',
    'monitor_collect_resources', 'monitor_contract_snapshot', 'monitor_contracts', 'monitor_contract',
    'monitor_contract_diff', 'monitor_contract_delete', 'monitor_dialog'
  ]
`

export default [
  {
    file: SM,
    label: '文件头改成 47 条路由 + 42 个工具',
    old: ` * 全量冒烟：控制面 29 条 HTTP 路由 + MCP 25 个工具，一个都不落。`,
    new: ` * 全量冒烟：控制面 47 条 HTTP 路由 + MCP 42 个工具，一个都不落。`
  },
  {
    file: SM,
    label: 'HTTP 段标题改成 47 条',
    old: `console.log('== HTTP：29 条路由逐个真调用 ==\\n')`,
    new: `console.log('== HTTP：47 条路由逐个真调用 ==\\n')`
  },
  {
    file: SM,
    label: 'MCP 段标题改成 42 个工具',
    old: `  /* ------------------------------------------------ MCP：25 个工具逐个真调用 */
  console.log('\\n== MCP：25 个工具逐个真调用 ==\\n')`,
    new: `  /* ------------------------------------------------ MCP：42 个工具逐个真调用 */
  console.log('\\n== MCP：42 个工具逐个真调用 ==\\n')`
  },
  {
    file: SM,
    label: '工具清单判据显式列出 42 个',
    old: `  check(\`tools/list：25 个工具且都有 description + inputSchema\`, () => {
    assert(tools.length === 25, \`工具数=\${tools.length}\`)
    const bare = tools.filter((tool) => !tool.description || !tool.inputSchema)
    assert(bare.length === 0, \`缺 description/inputSchema：\${bare.map((t) => t.name).join(',')}\`)
  })`,
    new: REQUIRED + `  check(\`tools/list：\${REQUIRED_TOOLS.length} 个工具一个不少，且都有 description + inputSchema\`, () => {
    const names = tools.map((tool) => tool.name)
    for (const name of REQUIRED_TOOLS) assert(names.includes(name), \`缺工具：\${name}\`)
    assert(tools.length === REQUIRED_TOOLS.length, \`工具数=\${tools.length}，清单里是 \${REQUIRED_TOOLS.length}\`)
    const bare = tools.filter((tool) => !tool.description || tool.description.length <= 10 || !tool.inputSchema)
    assert(bare.length === 0, \`description/inputSchema 不合格：\${bare.map((t) => t.name).join(',')}\`)
  })`
  },
  {
    file: SM,
    label: '插入实时分析层 17 个工具的真调用',
    old: `  const clearTool = await call('monitor_clear', {})`,
    new: block + `  const clearTool = await call('monitor_clear', {})`
  }
]