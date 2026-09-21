const M = 'F:/code/chrome/mcp/server.mjs'
export default [
  {
    file: M,
    label: 'monitor_contract_delete 的 description 写清楚（太短会被冒烟判据判成不合格）',
    old: `    description: '删掉一份契约快照。',`,
    new: `    description: '按 id 删掉一份契约快照。删了就再也 diff 不了，慎用。',`
  }
]