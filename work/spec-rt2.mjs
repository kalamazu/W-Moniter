// 实时验收脚本的判据修正：
// 1) 下载现在落在数据目录（不再污染用户下载夹）
// 2) 跨域关联需要真的跨域 —— 另起一个 origin 当 peer
// 3) 导出三条（HAR/JSONL/镜像）以前拿「第一条 json-echo」当靶子，而第一条是 phase1（没有 bonus）。
//    改成「按 json-echo 全集断言」，既验正文是真的、也验 phase2 的 bonus 没在导出里丢
const RT = 'F:/code/chrome/scripts/test-realtime.mjs'

export default [
  {
    file: RT,
    label: '移除 homedir 依赖',
    old: "import { homedir } from 'node:os'\n",
    new: ''
  },
  {
    file: RT,
    label: '起 peer origin，页面 URL 带上跨域靶子',
    old: `mkdirSync(DATA_DIR, { recursive: true })
const origin = await startOrigin(ORIGIN_PORT)
const BASE = \`http://127.0.0.1:\${origin.port}\`
console.log(\`  受控 origin: \${BASE}\`)
console.log(\`  数据目录: \${DATA_DIR}\`)`,
    new: `mkdirSync(DATA_DIR, { recursive: true })
const origin = await startOrigin(ORIGIN_PORT)
const BASE = \`http://127.0.0.1:\${origin.port}\`
// 第二个 origin 只用来被「跨域取图」：同域请求会被有意排除（那不算关联），
// 所以「页面 → 域」这条能力必须有个真的别的域才验得动
const peer = await startOrigin(0)
const REAL_PAGE = \`\${BASE}/realtime.html?peer=\${peer.port}\`
console.log(\`  受控 origin: \${BASE}（peer: http://127.0.0.1:\${peer.port}）\`)
console.log(\`  数据目录: \${DATA_DIR}\`)`
  },
  {
    file: RT,
    label: '下载落盘判据改到数据目录',
    old: `const downloadPath = join(homedir(), 'Downloads', DOWNLOAD_NAME)`,
    new: `// 下载落在「数据目录」下：自动化不该往用户下载夹里丢东西
const downloadPath = join(DATA_DIR, 'downloads', DOWNLOAD_NAME)`
  },
  {
    file: RT,
    label: '监视器首页带 peer',
    old: `    MONITOR_URL: \`\${BASE}/realtime.html\`,`,
    new: `    MONITOR_URL: REAL_PAGE,`
  },
  {
    file: RT,
    label: 'phase2 导航带 peer',
    old: `  await api('POST', '/navigate', { body: { url: \`\${BASE}/realtime.html?phase=2\` } })`,
    new: `  await api('POST', '/navigate', { body: { url: \`\${REAL_PAGE}&phase=2\` } })`
  },
  {
    file: RT,
    label: '跨域关联判据',
    old: `  await check('关联分析：页面与域的对应关系里有 origin 自己', async () => {
    const host = \`127.0.0.1:\${origin.port}\`
    const hit = (relations?.domainLinks ?? []).find((item) => item.host === host)
    assert(hit, \`没有指向 \${host} 的关联：\${JSON.stringify((relations?.domainLinks ?? []).slice(0, 5))}\`)
    assert(hit.count > 0, '次数是 0')
  })`,
    new: `  await check('关联分析：页面跨域取图被关联成「origin 页面 → peer 域」', async () => {
    const frameHost = \`127.0.0.1:\${origin.port}\`
    const host = \`127.0.0.1:\${peer.port}\`
    const rows = relations?.domainLinks ?? []
    const hit = rows.find((item) => item.frameHost === frameHost && item.host === host)
    assert(hit, \`没有 \${frameHost} → \${host} 的关联：\${JSON.stringify(rows.slice(0, 5))}\`)
    assert(hit.count > 0, '次数是 0')
    // 服务端侧真值：peer 确实收到了那次取图，否则上一条只是「库里有条记录」
    assert(peer.requests.some((item) => item.path === '/img1.png'), 'peer 那边没收到取图请求')
    // 同域请求不该被算成关联，否则「关联」就等于「所有请求」
    assert(
      !rows.some((item) => item.host === frameHost),
      \`同域请求被算进了关联：\${JSON.stringify(rows.filter((item) => item.host === frameHost))}\`
    )
  })`
  },
  {
    file: RT,
    label: 'HAR 正文判据',
    old: `    const entry = harJson.log.entries.find((item) => String(item.request?.url ?? '').includes('/api/json-echo'))
    assert(entry, 'HAR 里找不到 json-echo')
    assert(entry.response.status === 200, \`状态码 \${entry.response.status}\`)
    assert(String(entry.response.content.text).includes('"bonus"'), \`HAR 里的正文不是真响应：\${String(entry.response.content.text).slice(0, 80)}\`)`,
    new: `    // 按 json-echo 的「全集」判：phase1 和 phase2 各 3 次，第一条是 phase1（本来就没有 bonus）。
    // 拿第一条去要 bonus 是判据写错了，不是导出错了
    const echoes = harJson.log.entries.filter((item) => String(item.request?.url ?? '').includes('/api/json-echo'))
    assert(echoes.length >= 2, \`HAR 里 json-echo 只有 \${echoes.length} 条\`)
    const entry = echoes[0]
    assert(entry.response.status === 200, \`状态码 \${entry.response.status}\`)
    assert(
      String(entry.response.content.text).includes('"name":"json-echo"'),
      \`HAR 里的正文不是真响应：\${String(entry.response.content.text).slice(0, 80)}\`
    )
    assert(
      echoes.some((item) => String(item.response.content.text).includes('"bonus"')),
      'HAR 里没有任何一条 json-echo 的正文带 bonus'
    )`
  },
  {
    file: RT,
    label: 'JSONL 正文判据',
    old: `    const hit = parsed.find((row) => String(row.url).includes('/api/json-echo'))
    assert(hit, 'JSONL 里找不到 json-echo')
    assert(String(hit.responseBody ?? '').includes('"bonus"'), 'JSONL 里的正文不是真响应')`,
    new: `    const hits = parsed.filter((row) => String(row.url).includes('/api/json-echo'))
    assert(hits.length >= 2, \`JSONL 里 json-echo 只有 \${hits.length} 条\`)
    assert(
      hits.some((row) => String(row.responseBody ?? '').includes('"name":"json-echo"')),
      'JSONL 里的正文不是真响应'
    )
    assert(hits.some((row) => String(row.responseBody ?? '').includes('"bonus"')), 'JSONL 里没有带 bonus 的那几次')`
  },
  {
    file: RT,
    label: '资源镜像正文判据',
    old: `    const entry = manifest.entries.find((item) => item.urls.some((url) => url.includes('/api/json-echo')))
    assert(entry, 'manifest 里没有 json-echo 的响应体')
    const file = join(mirror.dir, entry.file)
    assert(existsSync(file), \`文件不在：\${file}\`)
    const text = readFileSync(file, 'utf8')
    assert(text.includes('"bonus"'), \`落盘的正文不对：\${text.slice(0, 80)}\`)
    assert(text.includes('"echo":{"user":"bob"'), \`phase2 的调用没被采到：\${text.slice(0, 120)}\`)`,
    new: `    // 镜像按「正文指纹」分文件：两轮调用的正文不一样，就该是两份文件
    const entries = manifest.entries.filter((item) => item.urls.some((url) => url.includes('/api/json-echo')))
    assert(entries.length >= 2, \`manifest 里 json-echo 的响应体只有 \${entries.length} 份\`)
    const texts = entries.map((item) => {
      const file = join(mirror.dir, item.file)
      assert(existsSync(file), \`文件不在：\${file}\`)
      return readFileSync(file, 'utf8')
    })
    for (const text of texts) {
      assert(text.includes('"name":"json-echo"'), \`落盘的正文不对：\${text.slice(0, 80)}\`)
    }
    const joined = texts.join('\\n')
    assert(joined.includes('"user":"amy"') && joined.includes('"user":"bob"'), \`两轮调用的正文没都采到：\${joined.slice(0, 160)}\`)
    assert(joined.includes('"bonus"'), 'phase2 的 bonus 字段没落盘')`
  },
  {
    file: RT,
    label: '收工关掉 peer',
    old: `  try {
    await origin.close()
  } catch {
    /* 已经关了 */
  }`,
    new: `  try {
    await origin.close()
  } catch {
    /* 已经关了 */
  }
  try {
    await peer?.close()
  } catch {
    /* 已经关了 */
  }`
  }
]