const RT = 'F:/code/chrome/scripts/test-realtime.mjs'
export default [
  {
    file: RT,
    label: '契约增删判据跟着新形状走',
    old: `    const list = (await api('GET', '/contracts')).body
    assert(list.some((item) => item.id === baseContract.id), '列表里没有刚存的快照')`,
    new: `    const list = (await api('GET', '/contracts')).body
    assert((list.rows ?? []).some((item) => item.id === baseContract.id), '列表里没有刚存的快照')`
  },
  {
    file: RT,
    label: '删除后判据跟着新形状走',
    old: `    const after = (await api('GET', '/contracts')).body
    assert(!after.some((item) => item.id === baseContract.id), '删了还在')`,
    new: `    const after = (await api('GET', '/contracts')).body
    assert(!(after.rows ?? []).some((item) => item.id === baseContract.id), '删了还在')`
  }
]