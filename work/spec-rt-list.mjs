const RT = 'F:/code/chrome/scripts/test-realtime.mjs'
export default [
  {
    file: RT,
    label: '契约列表判据跟着新形状走（{rows,total}）',
    old: `    const list = (await api('GET', '/contracts')).body
    assert(list.some((item) => item.id === snap.id && item.label === 'rt-via-mcp'), 'HTTP 侧看不到 MCP 存的快照')`,
    new: `    const list = (await api('GET', '/contracts')).body
    assert(
      (list.rows ?? []).some((item) => item.id === snap.id && item.label === 'rt-via-mcp'),
      \`HTTP 侧看不到 MCP 存的快照：\${JSON.stringify(list).slice(0, 200)}\`
    )`
  }
]