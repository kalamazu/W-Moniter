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

/**
 * 工具的入参大多是 camelCase，HTTP 那边也认（cookieQueryOf 原样透传）；
 * 布尔要转成 1/0 —— query 里 false 会变成字符串 "false"，下游按真值判会反过来。
 */
function cookieQueryOf(args) {
  const out = {}
  for (const [key, value] of Object.entries(args || {})) {
    if (value === undefined || value === null || value === '') continue
    out[key] = typeof value === 'boolean' ? (value ? '1' : '0') : value
  }
  return out
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
    description: '按明确工作区 ID 读取规则集（规则 + fixtures + 注入脚本）。',
    inputSchema: { type: 'object', properties: { workspaceId: { type: 'string' } }, required: ['workspaceId'], additionalProperties: false },
    run: ({ workspaceId }) => request('GET', `/workspaces/${encodeURIComponent(workspaceId)}/rules`)
  },
  {
    name: 'monitor_rules_set',
    description:
      '整体写入规则集（覆盖式）。动作：block/redirect/delay/rewriteHeaders/rewriteBody/fulfill/mock。写坏了不会生效，会返回 invalid 说明原因。',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: '明确目标工作区' },
        rules: { type: 'object', description: '完整的 RuleSet：{ rules, fixtures, injections }' },
        expectedVersion: { type: 'number', description: '可选工作区版本守卫' },
        idempotencyKey: { type: 'string', description: '重试时复用的幂等键' }
      },
      required: ['workspaceId', 'rules'],
      additionalProperties: false
    },
    run: ({ workspaceId, rules, expectedVersion, idempotencyKey }) => request('POST', `/workspaces/${encodeURIComponent(workspaceId)}/rules`, { body: { set: rules, expectedVersion, idempotencyKey } })
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
    name: 'monitor_workspaces',
    description:
      '列出所有持久工作区及其活动焦点、生命周期状态和 Profile。运行中的后台工作区不会因为 UI 焦点切换而停止。先调用它确定要操作的 workspaceId。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => request('GET', '/workspaces')
  },
  {
    name: 'monitor_action_catalog',
    description: '读取当前可执行动作目录及其 TargetRef 要求。写动作必须明确目标，不能依赖 UI 当前焦点。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => request('GET', '/actions/catalog')
  },
  {
    name: 'monitor_task_diagnostics',
    description: '读取任务日志状态、重启恢复数量与损坏诊断。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => request('GET', '/tasks/diagnostics')
  },
  {
    name: 'monitor_workspace_content_stats',
    description: '按工作区读取内容对象、字节与采集缺口统计。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => request('GET', '/workspaces/content-stats')
  },
  {
    name: 'monitor_auth_ledger',
    description: '读取明确工作区的登录证据、身份与新鲜度；Cookie 线索不等于已验证登录。',
    inputSchema: { type: 'object', properties: { workspaceId: { type: 'string' } }, required: ['workspaceId'], additionalProperties: false },
    run: ({ workspaceId }) => request('GET', `/workspaces/${encodeURIComponent(workspaceId)}/auth`)
  },
  {
    name: 'monitor_extensions',
    description: '读取明确工作区的扩展 Profile 观察、期望和漂移；部分扫描缺失只表示未知。',
    inputSchema: { type: 'object', properties: { workspaceId: { type: 'string' } }, required: ['workspaceId'], additionalProperties: false },
    run: ({ workspaceId }) => request('GET', `/workspaces/${encodeURIComponent(workspaceId)}/extensions`)
  },
  {
    name: 'monitor_extension_set_desired',
    description: '记录明确工作区的扩展期望版本/权限；不安装、卸载或启停。',
    inputSchema: { type: 'object', properties: { workspaceId: { type: 'string' }, extensionId: { type: 'string' }, version: { type: 'string' }, permissions: { type: 'array', items: { type: 'string' } } }, required: ['workspaceId', 'extensionId'], additionalProperties: false },
    run: ({ workspaceId, extensionId, version, permissions }) => request('POST', `/workspaces/${encodeURIComponent(workspaceId)}/extensions/desired`, { body: { extensionId, version, permissions } })
  },
  {
    name: 'monitor_auth_verify_fixture',
    description: '只对明确工作区和本地受控 fixture origin 主动验证登录；不支持任意真实网站。',
    inputSchema: { type: 'object', properties: { workspaceId: { type: 'string' }, origin: { type: 'string' } }, required: ['workspaceId', 'origin'], additionalProperties: false },
    run: ({ workspaceId, origin }) => request('POST', `/workspaces/${encodeURIComponent(workspaceId)}/auth/verify-fixture`, { body: { origin } })
  },
  {
    name: 'monitor_capture_evidence',
    description: '按明确工作区 ID 和请求 seq 读取正文采集或缺口证据。',
    inputSchema: { type: 'object', properties: { workspaceId: { type: 'string' }, seq: { type: 'number' } }, required: ['workspaceId', 'seq'], additionalProperties: false },
    run: ({ workspaceId, seq }) => request('GET', `/workspaces/${encodeURIComponent(workspaceId)}/requests/${Number(seq)}/body-evidence`)
  },
  {
    name: 'monitor_content_verify',
    description: '在指定工作区校验正文 hash、manifest 和所有内容块。',
    inputSchema: { type: 'object', properties: { workspaceId: { type: 'string' }, hash: { type: 'string' } }, required: ['workspaceId', 'hash'], additionalProperties: false },
    run: ({ workspaceId, hash }) => request('GET', `/workspaces/${encodeURIComponent(workspaceId)}/content/${encodeURIComponent(hash)}/verify`)
  },
  {
    name: 'monitor_content_range',
    description: '在指定工作区按字节范围读取正文；end 不包含在内，单次最多 1MiB。',
    inputSchema: { type: 'object', properties: { workspaceId: { type: 'string' }, hash: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' } }, required: ['workspaceId', 'hash', 'start', 'end'], additionalProperties: false },
    run: ({ workspaceId, hash, start, end }) => request('GET', `/workspaces/${encodeURIComponent(workspaceId)}/content/${encodeURIComponent(hash)}/range`, { query: { start, end } })
  },
  {
    name: 'monitor_action_execute',
    description: '执行统一动作协议。用于已在目录中注册的动作；mutation 必须给 target，重试时复用 idempotencyKey。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        input: { type: 'object' },
        target: { type: 'object', description: 'TargetRef，例如 { kind: "workspace", workspaceId }' },
        idempotencyKey: { type: 'string' }
      },
      required: ['action', 'input'],
      additionalProperties: false
    },
    run: (body) => request('POST', '/actions/execute', { body })
  },
  {
    name: 'monitor_task_cancel',
    description: '请求取消尚未完成的统一动作任务；取消只承诺本机停止，远端效果不确定时任务会标记 unknown。',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false
    },
    run: ({ taskId }) => request('POST', `/tasks/${encodeURIComponent(taskId)}/cancel`)
  },
  {
    name: 'monitor_workspace_create',
    description: '创建一个持久工作区。它拥有独立浏览器资料、SQLite、下载、规则和界面偏好；创建本身不会启动浏览器。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '1–80 个字符的工作区名称' },
        profile: { type: 'string', enum: ['L', 'H'], description: '浏览器采集 Profile，默认 L' },
        idempotencyKey: { type: 'string', description: '可选幂等键；重试同一创建动作时必须复用' }
      },
      required: ['name'],
      additionalProperties: false
    },
    run: ({ name, profile, idempotencyKey }) => request('POST', '/workspaces', { body: { name, profile, idempotencyKey } })
  },
  {
    name: 'monitor_workspace_open',
    description: '打开或聚焦一个工作区。已运行的工作区只切换焦点，不重启其浏览器；未运行的工作区会启动自己的受管 Chromium。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '来自 monitor_workspaces 的 workspaceId' } },
      required: ['id'],
      additionalProperties: false
    },
    run: ({ id }) => request('POST', `/workspaces/${encodeURIComponent(id)}/open`)
  },
  {
    name: 'monitor_workspace_suspend',
    description: '停止指定工作区的受管浏览器并保留其资料和历史；不会影响其它运行中的工作区。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '来自 monitor_workspaces 的 workspaceId' } },
      required: ['id'],
      additionalProperties: false
    },
    run: ({ id }) => request('POST', `/workspaces/${encodeURIComponent(id)}/suspend`)
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
  },
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
    description: '按 id 删掉一份契约快照。删了就再也 diff 不了，慎用。',
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
    run: (args) => request('POST', '/dialog', { body: { accept: args.accept !== false, promptText: args.promptText } })
  },

  /* -------------------------------------------------- 站点资源（cookie / 存储） */

  {
    name: 'monitor_cookies',
    description:
      '查 cookie 罐（库里存的镜像）。可按域 / 名字 / 值模糊搜，也可只看会话 cookie、只看「跨站使用过」的、只看分区的。默认按体积降序 —— 排前面的就是最该看的。想看最新值先调 monitor_site_scan。',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: '按名字 / 域 / 值模糊搜' },
        domain: { type: 'string', description: '只看这个域（含子域）' },
        name: { type: 'string' },
        path: { type: 'string' },
        session: { type: 'boolean', description: '只看会话 cookie' },
        crossSite: { type: 'boolean', description: '只看被发往过非自身站点的 cookie' },
        sameSite: { type: 'string', description: 'Strict / Lax / None' },
        secure: { type: 'boolean' },
        httpOnly: { type: 'boolean' },
        partitioned: { type: 'boolean', description: '只看分区 cookie（CHIPS）' },
        sort: { type: 'string', description: 'size / lastSeen / sentCount / domain / name，默认 size' },
        limit: { type: 'number', description: '默认 200' },
        offset: { type: 'number' }
      },
      additionalProperties: false
    },
    run: (args) => request('GET', '/cookies', { query: cookieQueryOf(args) })
  },
  {
    name: 'monitor_cookie_stats',
    description:
      'cookie 画像：总数 / 域数 / 会话与持久 / Secure 与 HttpOnly 覆盖 / SameSite=None 条数 / 跨站使用的条数 / 分区条数 / 总体积，以及最大的、出现域最多的名字、活得最久的、被带出去最多的。研究「谁在跟踪」先看这个。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => request('GET', '/cookies/stats')
  },
  {
    name: 'monitor_cookie_set',
    description:
      '往罐里写一条 cookie（就是自动化里「先登好再测」的那一步）。给 domain 或 url 之一都行；maxAge 为 0 或负数表示立刻作废，不填就是会话 cookie。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        value: { type: 'string' },
        domain: { type: 'string' },
        url: { type: 'string', description: '没给 domain 时用它推域名' },
        path: { type: 'string', description: '默认 /' },
        secure: { type: 'boolean' },
        httpOnly: { type: 'boolean' },
        sameSite: { type: 'string', description: 'Strict / Lax / None' },
        expires: { type: 'number', description: '秒级时间戳' },
        maxAge: { type: 'number', description: '相对现在多少秒后过期；不给 = 会话 cookie' }
      },
      required: ['name'],
      additionalProperties: false
    },
    run: (args) => request('POST', '/cookies', { body: args })
  },
  {
    name: 'monitor_cookie_delete',
    description:
      '按条件删 cookie。至少要给一个条件（name / domain / host / url / path / crossSite）—— 一个都不给会被拒绝，免得手滑清空整个罐。crossSite=true 会删掉所有「跨站使用过」的 cookie，做「清第三方 cookie」用这个。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        domain: { type: 'string', description: '精确匹配域' },
        host: { type: 'string', description: '整站口径：这个域及其子域' },
        path: { type: 'string' },
        url: { type: 'string' },
        crossSite: { type: 'boolean', description: '只删跨站使用过的' }
      },
      additionalProperties: false
    },
    run: (args) =>
      request('DELETE', '/cookies', {
        query: {
          name: args.name,
          domain: args.domain,
          host: args.host,
          path: args.path,
          url: args.url,
          crossSite: args.crossSite === true ? '1' : undefined
        }
      })
  },
  {
    name: 'monitor_sites',
    description:
      '站点资源总览：这个浏览器见过 / 扫过的每个域，各自有多少 cookie、localStorage 有多少键多大、IndexedDB 有几个库、缓存几条、Service Worker 几个、占了多少配额。scanned=false 表示「见过但还没扫过」，调 monitor_site_scan 去扫。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '默认 300' },
        onlyScanned: { type: 'boolean', description: '只看扫过的' }
      },
      additionalProperties: false
    },
    run: ({ limit, onlyScanned }) =>
      request('GET', '/sites', { query: { limit, onlyScanned: onlyScanned === true ? '1' : undefined } })
  },
  {
    name: 'monitor_site_detail',
    description:
      '某个域的全量明细：cookie（含值）、localStorage / sessionStorage 的键值、IndexedDB 的库与 object store 结构、缓存里的 URL 清单、Service Worker 注册、用量与配额。',
    inputSchema: {
      type: 'object',
      properties: { origin: { type: 'string', description: '如 https://example.com（带端口就带端口）' } },
      required: ['origin'],
      additionalProperties: false
    },
    run: ({ origin }) => request('GET', '/sites/detail', { query: { origin } })
  },
  {
    name: 'monitor_site_scan',
    description:
      '去浏览器里真扫一遍并落库：cookie 罐每次都对账，站点存储按域扫（给 origin 就只扫它，否则扫最近有流量的前 limit 个）。任何「分析站点资源」的动作之前都该先跑它 —— 库里的数据是上一次扫描的快照。',
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: '只扫这个域' },
        limit: { type: 'number', description: '不带 origin 时扫几个域，默认 20' },
        cookies: { type: 'boolean', description: 'false 就跳过 cookie 罐对账' }
      },
      additionalProperties: false
    },
    run: (args) => request('POST', '/sites/scan', { body: args })
  },
  {
    name: 'monitor_site_clear',
    description:
      '清一个域的站点数据。types 可选 cookies / local_storage / session_storage / indexeddb / cache_storage / service_workers / file_systems / all；不填等于 all。清完会自动重扫该域，返回的就是清完之后的真相。',
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string' },
        types: { type: 'array', items: { type: 'string' }, description: '不填 = all' }
      },
      required: ['origin'],
      additionalProperties: false
    },
    run: ({ origin, types }) => request('POST', '/sites/clear', { body: { origin, types } })
  },
  {
    name: 'monitor_site_storage_edit',
    description:
      '改 localStorage / sessionStorage：action=set 写一个键、remove 删一个键、clear 清空整块。写完会自动重扫该域。',
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string' },
        area: { type: 'string', description: 'local（默认）或 session' },
        action: { type: 'string', description: 'set / remove / clear' },
        key: { type: 'string' },
        value: { type: 'string' }
      },
      required: ['origin', 'action'],
      additionalProperties: false
    },
    run: ({ origin, area, action, key, value }) =>
      request('POST', '/sites/storage', {
        body: { origin, area: area === 'session' ? 'session' : 'local', action, key, value }
      })
  },
  {
    name: 'monitor_site_idb_delete',
    description: '删掉某个域上的一个 IndexedDB 库（整个库，不是某个表）。',
    inputSchema: {
      type: 'object',
      properties: { origin: { type: 'string' }, name: { type: 'string', description: '库名' } },
      required: ['origin', 'name'],
      additionalProperties: false
    },
    run: ({ origin, name }) => request('POST', '/sites/idb/delete', { body: { origin, name } })
  },
  {
    name: 'monitor_site_cache_delete',
    description: '删 CacheStorage：给 name 删整个缓存，再给 url 就只删那一条。',
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string' },
        name: { type: 'string', description: '缓存名' },
        url: { type: 'string', description: '只删这一条' }
      },
      required: ['origin', 'name'],
      additionalProperties: false
    },
    run: ({ origin, name, url }) => request('POST', '/sites/cache/delete', { body: { origin, name, url } })
  },
  {
    name: 'monitor_site_sw_unregister',
    description: '注销一个 Service Worker 注册（按 scope URL）。做「拿掉 SW 看页面还正常吗」这类实验用。',
    inputSchema: {
      type: 'object',
      properties: { scopeURL: { type: 'string', description: '如 https://example.com/' } },
      required: ['scopeURL'],
      additionalProperties: false
    },
    run: ({ scopeURL }) => request('POST', '/sites/sw/unregister', { body: { scopeURL } })
  },
  {
    name: 'monitor_site_snapshot',
    description:
      '拍一份站点资源快照（cookie 罐 + 站点清单）。拍之前会先扫一遍，免得基线是陈旧数据。之后用 monitor_site_snapshot_diff 比出「多了什么」。',
    inputSchema: {
      type: 'object',
      properties: { label: { type: 'string', description: '给人看的名字，如 "before-login"' } },
      additionalProperties: false
    },
    run: ({ label }) => request('POST', '/sites/snapshots', { body: { label } })
  },
  {
    name: 'monitor_site_snapshots',
    description: '列出站点资源快照（id / 标签 / 时间 / 大小 / 域数 / cookie 数）。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '默认 50' } },
      additionalProperties: false
    },
    run: ({ limit }) => request('GET', '/sites/snapshots', { query: { limit } })
  },
  {
    name: 'monitor_site_snapshot_diff',
    description:
      '拿一份站点快照和「现在的实况」比：新增 / 消失的域、新增 / 消失 / 被改写的 cookie（含改了哪几个字段）、新增 / 消失 / 内容变化的 localStorage 键。summary 里是能直接下判断的数字。',
    inputSchema: {
      type: 'object',
      properties: { baseId: { type: 'number', description: '基线快照 id' } },
      required: ['baseId'],
      additionalProperties: false
    },
    run: ({ baseId }) => request('GET', '/sites/snapshots/' + Number(baseId) + '/diff')
  },
  {
    name: 'monitor_site_snapshot_delete',
    description: '按 id 删掉一份站点快照。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
      additionalProperties: false
    },
    run: ({ id }) => request('DELETE', '/sites/snapshots/' + Number(id))
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
