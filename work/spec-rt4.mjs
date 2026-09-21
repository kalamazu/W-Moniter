const RT = 'F:/code/chrome/scripts/test-realtime.mjs'

export default [
  {
    file: RT,
    label: '加 json-echo 精确匹配helper',
    old: `function assert(condition, message) {
  if (!condition) throw new Error(message)
}`,
    new: `function assert(condition, message) {
  if (!condition) throw new Error(message)
}
/**
 * 是不是 json-echo 本体。不能直接用 includes('/api/json-echo')：
 * 那样会把 /api/json-echo-b 也算进来（判据就会拿错靶子）
 */
const isEcho = (text) => /\\/api\\/json-echo(?:[?#]|$)/.test(String(text ?? ''))`
  },
  {
    file: RT,
    label: '端点定位用 isEcho',
    old: `  const echo = (endpoints?.endpoints ?? []).find((item) => item.key.includes('/api/json-echo'))`,
    new: `  const echo = (endpoints?.endpoints ?? []).find((item) => isEcho(item.key))`
  },
  {
    file: RT,
    label: '调用图边用 isEcho',
    old: `    const edges = (graph?.edges ?? []).filter((edge) => edge.to.includes('/api/json-echo'))`,
    new: `    const edges = (graph?.edges ?? []).filter((edge) => isEcho(edge.to))`
  },
  {
    file: RT,
    label: 'baseline 之前先等 rt-report 入库',
    old: `  const baseContract = (await api('POST', '/contracts', { body: { label: 'rt-phase1', sampleLimit: 10 } })).body`,
    new: `  // 基线必须在「phase1 的回报请求也入库了」之后再取。取早了，/api/rt-report 会晚一步
  // 出现，被误报成「新增端点」—— 那是判据的时序问题，不是回归真的看出了变化
  await waitFor(
    'phase1 的 rt-report 入库',
    async () => {
      const res = await api('GET', '/requests', { query: { urlPattern: '/api/rt-report', limit: 5 } })
      return (res.body?.total ?? 0) >= 1
    },
    20000,
    300
  )

  const baseContract = (await api('POST', '/contracts', { body: { label: 'rt-phase1', sampleLimit: 10 } })).body`
  },
  {
    file: RT,
    label: 'HAR 筛选用 isEcho',
    old: `    const echoes = harJson.log.entries.filter((item) => String(item.request?.url ?? '').includes('/api/json-echo'))`,
    new: `    const echoes = harJson.log.entries.filter((item) => isEcho(item.request?.url))`
  },
  {
    file: RT,
    label: 'JSONL 筛选用 isEcho',
    old: `    const hits = parsed.filter((row) => String(row.url).includes('/api/json-echo'))`,
    new: `    const hits = parsed.filter((row) => isEcho(row.url))`
  },
  {
    file: RT,
    label: '镜像筛选用 isEcho',
    old: `    const entries = manifest.entries.filter((item) => item.urls.some((url) => url.includes('/api/json-echo')))`,
    new: `    const entries = manifest.entries.filter((item) => item.urls.some((url) => isEcho(url)))`
  }
]