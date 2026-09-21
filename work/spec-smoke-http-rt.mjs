import { readFileSync } from 'node:fs'
const SM = 'F:/code/chrome/scripts/test-smoke.mjs'
const block = readFileSync('F:/code/chrome/work/frag-smoke-http-rt.mjs', 'utf8')
export default [
  {
    file: SM,
    label: 'api() 记录走过的路由',
    old: `  async function api(method, path, body) {
    const res = await fetch(base + path, {`,
    new: `  // 走过的路由都记下来：这样「一条都不落」是**算出来的**，不是手写的数字
  const hitRoutes = new Set()
  const routeOf = (method, path) => method + ' ' + path.split('?')[0].replace(/\/\d+/g, '/*')

  async function api(method, path, body) {
    hitRoutes.add(routeOf(method, path))
    const res = await fetch(base + path, {`
  },
  {
    file: SM,
    label: 'health 也算一条',
    old: `  const health = await fetch(base + '/health')`,
    new: `  hitRoutes.add('GET /health')
  const health = await fetch(base + '/health')`
  },
  {
    file: SM,
    label: 'HTTP 段标题不再写死数字',
    old: `  console.log('== HTTP：47 条路由逐个真调用 ==\\n')`,
    new: `  console.log('== HTTP：路由逐个真调用（含实时分析面 19 条）==\\n')`
  },
  {
    file: SM,
    label: 'HTTP 侧补实时分析路由',
    old: `  /* ------------------------------------------------ MCP：42 个工具逐个真调用 */`,
    new: block + `  /* ------------------------------------------------ MCP：42 个工具逐个真调用 */`
  }
]