const SM = 'F:/code/chrome/scripts/test-smoke.mjs'
export default [
  {
    file: SM,
    label: '列快照断言带上实际返回',
    old: `    assert(
      (contractsTool.json.rows ?? []).some((row) => row.id === snapTool.json.id),
      '列表里没有刚存的那份'
    )`,
    new: `    assert(
      (contractsTool.json.rows ?? []).some((row) => row.id === snapTool.json.id),
      \`列表里没有刚存的那份（id=\${snapTool.json.id}，列表=\${JSON.stringify(contractsTool.json).slice(0, 300)}）\`
    )`
  }
]