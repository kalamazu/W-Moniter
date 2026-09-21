  /* ------------------------- 实时分析面的路由（HTTP 侧同样要通，不能只有 MCP） ------------------------- */

  const eventsRes = await api('GET', '/events?limit=3&order=asc')
  check('GET /events：事件流水 + 增量游标', () => {
    assert(eventsRes.status === 200, `status=${eventsRes.status}`)
    assert(Array.isArray(eventsRes.body.rows), 'rows 不是数组')
    assert(typeof eventsRes.body.nextSince === 'number', `nextSince=${eventsRes.body.nextSince}`)
  })

  const eventsStats = await api('GET', '/events/stats')
  check('GET /events/stats：按 kind 分组的计数', () => {
    assert(eventsStats.status === 200 && typeof eventsStats.body.total === 'number', JSON.stringify(eventsStats.body).slice(0, 160))
  })

  const wsConns = await api('GET', '/ws/connections')
  check('GET /ws/connections：连接汇总', () => {
    assert(wsConns.status === 200 && Array.isArray(wsConns.body.rows), JSON.stringify(wsConns.body).slice(0, 160))
  })

  const wsFrames = await api('GET', '/ws?limit=5')
  check('GET /ws：帧明细', () => {
    assert(wsFrames.status === 200 && Array.isArray(wsFrames.body.rows), JSON.stringify(wsFrames.body).slice(0, 160))
  })

  const epList = await api('GET', '/endpoints?limit=5&sort=calls')
  check('GET /endpoints：接口画像', () => {
    assert(epList.status === 200 && Array.isArray(epList.body.endpoints), JSON.stringify(epList.body).slice(0, 160))
    assert(epList.body.endpoints.length > 0, '一个端点都没有')
  })

  const epDetail = await api('GET', `/endpoints/detail?key=${encodeURIComponent(epList.body.endpoints[0].key)}&sampleLimit=2`)
  check('GET /endpoints/detail：端点详情', () => {
    assert(epDetail.status === 200 && epDetail.body.found === true, JSON.stringify(epDetail.body).slice(0, 160))
  })

  const graph = await api('GET', '/graph?maxRows=2000')
  check('GET /graph：调用图（节点 / 边 / 功能簇）', () => {
    assert(graph.status === 200, `status=${graph.status}`)
    assert(Array.isArray(graph.body.nodes) && Array.isArray(graph.body.edges), '节点 / 边不是数组')
    assert(Array.isArray(graph.body.clusters), '没有 clusters')
  })

  const relations = await api('GET', '/relations?limit=5&maxRows=2000')
  check('GET /relations：四类关联', () => {
    assert(relations.status === 200, `status=${relations.status}`)
    for (const key of ['sharedBodies', 'redirectChains', 'domainLinks', 'sharedParams']) {
      assert(Array.isArray(relations.body[key]), `${key} 不是数组`)
    }
  })

  const snap = await api('POST', '/contracts', { label: 'smoke-http', sampleLimit: 2 })
  check('POST /contracts：拍契约快照', () => {
    assert(snap.status === 200 && snap.body.id > 0, JSON.stringify(snap.body).slice(0, 200))
  })

  const contractList = await api('GET', '/contracts?limit=50')
  check('GET /contracts：列表是 { rows, total }（与其它列表接口同形）', () => {
    assert(contractList.status === 200, `status=${contractList.status}`)
    assert(Array.isArray(contractList.body.rows), `不是 rows：${JSON.stringify(contractList.body).slice(0, 160)}`)
    assert(contractList.body.total === contractList.body.rows.length, `total=${contractList.body.total} vs ${contractList.body.rows.length}`)
    assert(contractList.body.rows.some((row) => row.id === snap.body.id), '列表里没有刚存的那份')
  })

  const contractOne = await api('GET', `/contracts/${snap.body.id}`)
  check('GET /contracts/:id：取快照内容', () => {
    assert(contractOne.status === 200 && contractOne.body.found === true, JSON.stringify(contractOne.body).slice(0, 160))
  })

  const contractDiff = await api('GET', `/contracts/${snap.body.id}/diff?sampleLimit=2`)
  check('GET /contracts/:id/diff：与当前比对', () => {
    assert(contractDiff.status === 200 && contractDiff.body.summary, JSON.stringify(contractDiff.body).slice(0, 160))
    assert(contractDiff.body.summary.removedEndpoints === 0, `报了 ${contractDiff.body.summary.removedEndpoints} 个端点消失`)
  })

  const harOut = await api('POST', '/export/har', { includeBodies: true, maxRows: 200 })
  check('POST /export/har：HAR 落盘', () => {
    assert(harOut.status === 200 && harOut.body.path && existsSync(harOut.body.path), JSON.stringify(harOut.body).slice(0, 200))
    assert(statSync(harOut.body.path).size === harOut.body.bytes, '报告字节数与文件大小不符')
  })

  const jsonlOut = await api('POST', '/export/jsonl', { includeBodies: true, maxRows: 200 })
  check('POST /export/jsonl：JSONL 落盘（行数自洽）', () => {
    assert(jsonlOut.status === 200 && jsonlOut.body.path && existsSync(jsonlOut.body.path), JSON.stringify(jsonlOut.body).slice(0, 200))
    const lines = readFileSync(jsonlOut.body.path, 'utf8').split('\n').filter(Boolean)
    assert(lines.length === jsonlOut.body.lines, `报告 ${jsonlOut.body.lines} 行 vs 实际 ${lines.length} 行`)
  })

  const mirrorOut = await api('POST', '/export/bodies', { maxRows: 200 })
  check('POST /export/bodies：资源镜像 + manifest', () => {
    assert(mirrorOut.status === 200 && mirrorOut.body.manifest && existsSync(mirrorOut.body.manifest), JSON.stringify(mirrorOut.body).slice(0, 200))
    assert(mirrorOut.body.files > 0, `files=${mirrorOut.body.files}`)
  })

  const exportDownload = await fetch(base + '/exports/download?path=' + encodeURIComponent(harOut.body.path), { headers: auth })
  const exportText = await exportDownload.text()
  check('GET /exports/download：导出的文件能取回来（字节数与报告一致）', () => {
    assert(exportDownload.status === 200, `status=${exportDownload.status}`)
    assert(Buffer.byteLength(exportText, 'utf8') === harOut.body.bytes, `${Buffer.byteLength(exportText, 'utf8')} vs ${harOut.body.bytes}`)
  })

  const dialogRes = await api('POST', '/dialog', { accept: true })
  check('POST /dialog：没有对话框时也如实回话', () => {
    assert(dialogRes.status === 200 && typeof dialogRes.body.ok === 'boolean', JSON.stringify(dialogRes.body).slice(0, 160))
  })

  const delContract = await api('DELETE', `/contracts/${snap.body.id}`)
  check('DELETE /contracts/:id：删掉快照', () => {
    assert(delContract.status === 200 && delContract.body.deleted === 1, JSON.stringify(delContract.body).slice(0, 160))
  })

  /* SSE 是手写路由（要拿裸 res 才推得动），所以单独测，不走 api() */
  const sseResult = await (async () => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    try {
      const res = await fetch(base + '/events/stream?interval=300&since=0', { headers: auth, signal: ctrl.signal })
      if (res.status !== 200) return `status=${res.status}`
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let text = ''
      while (!text.includes('event: events') && text.length < 200000) {
        const chunk = await reader.read()
        if (chunk.done) break
        text += decoder.decode(chunk.value, { stream: true })
      }
      await reader.cancel()
      return text.includes('event: events') ? true : `没收到事件帧：${text.slice(0, 120)}`
    } finally {
      clearTimeout(timer)
    }
  })()
  check('GET /events/stream：SSE 真推得动事件', () => {
    assert(sseResult === true, String(sseResult))
  })

  check(`HTTP 覆盖：${hitRoutes.size} 条路由真调用过（含实时分析面 19 条）`, () => {
    const NEEDED = [
      'GET /events', 'GET /events/stats', 'GET /events/stream',
      'GET /ws', 'GET /ws/connections',
      'GET /endpoints', 'GET /endpoints/detail',
      'GET /graph', 'GET /relations',
      'POST /contracts', 'GET /contracts', 'GET /contracts/*', 'GET /contracts/*/diff', 'DELETE /contracts/*',
      'POST /export/har', 'POST /export/jsonl', 'POST /export/bodies', 'GET /exports/download',
      'POST /dialog'
    ]
    for (const need of NEEDED) assert(hitRoutes.has(need), `没走：${need}`)
    // 48 条路由里只有 /sessions/profile 没走（它要收工重启，由 MCP 侧的 monitor_switch_profile 覆盖）
    assert(hitRoutes.size >= 47, `只覆盖了 ${hitRoutes.size} 条`)
  })
