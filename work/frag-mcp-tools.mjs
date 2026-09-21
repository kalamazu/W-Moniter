  /* ------------------------------------------------ 分析层：事件流与 WS */

  {
    name: 'monitor_events',
    description:
      '事件流：导航、控制台告警、未捕获异常、下载、JS 对话框、WebSocket 生命周期。要「实时」就带上一次返回里的 nextSince 反复调这个工具（只拿新增，不重复）。kind 取值：navigation / console / exception / websocket / download / dialog / target / rule / overflow。注意 console 只收 error/warning/assert，log 类请看 monitor_console。',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'number', description: '只要 id 比它大的事件（增量拉取）。首次传 0' },
        until: { type: 'number', description: '上界（含）' },
        kinds: { type: 'string', description: '逗号分隔的 kind，如 exception,download' },
        level: { type: 'string', description: 'info / warn / error' },
        targetType: { type: 'string', description: 'page / iframe / worker / service_worker' },
        search: { type: 'string', description: '在 url / detail / kind 里做子串匹配' },
        limit: { type: 'number', description: '默认 200，上限 5000' },
        order: { type: 'string', enum: ['asc', 'desc'], description: '默认 asc（时间正序）' }
      },
      additionalProperties: false
    },
    run: (query) => request('GET', '/events', { query })
  },
  {
    name: 'monitor_event_stats',
    description: '事件流按 kind/level 分组的计数与时间范围，另给最新事件 id（当游标用）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => request('GET', '/events/stats')
  },
  {
    name: 'monitor_ws_frames',
    description:
      'WebSocket / SSE 的帧。direction 是相对浏览器说的：sent=页面发出去、received=服务端推过来。二进制帧的 payload 是 base64（binary=true 标出来），size 已换算成真实字节数。',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'number', description: '增量游标（帧 id）' },
        direction: { type: 'string', enum: ['sent', 'received'] },
        requestId: { type: 'string', description: '只看某条连接' },
        opcode: { type: 'number', description: '1=text 2=binary 8=close 9=ping 10=pong' },
        search: { type: 'string', description: '在 url / payload 里做子串匹配' },
        limit: { type: 'number', description: '默认 200' }
      },
      additionalProperties: false
    },
    run: (query) => request('GET', '/ws', { query })
  },
  {
    name: 'monitor_ws_connections',
    description: 'WS 连接汇总（每条连接的收发帧数、二进制帧数、字节数、时间范围）。先列连接再点开看帧。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '默认 50' } },
      additionalProperties: false
    },
    run: ({ limit }) => request('GET', '/ws/connections', { query: { limit: limit ?? 50 } })
  },

  /* ------------------------------------------------------ 分析：接口画像 */

  {
    name: 'monitor_endpoints',
    description:
      '接口画像：按「方法 + 主机 + 路径模板」聚类（/user/42 与 /user/43 会合成 /user/{int}），给出调用次数、状态码分布、耗时 p50/p95、query 与请求体字段分布、调用节奏。做接口梳理、找热点、找轮询都从这儿开始。',
    inputSchema: {
      type: 'object',
      properties: {
        sort: { type: 'string', enum: ['calls', 'p95', 'bytes', 'failed', 'recent', 'name'], description: '默认 calls' },
        minCalls: { type: 'number', description: '至少调用多少次才列出来' },
        limit: { type: 'number', description: '默认 200' },
        maxRows: { type: 'number', description: '最多扫多少行（默认 2 万，上限 10 万）' },
        domain: { type: 'string', description: '只看某个域名' },
        urlPattern: { type: 'string', description: 'URL 子串过滤' },
        method: { type: 'string' },
        resourceType: { type: 'string' }
      },
      additionalProperties: false
    },
    run: ({ sort, minCalls, limit, maxRows, ...query }) =>
      request('GET', '/endpoints', { query: { sort, minCalls, limit, maxRows, ...query } })
  },
  {
    name: 'monitor_endpoint',
    description:
      '单个接口的详情：调用样本、字段分布，以及从真实响应体推断出来的 JSON 形状（responseSchema / responseFields，带 optional 标记）。key 从 monitor_endpoints 拿，形如 "GET api.example.com/api/user/{int}"。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '端点 key（monitor_endpoints 返回里的 key）' },
        sampleLimit: { type: 'number', description: '抽多少条 body 推 schema，默认 3，上限 20' },
        callLimit: { type: 'number', description: '返回多少条调用样本，默认 30' }
      },
      required: ['key'],
      additionalProperties: false
    },
    run: ({ key, sampleLimit, callLimit }) => request('GET', '/endpoints/detail', { query: { key, sampleLimit, callLimit } })
  },
  {
    name: 'monitor_graph',
    description:
      '请求调用图：谁触发了谁（脚本 / 文档 → 接口），边带次数、失败数、平均耗时，另给连通分量（互相牵动的功能簇）。回答「这个接口是谁在调」用它。',
    inputSchema: {
      type: 'object',
      properties: {
        maxNodes: { type: 'number', description: '节点上限，默认 300' },
        maxRows: { type: 'number', description: '最多扫多少行' },
        domain: { type: 'string' },
        urlPattern: { type: 'string' }
      },
      additionalProperties: false
    },
    run: ({ maxNodes, maxRows, ...query }) => request('GET', '/graph', { query: { maxNodes, maxRows, ...query } })
  },
  {
    name: 'monitor_relations',
    description:
      '关联分析：共享响应体（同一份资源/响应被多处用到）、重定向链（同一 requestId 的多跳）、跨域加载关系（谁加载了谁）、跨端点复用的 query 取值（如同一个 trace/session id）。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '每类最多返回多少条，默认 30' },
        maxRows: { type: 'number' }
      },
      additionalProperties: false
    },
    run: ({ limit, maxRows }) => request('GET', '/relations', { query: { limit, maxRows } })
  },

  /* -------------------------------------------------------- 导出与资源采集 */

  {
    name: 'monitor_export_har',
    description:
      '导出 HAR 1.2（Chrome DevTools 能直接打开）。文件落在数据目录 exports/ 下并返回绝对路径；har 里每条都带 _monitor 段（seq / targetType / 关联状态等本地信息）。大站点建议先用 domain / resourceType 收窄。',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: '只要这个域名的请求' },
        urlPattern: { type: 'string' },
        resourceType: { type: 'string' },
        includeBodies: { type: 'boolean', description: '默认 true，把响应正文一起写进去' },
        maxRows: { type: 'number', description: '默认 2 万行' }
      },
      additionalProperties: false
    },
    run: ({ domain, urlPattern, resourceType, includeBodies, maxRows }) =>
      request('POST', '/export/har', {
        body: { query: { domain, urlPattern, resourceType }, includeBodies, maxRows }
      })
  },
  {
    name: 'monitor_export_jsonl',
    description:
      '导出 JSONL：一行一条请求，含完整请求/响应头与 body（二进制用 base64）。比 HAR 好做流式处理，适合丢给脚本再算。',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        urlPattern: { type: 'string' },
        includeBodies: { type: 'boolean', description: '默认 true' },
        maxRows: { type: 'number' }
      },
      additionalProperties: false
    },
    run: ({ domain, urlPattern, includeBodies, maxRows }) =>
      request('POST', '/export/jsonl', { body: { query: { domain, urlPattern }, includeBodies, maxRows } })
  },
  {
    name: 'monitor_collect_resources',
    description:
      '资源采集 / 离线镜像：把匹配到的响应体落成目录里的真文件（按类型分 document/script/image/font/… 子目录，文件名带内容 hash 前缀，同一份内容只写一次），并写一份 manifest.json 记录每个文件来自哪些 URL。返回目录与清单路径。',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        resourceType: { type: 'string', description: '如 Script / Image / Stylesheet / Font' },
        urlPattern: { type: 'string' },
        dir: { type: 'string', description: '不传就用数据目录 exports/ 下的自动命名目录' },
        maxRows: { type: 'number' }
      },
      additionalProperties: false
    },
    run: ({ domain, resourceType, urlPattern, dir, maxRows }) =>
      request('POST', '/export/bodies', { body: { query: { domain, resourceType, urlPattern }, dir, maxRows } })
  },

  /* ------------------------------------------------------------ 契约回归 */

  {
    name: 'monitor_contract_snapshot',
    description:
      '给当前会话的接口契约拍一份快照（端点、状态码、query/请求体字段、响应 JSON 形状）并存在库里，之后用 monitor_contract_diff 比出「改了什么」。做自动化回归就是：跑一遍 → 拍快照 → 改东西 → 再跑 → diff。',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: '给人看的名字，如 "baseline-v1"' },
        sampleLimit: { type: 'number', description: '推响应形状时抽几条 body，默认 3' },
        domain: { type: 'string', description: '只对某个域名拍快照' }
      },
      additionalProperties: false
    },
    run: ({ label, sampleLimit, domain }) =>
      request('POST', '/contracts', { body: { label, sampleLimit, query: { domain } } })
  },
  {
    name: 'monitor_contracts',
    description: '列出已有的契约快照（id / 标签 / 时间 / 大小）。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '默认 50' } },
      additionalProperties: false
    },
    run: ({ limit }) => request('GET', '/contracts', { query: { limit: limit ?? 50 } })
  },
  {
    name: 'monitor_contract',
    description: '取一份契约快照的内容（withSchema=false 只要端点与状态码清单）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: '快照 id' },
        withSchema: { type: 'boolean', description: '默认 true' }
      },
      required: ['id'],
      additionalProperties: false
    },
    run: ({ id, withSchema }) => request('GET', `/contracts/${Number(id)}`, { query: { withSchema: withSchema === false ? '0' : '1' } })
  },
  {
    name: 'monitor_contract_diff',
    description:
      '契约回归：拿一份快照和「现在的实况」比，给出新增/消失的端点、新增/消失的状态码、query 与请求体字段增删、响应字段增删与类型漂移。summary 里是能直接下判断的结论。',
    inputSchema: {
      type: 'object',
      properties: {
        baseId: { type: 'number', description: '基线快照 id' },
        sampleLimit: { type: 'number', description: '推响应形状时抽几条 body，默认 3' },
        domain: { type: 'string' }
      },
      required: ['baseId'],
      additionalProperties: false
    },
    run: ({ baseId, sampleLimit, domain }) =>
      request('GET', `/contracts/${Number(baseId)}/diff`, { query: { sampleLimit, domain } })
  },
  {
    name: 'monitor_contract_delete',
    description: '删掉一份契约快照。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
      additionalProperties: false
    },
    run: ({ id }) => request('DELETE', `/contracts/${Number(id)}`)
  },

  /* -------------------------------------------------------------- 对话框 */

  {
    name: 'monitor_dialog',
    description:
      '应答当前打开的 JS 对话框（alert / confirm / prompt）。页面卡在对话框上时渲染进程被挂住，采集也停了 —— 用 accept=true 放行、false 取消。事件流里 kind=dialog 能看到对话框的内容。',
    inputSchema: {
      type: 'object',
      properties: {
        accept: { type: 'boolean', description: '默认 true（点确定）' },
        promptText: { type: 'string', description: 'prompt 类型时填入的文本' }
      },
      additionalProperties: false
    },
    run: ({ accept, promptText }) => request('POST', '/dialog', { body: { accept: accept !== false, promptText } })
  }
]