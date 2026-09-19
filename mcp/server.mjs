#!/usr/bin/env node
/**
 * MCP server（stdio）：把控制服务的 HTTP API 原样映射成 MCP 工具。
 *
 * 设计取舍：MCP 这一层**不做任何转发以外的事** —— 没有自己的状态、不缓存、
 * 不解释结果，只负责「工具名 → HTTP 请求 → content 文本」。这样 CLI、HTTP、
 * MCP 三条路径的行为天然一致，也便于用同一条验收脚本覆盖。
 *
 * 地址发现顺序：
 *   1. --url / MONITOR_CONTROL_URL（含 token 的话直接可用）
 *   2. <dataDir>/control.json（主进程写在那里的 port + token）
 *   3. MONITOR_DATA_DIR / MONITOR_DB 推断 dataDir
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

const argv = process.argv.slice(2)
function argOf(name) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}

const PROTOCOL_VERSION = '2024-11-05'
const SERVER_INFO = { name: 'chromium-monitor', version: '1.0.0' }

/* --------------------------------------------------------------- 发现端点 */

function candidateDataDirs() {
  const dirs = []
  const explicit = argOf('data-dir') ?? process.env['MONITOR_DATA_DIR']
  if (explicit) dirs.push(explicit)
  const db = process.env['MONITOR_DB']
  if (db) dirs.push(dirname(db))
  const rules = process.env['MONITOR_RULES']
  if (rules) dirs.push(dirname(rules))
  dirs.push(join(process.cwd(), '.userdata'))
  dirs.push(process.cwd())
  return dirs
}

let endpoint = null
/**
 * 端点是不是靠 discovery（读 control.json）找到的。
 *
 * 只有 discovery 来的才允许「失效后重新发现」：`--url` 是用户钉死的，不该被自动换掉。
 */
let discovered = false

function resolveEndpoint() {
  if (endpoint) return endpoint
  const inline = argOf('url') ?? process.env['MONITOR_CONTROL_URL']
  if (inline) {
    const url = new URL(inline)
    endpoint = { base: `${url.protocol}//${url.host}`, token: url.searchParams.get('token') ?? process.env['MONITOR_API_TOKEN'] ?? '' }
    discovered = false
    return endpoint
  }
  for (const dir of candidateDataDirs()) {
    const file = join(dir, 'control.json')
    if (!existsSync(file)) continue
    try {
      const info = JSON.parse(readFileSync(file, 'utf8'))
      if (info?.port && info?.token) {
        endpoint = { base: `http://${info.host ?? '127.0.0.1'}:${info.port}`, token: info.token, dataDir: dir, infoPath: file }
        discovered = true
        return endpoint
      }
    } catch {
      /* 半截文件，继续找 */
    }
  }
  return null
}

function requireEndpoint() {
  const found = resolveEndpoint()
  if (!found) {
    throw new Error(
      '找不到控制服务。请先启动应用（控制服务会把端口和 token 写进 <dataDir>/control.json），' +
        '或用 --url=http://127.0.0.1:<port>?token=<token> / MONITOR_CONTROL_URL 指定。'
    )
  }
  return found
}

/* --------------------------------------------------------------- HTTP 调用 */

/** 端点失效的判据：401/403/404，或应用还没起来时的连接被拒 */
function isStaleEndpoint(error) {
  if (error?.status === 401 || error?.status === 403 || error?.status === 404) return true
  const code = error?.cause?.code ?? ''
  return code === 'ECONNREFUSED' || code === 'ECONNRESET' || /ECONNREFUSED|fetch failed/i.test(error?.message ?? '')
}

async function sendOnce(method, path, { query, body } = {}) {
  const { base, token } = requireEndpoint()
  const url = new URL(path, base)
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }
  }
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const text = await res.text()
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = { ok: false, error: text.slice(0, 500) }
  }
  if (!res.ok) {
    const detail = parsed?.error ?? `HTTP ${res.status}`
    const error = new Error(detail)
    error.status = res.status
    error.payload = parsed
    throw error
  }
  return parsed
}

/**
 * 一次 HTTP 调用；端点失效就重新发现一次再重试。
 *
 * 为什么必须这么做：MCP server 是**长活进程**（Codex 一个会话只起一次），而应用重启
 * 会换 port/token。不重试的话，用户重启一次应用，agent 侧就永久 401 —— 报错还说得
 * 很含糊，看的人只会以为「工具坏了」。只重试一次，且只在 discovery 模式下 ——
 * 应用真没起来时第二次照样抛，如实报错。
 */
async function request(method, path, options = {}) {
  try {
    return await sendOnce(method, path, options)
  } catch (error) {
    if (!discovered || !isStaleEndpoint(error)) throw error
    endpoint = null
    return await sendOnce(method, path, options)
  }
}

/* --------------------------------------------------------------- 工具定义 */

const TOOLS = [
  {
    name: 'monitor_status',
    description:
      '看当前监控会话状态：内核路径与版本、启动参数、当前 target 列表、已采集请求数、Profile、存储健康、控制服务端口。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => request('GET', '/status')
  },
  {
    name: 'monitor_capabilities',
    description: '看当前 Profile 的能力矩阵：哪些 CDP domain 开着、探针能力、输入能力。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => request('GET', '/capabilities')
  },
  {
    name: 'monitor_requests',
    description:
      '按条件查已采集的网络请求（分页）。返回 rows/total/hasMore。常用过滤：urlPattern（子串）、status（如 2xx / 404）、method、resourceType、domain、initiator（谁发起的：script / parser / preload）。',
    inputSchema: {
      type: 'object',
      properties: {
        urlPattern: { type: 'string', description: 'URL 子串过滤' },
        status: { type: 'string', description: '状态码过滤，支持 2xx / 404 / 5xx 这类写法' },
        method: { type: 'string', description: 'HTTP 方法，如 GET / POST' },
        resourceType: { type: 'string', description: '如 XHR / Document / Script / Fetch' },
        domain: { type: 'string', description: '域名过滤' },
        initiator: { type: 'string', description: '发起方类型：script / parser / preload / preflight / other' },
        instance: { type: 'number', description: '只查某个实例 id（默认当前实例）' },
        limit: { type: 'number', description: '每页条数，默认 50，上限 1000' },
        offset: { type: 'number', description: '偏移，默认 0' },
        order: { type: 'string', enum: ['time_desc', 'time_asc', 'size_desc', 'url_asc'], description: '排序，默认 time_desc' }
      },
      additionalProperties: false
    },
    run: ({ limit, offset, order, ...query }) =>
      request('GET', '/requests', { query: { ...query, limit: limit ?? 50, offset: offset ?? 0, order: order ?? 'time_desc' } })
  },
  {
    name: 'monitor_request',
    description: '按 seq 取一条请求的完整详情：请求/响应头、时序、三源关联、上游 IP、TLS、body 摘要。',
    inputSchema: {
      type: 'object',
      properties: { seq: { type: 'number', description: '请求 seq（从 monitor_requests 拿）' } },
      required: ['seq'],
      additionalProperties: false
    },
    run: ({ seq }) => request('GET', `/requests/${Number(seq)}`)
  },
  {
    name: 'monitor_body',
    description: '取某条请求的 body。withData=false 只给摘要与 hash（大 body 省流量）。',
    inputSchema: {
      type: 'object',
      properties: {
        hash: { type: 'string', description: 'body hash（详情里的 bodyRef，或从 monitor_request 拿）' },
        withData: { type: 'boolean', description: '是否带正文，默认 true' }
      },
      required: ['hash'],
      additionalProperties: false
    },
    run: ({ hash, withData }) => request('GET', `/requests/${encodeURIComponent(hash)}/body`, { query: { withData: withData === false ? '0' : '1' } })
  },
  {
    name: 'monitor_fetch_body',
    description: '库里没有 body 时，去浏览器缓冲区现捞一次（只对还没被驱逐的有效）。',
    inputSchema: {
      type: 'object',
      properties: { seq: { type: 'number', description: '请求 seq' } },
      required: ['seq'],
      additionalProperties: false
    },
    run: ({ seq }) => request('GET', `/requests/${Number(seq)}/body-live`)
  },
  {
    name: 'monitor_stats',
    description: '聚合统计：按类型/域/状态分组，含大小与耗时。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => request('GET', '/stats')
  },
  {
    name: 'monitor_timeline',
    description: '取瀑布图时间线（导航 → 各阶段五段网络分段）。',
    inputSchema: {
      type: 'object',
      properties: {
        urlPattern: { type: 'string' },
        limit: { type: 'number', description: '默认 200' }
      },
      additionalProperties: false
    },
    run: ({ urlPattern, limit }) => request('GET', '/timeline', { query: { urlPattern, limit: limit ?? 200 } })
  },
  {
    name: 'monitor_scripts',
    description: '查已采集的 JS 源码（覆盖外链/内联/eval/Worker/SW）。可按 urlPattern / source 过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        urlPattern: { type: 'string' },
        limit: { type: 'number', description: '默认 50' },
        offset: { type: 'number' },
        order: { type: 'string', enum: ['time_desc', 'time_asc', 'size_desc', 'url_asc'] }
      },
      additionalProperties: false
    },
    run: ({ limit, offset, order, ...query }) =>
      request('GET', '/scripts', { query: { ...query, limit: limit ?? 50, offset: offset ?? 0, order: order ?? 'time_desc' } })
  },
  {
    name: 'monitor_script_source',
    description: '按 hash 取某个脚本的源码。',
    inputSchema: {
      type: 'object',
      properties: { hash: { type: 'string' } },
      required: ['hash'],
      additionalProperties: false
    },
    run: ({ hash }) => request('GET', `/scripts/${encodeURIComponent(hash)}`)
  },
  {
    name: 'monitor_console',
    description: '读页面 console 回流（环形缓冲，最多 500 条）。Profile H 下没有 Runtime，会是空的。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => request('GET', '/console')
  },
  {
    name: 'monitor_evaluate',
    description:
      '在页面里求值一个表达式并拿回结果（Profile L 专用；H 没开 Runtime，按设计不可用）。',
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string', description: '要执行的 JS 表达式' } },
      required: ['expression'],
      additionalProperties: false
    },
    run: ({ expression }) => request('POST', '/evaluate', { body: { expression } })
  },
  {
    name: 'monitor_dom_tree',
    description: '取 DOM 树（不给 nodeId 就是文档根；给了就取该节点子树，depth 默认 1）。DOM/CSS/Overlay 按需启用。',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'number', description: '节点 id；省略 = 文档根' },
        depth: { type: 'number', description: '展开深度，默认 1' }
      },
      additionalProperties: false
    },
    run: ({ nodeId, depth }) => request('GET', '/dom/tree', { query: { nodeId, depth } })
  },
  {
    name: 'monitor_dom_inspect',
    description:
      '查一个元素：outerHTML、盒模型、命中样式（含覆盖判定）、计算样式、事件监听器。按 selector 或 nodeId。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS 选择器' },
        nodeId: { type: 'number', description: '或按 nodeId' }
      },
      additionalProperties: false
    },
    run: ({ selector, nodeId }) => request('GET', '/dom/inspect', { query: selector ? { selector } : { nodeId } })
  },
  {
    name: 'monitor_dom_highlight',
    description: '在页面里高亮一个节点（Overlay.highlightNode），方便截图确认。',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'number' },
        on: { type: 'boolean', description: 'true 开 / false 关，默认 true' }
      },
      required: ['nodeId'],
      additionalProperties: false
    },
    run: ({ nodeId, on }) => request('POST', '/dom/highlight', { body: { nodeId, on: on !== false } })
  },
  {
    name: 'monitor_input',
    description:
      '拟人化输入：move / click / type / scroll。走贝塞尔轨迹 + 变速 + 停顿，事件 isTrusted=true。click / type 优先用 selector（元素中心自动解出来），也可以直接给 x/y；type 配 selector 会先聚焦再敲键。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['move', 'click', 'type', 'scroll'] },
        x: { type: 'number' },
        y: { type: 'number' },
        selector: { type: 'string', description: '元素选择器（click / type 用；给了就不用给 x/y）' },
        text: { type: 'string', description: 'type 的文本' },
        deltaY: { type: 'number', description: 'scroll 的滚动量' },
        seed: { type: 'number', description: '同 seed 可复现' }
      },
      required: ['kind'],
      additionalProperties: false
    },
    run: (action) => request('POST', '/input', { body: action })
  },
  {
    name: 'monitor_rules_get',
    description: '读当前规则集（规则 + fixtures + 注入脚本）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => request('GET', '/rules')
  },
  {
    name: 'monitor_rules_set',
    description:
      '整体写入规则集（覆盖式）。动作：block/redirect/delay/rewriteHeaders/rewriteBody/fulfill/mock。写坏了不会生效，会返回 invalid 说明原因。',
    inputSchema: {
      type: 'object',
      properties: { rules: { type: 'object', description: '完整的 RuleSet：{ rules, fixtures, injections }' } },
      required: ['rules'],
      additionalProperties: false
    },
    run: ({ rules }) => request('POST', '/rules', { body: rules })
  },
  {
    name: 'monitor_rules_stats',
    description: '读规则命中统计：命中 / 生效 / 失败 / 成功率。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => request('GET', '/rules/stats')
  },
  {
    name: 'monitor_probe',
    description: '跑检测探针：拿到 CDP 痕迹 / 自动化标记 / 指纹一致性 / 运行环境四组报告，以及是否建议切 Profile。',
    inputSchema: {
      type: 'object',
      properties: {
        viaInject: { type: 'boolean', description: 'true = 走注入 + 信标回传（Profile H 用）' }
      },
      additionalProperties: false
    },
    run: ({ viaInject }) => request('POST', '/probe', { body: { options: viaInject === undefined ? {} : { viaInject } } })
  },
  {
    name: 'monitor_navigate',
    description:
      '让被监控页面跳到一个 URL（只允许 http/https），等 load 事件后返回落地后的 url 与 title —— 重定向之后请求的和落地的可能不是同一个，所以两个都返回。要看一个新页面就从这里开始。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: '目标 URL（http/https）' } },
      required: ['url'],
      additionalProperties: false
    },
    run: ({ url }) => request('POST', '/navigate', { body: { url } })
  },
  {
    name: 'monitor_screenshot',
    description:
      '截图：默认截当前视口，fullPage=true 截整页，给 nodeId 只截那个元素（配合 monitor_dom_highlight 用）。图片落盘在数据目录的 screenshots/ 下并返回绝对路径，同时默认把图片本身作为 image 内容块带回来（太大就只给路径，看 inlineSkipped）。只读，不改页面状态。',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['png', 'jpeg'], description: '默认 png' },
        quality: { type: 'number', description: 'JPEG 质量 1-100，默认 80；PNG 忽略' },
        fullPage: { type: 'boolean', description: '整页截图；超过 16000px 会截断并标 clamped' },
        nodeId: { type: 'number', description: '只截这个节点（来自 monitor_dom_tree / monitor_dom_inspect）' },
        inline: { type: 'boolean', description: '默认 true：把图片作为 image 块带回；false 只要路径' }
      },
      additionalProperties: false
    },
    run: (options) => request('POST', '/screenshot', { body: { inline: true, ...options } }),
    // MCP 的 image 块要单独放：base64 不进 JSON 文本，否则一条消息里同一张图出现两遍
    render: (result) => {
      const { dataBase64, ...meta } = result ?? {}
      return {
        content: [
          { type: 'text', text: JSON.stringify(meta, null, 2) },
          ...(dataBase64
            ? [{ type: 'image', data: dataBase64, mimeType: result?.mimeType ?? 'image/png' }]
            : [])
        ]
      }
    }
  },
  {
    name: 'monitor_sessions',
    description: '会话管理视图：实例列表（含 live 实例）、每实例请求计数、存储分区与各表行数、profile 切换入口。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => request('GET', '/sessions')
  },
  {
    name: 'monitor_switch_profile',
    description:
      '切 Profile（L ↔ H）。注意：这是**收工重启**，不是热切 —— 启动参数、domain 白名单、采集侧 Debugger 通道都钉在浏览器生命周期里。',
    inputSchema: {
      type: 'object',
      properties: { profile: { type: 'string', enum: ['L', 'H'] } },
      required: ['profile'],
      additionalProperties: false
    },
    run: ({ profile }) => request('POST', '/sessions/profile', { body: { profile } })
  },
  {
    name: 'monitor_clear',
    description: '清空本次会话的采集缓冲（不动已落盘的历史）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => request('POST', '/clear')
  }
]

/* --------------------------------------------------------------- MCP 传输 */

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function fail(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } })
}

function textResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return { content: [{ type: 'text', text }] }
}

async function handle(msg) {
  const { id, method, params } = msg
  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO
      })
    case 'notifications/initialized':
    case 'initialized':
      return
    case 'ping':
      return ok(id, {})
    case 'tools/list':
      return ok(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
      })
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name)
      if (!tool) {
        return ok(id, { isError: true, content: [{ type: 'text', text: `没有这个工具：${params?.name}` }] })
      }
      try {
        const result = await tool.run(params?.arguments ?? {})
        // 工具可以自己决定怎么放进 content（截图要额外塞一个 image 块）
        return ok(id, tool.render ? tool.render(result) : textResult(result))
      } catch (error) {
        const detail = error?.payload ? JSON.stringify(error.payload, null, 2) : (error?.message ?? String(error))
        return ok(id, { isError: true, content: [{ type: 'text', text: `${tool.name} 失败：${detail}` }] })
      }
    }
    default:
      if (id === undefined) return
      return fail(id, -32601, `不支持的方法：${method}`)
  }
}

const rl = createInterface({ input: process.stdin })
let queue = Promise.resolve()
rl.on('line', (line) => {
  const text = line.trim()
  if (!text) return
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    return fail(null, -32700, 'JSON 解析失败')
  }
  queue = queue.then(() => handle(msg)).catch((error) => {
    if (msg?.id !== undefined) fail(msg.id, -32603, error?.message ?? String(error))
  })
})
rl.on('close', () => process.exit(0))