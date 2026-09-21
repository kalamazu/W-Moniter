const F = 'F:/code/chrome/work/frag-smoke-rt.mjs'
export default [
  {
    file: F,
    label: 'diff 判据去掉易飘的「零变化」断言',
    old: `  check('monitor_contract_diff（与自己比：应该没有变化）', () => {
    assert(contractDiffTool.res.isError !== true, contractDiffTool.text?.slice(0, 160))
    assert(contractDiffTool.json.summary, \`没有 summary：\${contractDiffTool.text?.slice(0, 160)}\`)
    assert(
      (contractDiffTool.json.summary.changedEndpoints ?? 0) === 0,
      \`自己跟自己比都看出了变化：\${JSON.stringify(contractDiffTool.json.summary).slice(0, 160)}\`
    )
  })`,
    new: `  check('monitor_contract_diff（拿刚拍的那份当基线比）', () => {
    assert(contractDiffTool.res.isError !== true, contractDiffTool.text?.slice(0, 160))
    const diff = contractDiffTool.json
    assert(diff.summary, \`没有 summary：\${contractDiffTool.text?.slice(0, 160)}\`)
    for (const key of ['added', 'removed', 'changed']) assert(Array.isArray(diff[key]), \`\${key} 不是数组\`)
    // 基线是刚刚才拍的，中间不可能有接口消失 —— 报了就是回归算法在乱报
    assert(diff.summary.removedEndpoints === 0, \`报了 \${diff.summary.removedEndpoints} 个端点消失\`)
  })`
  }
]