const SM = 'F:/code/chrome/scripts/test-smoke.mjs'
export default [
  {
    file: SM,
    label: '修 routeOf 的正则（反斜杠被模板串吃了）',
    old: "  const routeOf = (method, path) => method + ' ' + path.split('?')[0].replace(//d+/g, '/*')",
    new: "  const routeOf = (method, path) => method + ' ' + path.split('?')[0].replace(/\\\\d+/g, '/*')"
  }
]