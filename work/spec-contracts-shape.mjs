const CT = 'F:/code/chrome/control/server.mjs'
const RT = 'F:/code/chrome/scripts/test-realtime.mjs'
export default [
  {
    file: CT,
    label: '/contracts 与其它列表接口统一成 {rows,total}',
    old: `route('GET', '/contracts', (_req, { query }) => call('contract.list', { limit: numOpt(query.get('limit')) ?? 100 }, 120000))`,
    new: `// 契约列表也要跟其它列表接口一个形状（{rows,total}）。裸数组会让「列表都返回 rows」
  // 这条通用规则在本接口上破功，agent 每次都得特判
  route(
    'GET',
    '/contracts',
    async (_req, { query }) => {
      const rows = (await call('contract.list', { limit: numOpt(query.get('limit')) ?? 100 }, 120000)) ?? []
      return { rows, total: rows.length }
    }
  )`
  },
  {
    file: RT,
    label: '契约列表一致性：补长度断言，别让两边同时 undefined 混过去',
    old: `    const viaMcp = await mcp.call('monitor_contracts', {})
    assert(JSON.stringify(viaMcp.rows) === JSON.stringify(list.rows), '契约列表两边不一致')`,
    new: `    const viaMcp = await mcp.call('monitor_contracts', {})
    assert(Array.isArray(viaMcp.rows) && viaMcp.rows.length > 0, \`MCP 侧不是非空数组：\${JSON.stringify(viaMcp).slice(0, 200)}\`)
    assert(Array.isArray(list.rows) && list.rows.length > 0, \`HTTP 侧不是非空数组：\${JSON.stringify(list).slice(0, 200)}\`)
    assert(JSON.stringify(viaMcp.rows) === JSON.stringify(list.rows), '契约列表两边不一致')
    assert(viaMcp.total === list.total && list.total === list.rows.length, \`total 对不上：\${viaMcp.total} / \${list.total} / \${list.rows.length}\`)`
  }
]