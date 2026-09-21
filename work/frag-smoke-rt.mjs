  /* ------------------------------------------- MCP：实时分析层工具逐个真调用 */
  console.log('\n== MCP：实时分析层 17 个工具逐个真调用 ==\n')

  const eventsTool = await call('monitor_events', { limit: 3, order: 'asc' })
  check('monitor_events（含 nextSince 游标）', () => {
    assert(eventsTool.res.isError !== true, eventsTool.text?.slice(0, 160))
    assert(Array.isArray(eventsTool.json.rows), 'rows 不是数组')
    assert(typeof eventsTool.json.nextSince === 'number', `nextSince=${eventsTool.json?.nextSince}`)
  })

  const eventStatsTool = await call('monitor_event_stats', {})
  check('monitor_event_stats', () => {
    assert(eventStatsTool.res.isError !== true, eventStatsTool.text?.slice(0, 160))
    assert(typeof eventStatsTool.json.total === 'number', `total=${eventStatsTool.json?.total}`)
    assert(Array.isArray(eventStatsTool.json.rows), 'rows 不是数组')
  })

  const wsFramesTool = await call('monitor_ws_frames', { limit: 3 })
  check('monitor_ws_frames', () => {
    assert(wsFramesTool.res.isError !== true, wsFramesTool.text?.slice(0, 160))
    assert(Array.isArray(wsFramesTool.json.rows), 'rows 不是数组')
  })

  const wsConnsTool = await call('monitor_ws_connections', {})
  check('monitor_ws_connections', () => {
    assert(wsConnsTool.res.isError !== true, wsConnsTool.text?.slice(0, 160))
    assert(Array.isArray(wsConnsTool.json.rows), 'rows 不是数组')
  })

  const endpointsTool = await call('monitor_endpoints', { limit: 5, sort: 'calls' })
  check('monitor_endpoints（端点画像）', () => {
    assert(endpointsTool.res.isError !== true, endpointsTool.text?.slice(0, 160))
    assert(
      (endpointsTool.json.endpoints ?? []).length > 0,
      `端点数=${endpointsTool.json?.endpoints?.length}`
    )
  })

  const endpointTool = await call('monitor_endpoint', { key: endpointsTool.json.endpoints[0].key, sampleLimit: 2 })
  check('monitor_endpoint（按 key 取详情）', () => {
    assert(endpointTool.res.isError !== true, endpointTool.text?.slice(0, 160))
    assert(endpointTool.json.found === true, `found=${endpointTool.json?.found}`)
  })

  const graphTool = await call('monitor_graph', { maxNodes: 200, maxRows: 2000 })
  check('monitor_graph（调用图 + 功能簇）', () => {
    assert(graphTool.res.isError !== true, graphTool.text?.slice(0, 160))
    assert(Array.isArray(graphTool.json.nodes) && Array.isArray(graphTool.json.edges), 'nodes/edges 不是数组')
    assert(Array.isArray(graphTool.json.clusters), '没有 clusters')
  })

  const relationsTool = await call('monitor_relations', { limit: 5, maxRows: 2000 })
  check('monitor_relations（四类关联）', () => {
    assert(relationsTool.res.isError !== true, relationsTool.text?.slice(0, 160))
    for (const key of ['sharedBodies', 'redirectChains', 'domainLinks', 'sharedParams']) {
      assert(Array.isArray(relationsTool.json[key]), `${key} 不是数组`)
    }
  })

  const harTool = await call('monitor_export_har', { includeBodies: true, maxRows: 200 })
  check('monitor_export_har（HAR 落盘）', () => {
    assert(harTool.res.isError !== true, harTool.text?.slice(0, 160))
    assert(harTool.json.path && existsSync(harTool.json.path), `文件不在：${harTool.json?.path}`)
    assert(statSync(harTool.json.path).size === harTool.json.bytes, '报告字节数与文件大小不符')
    assert(harTool.json.entries > 0, `entries=${harTool.json.entries}`)
  })

  const jsonlTool = await call('monitor_export_jsonl', { includeBodies: true, maxRows: 200 })
  check('monitor_export_jsonl（JSONL 落盘）', () => {
    assert(jsonlTool.res.isError !== true, jsonlTool.text?.slice(0, 160))
    assert(jsonlTool.json.path && existsSync(jsonlTool.json.path), `文件不在：${jsonlTool.json?.path}`)
    const lines = readFileSync(jsonlTool.json.path, 'utf8').split('\n').filter(Boolean)
    assert(lines.length === jsonlTool.json.lines, `报告 ${jsonlTool.json.lines} 行 vs 实际 ${lines.length} 行`)
    assert(lines.every((line) => JSON.parse(line)), '有行不是合法 JSON')
  })

  const mirrorTool = await call('monitor_collect_resources', { maxRows: 200 })
  check('monitor_collect_resources（资源镜像 + manifest）', () => {
    assert(mirrorTool.res.isError !== true, mirrorTool.text?.slice(0, 160))
    assert(mirrorTool.json.manifest && existsSync(mirrorTool.json.manifest), `manifest 不在：${mirrorTool.json?.manifest}`)
    assert(mirrorTool.json.files > 0, `一个文件都没落（files=${mirrorTool.json?.files}）`)
  })

  const snapTool = await call('monitor_contract_snapshot', { label: 'smoke-mcp', sampleLimit: 2 })
  check('monitor_contract_snapshot（写快照）', () => {
    assert(snapTool.res.isError !== true, snapTool.text?.slice(0, 160))
    assert(snapTool.json.id > 0, `id=${snapTool.json?.id}`)
  })

  const contractsTool = await call('monitor_contracts', {})
  check('monitor_contracts（列快照）', () => {
    assert(contractsTool.res.isError !== true, contractsTool.text?.slice(0, 160))
    assert(
      (contractsTool.json.rows ?? []).some((row) => row.id === snapTool.json.id),
      '列表里没有刚存的那份'
    )
  })

  const contractTool = await call('monitor_contract', { id: snapTool.json.id })
  check('monitor_contract（读快照内容）', () => {
    assert(contractTool.res.isError !== true, contractTool.text?.slice(0, 160))
    assert(contractTool.json.found === true, `found=${contractTool.json?.found}`)
  })

  const contractDiffTool = await call('monitor_contract_diff', { baseId: snapTool.json.id, sampleLimit: 2 })
  check('monitor_contract_diff（拿刚拍的那份当基线比）', () => {
    assert(contractDiffTool.res.isError !== true, contractDiffTool.text?.slice(0, 160))
    const diff = contractDiffTool.json
    assert(diff.summary, `没有 summary：${contractDiffTool.text?.slice(0, 160)}`)
    for (const key of ['added', 'removed', 'changed']) assert(Array.isArray(diff[key]), `${key} 不是数组`)
    // 基线是刚刚才拍的，中间不可能有接口消失 —— 报了就是回归算法在乱报
    assert(diff.summary.removedEndpoints === 0, `报了 ${diff.summary.removedEndpoints} 个端点消失`)
  })

  const contractDeleteTool = await call('monitor_contract_delete', { id: snapTool.json.id })
  check('monitor_contract_delete', () => {
    assert(contractDeleteTool.res.isError !== true, contractDeleteTool.text?.slice(0, 160))
    assert(contractDeleteTool.json.deleted === 1, `deleted=${contractDeleteTool.json?.deleted}`)
  })

  const dialogTool = await call('monitor_dialog', { accept: true })
  check('monitor_dialog（没有对话框时也如实回话，不报错）', () => {
    assert(dialogTool.res.isError !== true, dialogTool.text?.slice(0, 160))
    assert(typeof dialogTool.json.ok === 'boolean', `ok=${JSON.stringify(dialogTool.json?.ok)}`)
  })
