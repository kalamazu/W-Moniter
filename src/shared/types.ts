import type {
  WorkspaceCreateInput,
  WorkspaceOverview,
  WorkspaceSummary
} from './contracts/workspace'

export type {
  WorkspaceCreateInput,
  WorkspaceLifecycleState,
  WorkspaceOverview,
  WorkspaceSummary
} from './contracts/workspace'

export type Profile = 'L' | 'H'

/**
 * HTTP 头。值可能是数组：同名头（Set-Cookie 之类）CDP 用一个 \n 拼在一起的
 * 字符串给出来，采集侧会拆成数组，面板按顺序展示。
 */
export type HeaderMap = Record<string, string | string[]>

export interface RequestRecord {
  /** Collector 内单调递增。DB 主键是 (inst, seq)，UI 也拿它当稳定 key。 */
  seq: number
  /** `${sessionId}|${requestId}`。重定向会复用 requestId，所以它不唯一。 */
  key: string
  requestId: string
  sessionId: string | null
  targetId: string
  targetType: string
  frameUrl: string
  url: string
  method: string
  resourceType: string
  /** CDP 给的发起方类型：parser / script / preload / signedExchange / preflight / other */
  initiatorType?: string
  /** 发起链：谁把这个请求发出来的（调用栈）。栈只留前若干帧，见 collector */
  initiator?: InitiatorInfo
  status?: number
  statusText?: string
  mimeType?: string
  startTs: number
  endTs?: number
  durationMs?: number
  encodedDataLength?: number
  fromCache?: boolean
  fromServiceWorker?: boolean
  /**
   * 请求头。来自 CDP 的 Network.requestWillBeSentExtraInfo —— 它**不在**
   * requestWillBeSent 的 params 里，必须单独订阅（见 collector 的 extraInfo 缓冲）。
   */
  reqHeaders?: HeaderMap
  /** 响应头，来自 Network.responseReceivedExtraInfo。缓存/SW 命中时可能没有 */
  respHeaders?: HeaderMap
  /**
   * 请求体原文。来自 requestWillBeSent 的 request.postData（CDP 只在这一处给）。
   * 画像里的「请求体字段分布」与契约回归的「新字段」全靠它。
   */
  reqBody?: string
  failed?: string
  /** 会话结束时还没结束的请求，由收尾逻辑补记，避免整条丢失 */
  canceled?: boolean

  /* ---------------------------------------------------------- P5 代理侧 */

  /**
   * 代理侧的 flow id。三源关联（§4.3）配上的才有。
   * 以 CDP 为主键，代理记录只作补充 —— 反过来说，没有 CDP 记录的那些
   * 会以 mergeState='proxy-only' 的形式单独存在，不丢。
   */
  proxyFlowId?: string
  /**
   * 代理给的网络时序。**CDP 给不了 DNS 和 TLS** —— 这两个字段就是为代理留的（§5.1）。
   * 复用连接上没有 dns/connect/tls，和真实浏览器语义一致；ttfb 是「握手完成到首字节」。
   */
  timings?: NetTimings
  /** 三源关联的结果。cdp-only / proxy-only 都是正常状态，不是错误 */
  mergeState?: 'merged' | 'cdp-only' | 'proxy-only'
  /**
   * 代理 startedAt 与 CDP startTs 的差（ms）。同机同钟，所以这就是「浏览器栈里排队 +
   * 代理建连」那一跳。实测突发并发（189 条）下能到 170ms+，不是常数。
   */
  proxyDeltaMs?: number
  /** 关联窗口内有多个候选 —— 这次配对是猜的，别当成确定事实 */
  mergeAmbiguous?: boolean
  /** 代理侧看到的：上游 IP、TLS 版本/套件、ALPN */
  upstreamIp?: string
  tlsVersion?: string
  tlsCipher?: string
  upstreamAlpn?: string
  /**
   * 这条是收工时由 drain 补报的：响应还没结束（SSE / 流式），
   * 时序天然不完整 —— 有 dns/connect/ttfb，没有 download。别拿它当完整时序画。
   */
  proxyOpen?: boolean
  /** 代理侧的规则命中明细 */
  proxyRuleHits?: Array<{ id: string; applied: boolean; kind?: string; reason?: string }>
}

/** 网络时序（ms）。全部可选：拿不到就不填，不编 0 */
export interface NetTimings {
  dns?: number
  connect?: number
  tls?: number
  ttfb?: number
  download?: number
}

export interface TargetInfo {
  targetId: string
  type: string
  url: string
  attached: boolean
  sessionId: string | null
}

/* -------------------------------------------------------------- 脚本 */

/**
 * 采集到的一段脚本。hash 是源码内容的 sha256 ——
 * 同一个 bundle 在多次会话、多个页面里复用同一行，靠它去重。
 */
export interface ScriptRecord {
  hash: string
  url: string
  /** 源码字节数（V8 报的 length），不是 JS 字符串长度 */
  size: number
  /**
   * 源码在宿主资源里的起始行。
   *
   * 内联 <script> 的 url 是**文档 URL**，不是空串 —— 光看 url 分不出内联。
   * 外部脚本各自是独立资源，永远从第 0 行开始；内联脚本带的是它在 HTML
   * 里的行号。所以 `startLine > 0` 才是内联的判据（DevTools 也是这么分的）。
   */
  startLine?: number
  /** 执行上下文里的 scriptId，只在本会话有效 */
  scriptId?: string
  /** 拿不到源码时（超限 / 拉取失败）不带这个字段，只落元数据 */
  source?: string
}

/** 与 scripts / script_refs 表对齐 */
export interface ScriptRow {
  hash: string
  url: string | null
  size: number
  start_line: number
  /** SQL 里算好的内联判定：url 为空，或起始行不是 0 */
  is_inline: number
  script_id: string | null
  first_seen: number
  seen_count: number
  has_source: number
  source_len: number
}

export interface ScriptQuery {
  search?: string
  hasSource?: boolean
  /** 空 url 的脚本 = 内联脚本 / eval */
  inline?: boolean
  minSize?: number
}

export type ScriptOrder = 'time_desc' | 'time_asc' | 'size_desc' | 'url_asc'

export interface ScriptSource {
  hash: string
  url: string | null
  size: number
  source: string | null
}

export interface ScriptStats {
  total: number
  withSource: number
  sourceBytes: number
  inline: number
}

/* -------------------------------------------------------------- 存储健康度 */

export interface StorageHealth {
  enabled: boolean
  nodePath: string | null
  nodeVersion: string | null
  dbPath: string
  error: string | null
  queueDepth: number
  rowsWritten: number
  /** 同一条请求的 pending 行后来被终态数据更新的次数（不算新行） */
  rowsUpdated: number
  rowsIgnored: number
  droppedRequests: number
  droppedBodies: number
  bodiesStored: number
  bodiesReferenced: number
  bodiesSkipped: number
  bodiesDedupedLocal: number
  /** body 关联因请求行未落库而重试的次数 */
  bodiesRetried: number
  /** 重试到底也没找到请求行、转入收尾处理的条数 */
  bodiesParked: number
  /** 收尾那一次补上的关联条数 */
  bodiesResolvedAtShutdown: number
  /** 收尾也没匹配上、确认真丢了的条数 */
  bodiesUnmatched: number
  /** 脚本：带源码落盘 / 只落元数据 / 超限或超量丢弃 */
  scriptsStored: number
  scriptsMetaOnly: number
  scriptsDropped: number
  scriptQueueDepth: number
  /** 事件流入库条数 / 队列满被丢的条数 */
  eventsStored: number
  eventsDropped: number
  eventQueueDepth: number
  /** WebSocket 帧入库条数 / 被丢的条数 */
  wsFramesStored: number
  wsFramesDropped: number
  wsQueueDepth: number
  lastFlushMs: number
}

export interface BodyCaptureStats {
  paused: number
  captured: number
  capturedBytes: number
  tooLarge: number
  streaming: number
  empty: number
  unmatched: number
  timeouts: number
  errors: number
  inFlight: number
  continueMethod: string
}

/* -------------------------------------------------------------- 导航 */

/** 让页面跳走的返回。url/title 取的是导航历史里的当前项（页面自己报的，能反映重定向） */
export interface NavigateResult {
  ok: boolean
  error?: string
  /** 请求导航的目标 */
  requestedUrl?: string
  /** 落地后的 URL（重定向之后可能与 requestedUrl 不同） */
  url?: string
  title?: string
  durationMs: number
}

/* ------------------------------------------------------------ 发起链 */

/** CDP Network.Initiator.stack.callFrames 里的一帧 */
export interface InitiatorFrame {
  functionName: string
  /** 页面里的脚本 id。Profile H 下拿不到 URL，只能靠它回查 */
  scriptId?: string
  url: string
  lineNumber: number
  columnNumber: number
}

/**
 * 请求的发起链。`type` 是分类（script = 页面脚本发起，parser = 解析 HTML 时发起），
 * `frames` 是「谁调用了它」的调用栈，最上面那帧是最近的一层。
 */
export interface InitiatorInfo {
  type: string
  /** initiator 自己带的定位（有的类型没有栈，只有这个） */
  url?: string
  lineNumber?: number
  columnNumber?: number
  frames: InitiatorFrame[]
  /** 栈被截断过（原始帧数比留下的多） */
  truncated?: boolean
}

/* -------------------------------------------------------------- 查询模型 */

export interface RequestQuery {
  search?: string
  host?: string
  url?: string
  path?: string
  resourceType?: string | string[]
  status?: number | number[]
  excludeStatus?: number[]
  mimeType?: string
  method?: string
  targetType?: string
  initiatorType?: string
  bodyState?: string
  scheme?: string
  statusMin?: number
  statusMax?: number
  since?: number
  until?: number
  minSize?: number
  maxSize?: number
  onlyFailed?: boolean
  onlyPending?: boolean
  hasBody?: boolean
  fromCache?: boolean
  fromSw?: boolean
}

export type RequestOrder =
  | 'time_desc'
  | 'time_asc'
  | 'duration_desc'
  | 'size_desc'
  | 'status_asc'

/** 与 requests 表列对齐；渲染进程直接吃这个结构 */
export interface StoredRequest {
  id: number
  inst: number
  seq: number
  key: string
  request_id: string
  session_id: string | null
  target_id: string
  target_type: string
  frame_url: string
  url: string
  host: string | null
  scheme: string | null
  path: string | null
  query: string | null
  method: string
  resource_type: string | null
  initiator_type: string | null
  /** InitiatorInfo 的 JSON。列表查询不带它，只有详情（SELECT *）会给 */
  initiator_stack: string | null
  priority: string | null
  status: number | null
  status_text: string | null
  mime_type: string | null
  protocol: string | null
  remote_ip: string | null
  remote_port: number | null
  encoded_len: number | null
  decoded_len: number | null
  from_cache: number | null
  from_sw: number | null
  ttfb_ms: number | null
  duration_ms: number | null
  start_ts: number
  end_ts: number | null
  failed: string | null
  canceled: number | null
  body_state: string | null
  body_size: number | null
  body_hash: string | null
  body_trunc: number | null

  /* ---------------------------------------------------------- P5 代理侧 */
  /** merged / cdp-only / proxy-only。null = 这次会话没开代理 */
  merge_state: string | null
  proxy_flow_id: string | null
  /** 代理量的分段耗时（ms）。dns/connect/tls 只在真建连接的那次才有 */
  net_dns_ms: number | null
  net_connect_ms: number | null
  net_tls_ms: number | null
  net_download_ms: number | null
  upstream_ip: string | null
  tls_version: string | null
  tls_cipher: string | null
  upstream_alpn: string | null
  /** 代理 startedAt 与 CDP startTs 的差（ms） */
  proxy_delta_ms: number | null
  merge_ambiguous: number | null
  /** 1 = 收工 drain 补报的长连接，时序不完整（没有 download） */
  proxy_open: number | null
}

export interface Page<T> {
  total: number
  rows: T[]
}

export interface RequestDetail {
  request: StoredRequest & { req_headers: string | null; resp_headers: string | null; req_body: string | null }
  body: { hash: string; size: number; stored: boolean; trunc: boolean } | null
}

export interface BodyPayload {
  hash: string
  size: number
  stored: boolean
  trunc: boolean
  b64?: string
}

export interface StatsGroupRow {
  k: string | number | null
  c: number
  bytes: number
}

export interface Stats {
  total: number
  bytes: number
  avgMs: number
  failed: number
  cached: number
  sw: number
  withBody: number
  by: Record<string, StatsGroupRow[]>
  bodies: { n: number; bytes: number; budgetBytes: number }
  dbBytes: number
}

export interface TimelineRow {
  seq: number
  method: string
  start_ts: number
  end_ts: number | null
  duration_ms: number | null
  ttfb_ms: number | null
  url: string
  host: string | null
  resource_type: string | null
  status: number | null
  target_type: string
  encoded_len: number | null
  failed: string | null

  /* ---- P5：瀑布图要按段落画，代理那几段时序得跟着 timeline 一起过来 ---- */
  merge_state: string | null
  /** 代理看到请求的时刻 - CDP 记到请求的时刻（ms）。两段之间的空档就是浏览器栈里的排队 */
  proxy_delta_ms: number | null
  net_dns_ms: number | null
  net_connect_ms: number | null
  net_tls_ms: number | null
  net_download_ms: number | null
  
/** 1 = 收工 drain 补报的长连接，没有 download（别画成「一下载完就结束」） */
  proxy_open: number | null
}

/* -------------------------------------------------- §7.1 #3 DOM 与元素检查 */

/** DOM 树的一行。树是懒展开的：只有被展开过的节点才会带出子节点 */
export interface DomTreeRow {
  nodeId: number
  parentId: number
  /** 缩进层级，从 0 开始（document 是 0） */
  depth: number
  /** 1=元素 3=文本 8=注释 9=文档 10=doctype */
  nodeType: number
  /** 元素是大写标签名，文本是 #text */
  nodeName: string
  /** `div#app.row` 这样的短标签，UI 直接显示这个 */
  label: string
  /** `html > body > div#app`，元素定位用 */
  path: string
  /** 元素才有 */
  attributes?: Array<[string, string]>
  /** 文本/注释节点的内容预览 */
  preview?: string
  /** 真实子节点数（不是已加载的子节点数） */
  childCount: number
  /** 是否还有没取回来的子节点 —— UI 据此画展开箭头 */
  expandable: boolean
  /** 是否已经被展开过（子节点已在行列表里） */
  expanded: boolean
}

export interface DomBoxModel {
  content: number[]
  padding: number[]
  border: number[]
  margin: number[]
  width: number
  height: number
}

export interface DomMatchedRule {
  /** 规则选择器文本 */
  selector: string
  /** author / user-agent / injected 等 */
  origin: string
  /** 所在样式表（外链 URL 或 inline） */
  source?: string
  properties: Array<[string, string]>
  /** 被后面的规则或元素 style 属性盖掉的属性名（按列表顺序低→高判断） */
  overridden: string[]
}

export interface DomEventListener {
  type: string
  useCapture: boolean
  passive: boolean
  once: boolean
  /** 处理函数的源码/名字预览（V8 的 description） */
  handler?: string
  /** 绑在哪个脚本里（scriptId:line:col）。Profile H 拿不到 URL，只能给这个 */
  location?: string
}

export interface DomInspectResult {
  ok: boolean
  error?: string
  /** 这次为止按需启用了哪些 domain（DOM/CSS/Overlay）。§3.4 把它当证据 */
  enabledDomains: string[]
  node?: DomTreeRow
  outerHTML?: string
  /** outerHTML 是否被截断 */
  outerTruncated?: boolean
  box?: DomBoxModel | null
  /** 命中样式：元素自带 style 属性排最前 */
  matched?: DomMatchedRule[]
  /** 计算样式（全量，UI 自己过滤） */
  computed?: Array<[string, string]>
  listeners?: DomEventListener[]
  /** 页面里挂了几个 listener（DOMDebugger 的原始条数，含 window/document 上的） */
  listenerTotal?: number
  /** 命中样式这一路失败的原因（CDP 命令错，不是「选择器没匹配到」） */
  styleError?: string
  /** 事件监听器这一路失败的原因 */
  listenerError?: string
  highlighted?: boolean
  durationMs: number
}

/* ------------------------------------------------------------ 截图 */

/**
 * 截图参数。三种取景：默认视口 / fullPage=true 整页 / 给了 nodeId 就截那个元素。
 * 元素优先于 fullPage（都给了按元素算）。
 */
export interface ScreenshotOptions {
  format?: 'png' | 'jpeg'
  /** JPEG 质量 1-100，默认 80；PNG 忽略 */
  quality?: number
  /** 整页（按 cssContentSize，超出上限会截断并标 clamped） */
  fullPage?: boolean
  /** 只截这个节点（来自 /dom/tree 或 /dom/inspect 的 nodeId） */
  nodeId?: number
  /** 结果里是否带 base64。默认 false 只给落盘路径 —— MCP 直接回图片块时才需要 */
  inline?: boolean
}

export interface ScreenshotResult {
  ok: boolean
  error?: string
  /** 落盘绝对路径（<dataDir>/screenshots/…） */
  path?: string
  format?: 'png' | 'jpeg'
  mimeType?: string
  /** 文件字节数 */
  bytes?: number
  /** 真实像素尺寸（从图片头里读的，不是 CSS 像素） */
  width?: number
  height?: number
  fullPage?: boolean
  nodeId?: number
  /** 全页截图被高度上限截断过 */
  clamped?: boolean
  /** inline=true 时才有：base64（不带 data: 前缀） */
  dataBase64?: string
  /** 要了 inline 但图太大，只给了路径 */
  inlineSkipped?: string
  durationMs: number
}
/* ---------------------------------------------------- §7.1 #9 会话管理 */

export interface StorageSummary {
  dbPath: string
  /** 数据库文件字节数（含 WAL） */
  dbBytes: number
  /** 各表行数 */
  tables: Array<{ name: string; rows: number }>
  /** body 去重后的总字节 */
  bodyBytes: number
}

export interface InstanceStats {
  inst: number
  requests: number
  bodies: number
  scripts: number
  firstAt: number | null
  lastAt: number | null
}

export interface SessionOverview {
  /** 当前这次会话的 inst（没起来是 0） */
  current: number
  instances: Array<InstanceRow & { stats: InstanceStats | null; live: boolean }>
  storage: StorageSummary | null
  /** 当前会话的 target 明细（会话管理里直接看得到目标） */
  targets: TargetInfo[]
}

export interface InstanceRow {
  id: number
  started_at: number
  ended_at: number | null
  url: string | null
  profile: string | null
  kernel: string | null
  kernel_version: string | null
  user_agent: string | null
  args: string | null
}

/* -------------------------------------------------------------- 状态与 API */

/**
 * 窗口吸附（实现见 src/main/window/dock.ts）。
 *
 * 这不是嵌入 —— 浏览器仍然是独立进程、独立顶层窗口，我们只改它的位置尺寸，
 * 让它视觉上像控制窗口旁边的一栏。之所以不跨进程 SetParent 嵌进去：那样 Chrome
 * 的窗口几何会变得不可控，而抗节流方案（设计文档 D3）恰恰依赖几何是对的
 * （踩过一次 159x27 的坑，不再踩第二次）。
 */
export type DockSide = 'left' | 'right'

export interface DockState {
  /** 用户开着吸附吗（落盘在 <dataDir>/ui-settings.json） */
  enabled: boolean
  /** 助手可用吗（Windows + win/dock-helper.ps1 在位）。false 时 UI 要禁用按钮 */
  available: boolean
  /** 真的抓到浏览器窗口了吗。enabled 但没 attached 说明还没吸上，看 reason */
  attached: boolean
  /** 浏览器贴在哪一侧（= 控制窗口让位让出哪边） */
  side: DockSide
  /** 没吸上的原因：no-window / no-room / not-windows / 具体错误消息 */
  reason?: string
}

/**
 * 工作区里能放进窗格的面板。`detail`（请求详情）也是一等公民 —— 可以单独占一栏，
 * 也可以和请求列表挤在同一栏里并排看。
 */
export type PanelId =
  | 'list'
  | 'waterfall'
  | 'detail'
  | 'scripts'
  | 'stats'
  | 'rules'
  | 'console'
  | 'env'
  | 'dom'
  | 'sessions'
  | 'events'
  | 'ws'
  | 'endpoints'
  | 'graph'
  | 'sites'

/**
 * 工作区布局：几栏 + 每栏占多大。
 *
 * `sizes` 与 `panes` 等长、和为 1；`dir` 决定各栏是左右排还是上下排。
 * 拖分隔条改的就是 `sizes` —— 所以是「用户摆过就记住」，不是每次重开又回到默认。
 */
export interface PanelLayout {
  panes: PanelId[]
  sizes: number[]
  dir: 'row' | 'column'
}

/** 界面偏好。和 rules.json 分开存：规则是面板与验收脚本共用的接口，不该被 UI 偏好的演化节奏绑住 */
export interface UiSettings {
  dock: { enabled: boolean; side: DockSide }
  layout: PanelLayout
}

export type ControllerState = 'idle' | 'launching' | 'connecting' | 'connected' | 'error'

export interface ControllerStatus {
  state: ControllerState
  profile: Profile
  browserPath: string | null
  browserVersion: string | null
  browserArgs: string[]
  userDataDir: string | null
  targets: TargetInfo[]
  requestCount: number
  /** 当前运行的实例 id，查询全部带上它才能只看这一次会话 */
  inst: number
  storage: StorageHealth
  body: BodyCaptureStats
  bodyMode: string
  /** 本次会话采集到的脚本条数（去重前） */
  scriptCount: number
  /** 本次会话写进事件流的条数 */
  eventCount?: number
  /** 本次会话采集到的 WebSocket 帧数（含被上限丢掉的） */
  wsFrameCount?: number
  /** 本地代理（P5）。没开启时 running=false */
  proxy: ProxyStatus
  /** AI 友好面：控制服务（本地 HTTP API / MCP 后端）的地址 */
  control?: ControlEndpoint
  /** 窗口吸附。非 Windows 时也在（available=false），UI 据此禁用按钮而不是点了才报错 */
  dock?: DockState
  error?: string
}

/** 控制服务（`control/server.mjs`）的发现信息，agent 与 MCP server 都读它 */
export interface ControlEndpoint {
  enabled: boolean
  host: string | null
  port: number | null
  /** `<dataDir>/control.json`：里面还有 token */
  infoPath: string | null
  /** MCP server 的入口（stdio 传输） */
  mcp: string | null
}

export interface ProxyStatus {
  /** 此刻进程还在跑吗 */
  running: boolean
  /** 这次会话起过代理吗（summary 是收工后打的，得看这个） */
  started?: boolean
  host: string | null
  port: number | null
  /** 自签证书的 SPKI —— 浏览器就是靠它被 pin 进信任的 */
  spki: string | null
  /** 代理侧观察到的 flow 条数 */
  flows: number
  /** 三源关联的实时统计（§12 的关联率看这里） */
  merge: {
    cdpCount: number
    proxyCount: number
    merged: number
    cdpOnly: number
    proxyOnly: number
    ambiguous: number
    mergeRate: number
  } | null
  /** 全量关联统计。含 Chrome 自身的后台请求（CDP 看不见，会变 proxy-only） */
  rawMerge?: {
    cdpCount: number
    proxyCount: number
    merged: number
    cdpOnly: number
    proxyOnly: number
    ambiguous: number
    mergeRate: number
  } | null
  /** 受控范围（本次观测的 origin） */
  scope?: string
  /** 第一条关联成功记录的网络时序，验收脚本拿它证明 DNS/TLS 真的采到了 */
  timingEvidence?: Record<string, number>
  timingSample?: {
    url: string
    timings: Record<string, number | undefined>
    upstreamIp?: string
    tlsVersion?: string
    proxyDeltaMs?: number
  } | null
  error?: string
}

export interface ControllerApi {
  getStatus(): Promise<ControllerStatus | null>
  onRequests(cb: (batch: RequestRecord[]) => void): () => void
  onStatus(cb: (status: ControllerStatus) => void): () => void
  clear(): Promise<void>

  queryRequests(
    query: RequestQuery,
    limit: number,
    offset: number,
    order: RequestOrder
  ): Promise<Page<StoredRequest> | null>
  getDetail(seq: number): Promise<RequestDetail | null>
  getBody(hash: string, withData: boolean): Promise<BodyPayload | null>
  /** DB 里没有 body 时，回浏览器 buffer 里现捞一次（只对还没被驱逐的有效） */
  fetchBodyNow(seq: number): Promise<{ ok: boolean; state: string }>
  getStats(): Promise<Stats | null>
  queryScripts(
    query: ScriptQuery,
    limit: number,
    offset: number,
    order: ScriptOrder
  ): Promise<Page<ScriptRow> | null>
  getScriptSource(hash: string): Promise<ScriptSource | null>
  getScriptStats(): Promise<ScriptStats | null>
  getTimeline(query: RequestQuery, limit: number): Promise<TimelineRow[]>
  listInstances(): Promise<InstanceRow[]>
  openDataDir(): Promise<void>

  getRules(): Promise<RuleSet | null>
  saveRules(rules: RuleSet): Promise<{ ok: boolean; error?: string; invalid?: RuleProblem[] }>
  getRuleStats(): Promise<RuleStats | null>
  onRules(cb: (rules: RuleSet) => void): () => void

  /* ---- P6 探针与控制台 ---- */
  getCapabilities(): Promise<CapabilitySet | null>
  runProbe(options?: { viaInject?: boolean }): Promise<{
    ok: boolean
    report?: ProbeReport
    error?: string
    via: string
  }>
  evaluate(expression: string): Promise<EvaluateResult>
  getConsole(): Promise<ConsoleEntry[]>
  clearConsole(): Promise<void>
  onConsole(cb: (entry: ConsoleEntry) => void): () => void

  /* ---- P6 拟人化输入 ---- */
  runInput(action: InputAction): Promise<InputReport>

  /* ---- §7.1 #3 DOM 与元素检查 ---- */
  /** 不给 nodeId 就取文档根；给了就取该节点的子树（懒展开，depth 默认 1） */
  domGetTree(
    nodeId?: number,
    depth?: number
  ): Promise<{ ok: boolean; error?: string; rows: DomTreeRow[]; enabledDomains: string[] }>
  /** 按选择器或 nodeId 查一个元素：outerHTML / 盒模型 / 命中样式 / 计算样式 / 事件监听器 */
  domInspect(target: { selector?: string; nodeId?: number }): Promise<DomInspectResult>
  /** 页面里高亮一个节点（Overlay，按需启用） */
  domHighlight(
    nodeId: number,
    on: boolean
  ): Promise<{ ok: boolean; error?: string; enabledDomains: string[] }>

  /* ---- §7.1 #9 会话管理 ---- */
  /** 实例列表 + 每实例计数 + 存储分区 + 当前 target */
  getSessions(): Promise<SessionOverview | null>
  /** 切 Profile 重启：收工 → 换 Profile → 重新起来（库里多一条实例） */
  switchProfile(profile: Profile): Promise<{ ok: boolean; error?: string; profile: Profile }>

  /* ---- Core 0.1：持久工作区 ---- */
  getWorkspaces(): Promise<WorkspaceOverview>
  onWorkspaces(cb: (overview: WorkspaceOverview) => void): () => void
  createWorkspace(input: WorkspaceCreateInput): Promise<WorkspaceSummary>
  /** 打开会关闭当前受管浏览器，并以目标工作区的独立资料目录重新启动。 */
  openWorkspace(id: string): Promise<WorkspaceOverview>
  /** 停止指定工作区的受管浏览器，但保留其资料与历史。 */
  suspendWorkspace(id: string): Promise<WorkspaceOverview>

  /* ---- 自绘标题栏（frame: false）的窗口控制 ---- */
  /** 当前是否最大化。打开时用它对齐真实状态（窗口可能被系统或用户改过） */
  isWindowMaximized(): Promise<boolean>
  windowMinimize(): Promise<void>
  /** 切换最大化/还原，返回**切换后**的状态，省得渲染层自己猜 */
  windowToggleMaximize(): Promise<boolean>
  /** 关闭控制窗口。走正常关闭流程，落盘与收工逻辑不会被绕过 */
  windowClose(): Promise<void>
  /** 最大化状态变化：拖边、双击标题栏、Win+↑ 都会推过来 */
  onWindowMaximized(cb: (maximized: boolean) => void): () => void

  /* ---- 窗口吸附（让浏览器贴在控制窗口旁边） ---- */

  /** 开关吸附，可顺手指定浏览器贴哪一侧；返回落定后的状态 */
  setDock(enabled: boolean, side?: DockSide): Promise<DockState>
  /** 吸附状态变化（吸上 / 掉了 / 换边）。拖动窗口时状态没变就不推，不会每帧打过来 */
  onDock(cb: (state: DockState) => void): () => void

  /* ---- 界面偏好（吸附 + 工作区布局）---- */

  /** 读界面偏好。渲染层启动时读一次，把上次摆好的布局恢复出来 */
/* ---- 站点资源：Cookie 与站点存储 ---- */

  /** 库里存的 cookie 罐（不含实时扫描，要最新值先 scanSiteData） */
  listCookies(options?: { query?: CookieQuery }): Promise<Page<CookieRecord> | null>
  getCookieStats(): Promise<CookieStats | null>
  /** 站点资源总览：见过的域 + 扫过的域 */
  getSiteOrigins(options?: { limit?: number; onlyScanned?: boolean }): Promise<{ rows: SiteOriginRow[]; total: number } | null>
  getSiteDetail(origin: string): Promise<SiteDetail | null>
  /** 去浏览器里真扫一遍（cookie 罐 + 站点存储），把结果落库 */
  scanSiteData(options?: { origin?: string; limit?: number; cookies?: boolean }): Promise<SiteScanReport>
  setCookie(input: CookieInput): Promise<{ ok: boolean; error?: string; scanned?: number }>
  deleteCookies(filter: CookieDeleteFilter): Promise<{ ok: boolean; error?: string; deleted: number }>
  clearSiteData(origin: string, types: SiteDataType[]): Promise<{ ok: boolean; error?: string; origin: string; types: string[] }>
  /** localStorage / sessionStorage 的增删改 */
  editStorage(input: {
    origin: string
    area: 'local' | 'session'
    action: 'set' | 'remove' | 'clear'
    key?: string
    value?: string
  }): Promise<{ ok: boolean; error?: string }>
  deleteIdbDatabase(origin: string, name: string): Promise<{ ok: boolean; error?: string }>
  deleteCache(origin: string, name: string, url?: string): Promise<{ ok: boolean; error?: string }>
  unregisterServiceWorker(scopeURL: string): Promise<{ ok: boolean; error?: string }>
  siteSnapshot(options?: { label?: string }): Promise<SiteSnapshotSummary>
  listSiteSnapshots(limit?: number): Promise<SiteSnapshotSummary[] | null>
  siteSnapshotDiff(baseId: number): Promise<SiteSnapshotDiff | null>
  deleteSiteSnapshot(id: number): Promise<{ deleted: number }>

  uiSettings(): Promise<UiSettings>
  /** 写界面偏好（浅合并），返回落盘后的完整设置 */
  setUiSettings(patch: Partial<UiSettings>): Promise<UiSettings>

  /* ---- 分析层：事件流 / WebSocket / 画像 / 调用图 / 关联 ---- */

  /** 事件流（导航 / 控制台告警 / 异常 / 下载 / 对话框 / WS 生命周期）。since 给增量 */
  queryEvents(query: EventQuery): Promise<EventPage | null>
  getEventStats(): Promise<EventStats | null>
  queryWsFrames(query: WsFrameQuery): Promise<WsFramePage | null>
  getWsConnections(limit?: number): Promise<{ rows: WsConnectionRow[]; total: number } | null>
  getEndpointProfiles(options?: {
    query?: RequestQuery
    sort?: string
    minCalls?: number
    limit?: number
    maxRows?: number
  }): Promise<EndpointPage | null>
  getEndpointDetail(
    key: string,
    options?: { query?: RequestQuery; sampleLimit?: number; callLimit?: number; maxRows?: number }
  ): Promise<EndpointDetail | null>
  getRequestGraph(options?: {
    query?: RequestQuery
    maxRows?: number
    maxNodes?: number
  }): Promise<RequestGraph | null>
  getRelations(options?: { query?: RequestQuery; maxRows?: number; limit?: number }): Promise<RelationReport | null>

  /* ---- 导出与资源采集 ---- */

  exportHar(options?: ExportQuery): Promise<HarExportReport>
  exportJsonl(options?: ExportQuery): Promise<JsonlExportReport>
  /** 把匹配到的响应体落成目录里的真文件 + manifest.json（离线镜像） */
  exportBodies(options?: ExportQuery & { dir?: string }): Promise<ResourceExportReport>

  /* ---- 接口契约：快照 + 回归 ---- */

  contractSnapshot(options?: { label?: string; query?: RequestQuery; sampleLimit?: number }): Promise<ContractSummary>
  listContracts(limit?: number): Promise<ContractListRow[] | null>
  getContract(id: number, withSchema?: boolean): Promise<unknown>
  deleteContract(id: number): Promise<{ deleted: number }>
  contractDiff(options: { baseId: number; query?: RequestQuery; sampleLimit?: number }): Promise<ContractDiff>

  /* ---- 对话框 ---- */

  /** 应答（放行/取消）当前打开的 JS 对话框。不响应的话页面会一直卡住 */
  handleDialog(accept: boolean, promptText?: string): Promise<{ ok: boolean; error?: string }>
}

/* ------------------------------------------------------------------ 干预规则 */

export type RuleStage = 'request' | 'response'

export type RuleActionKind =
  | 'block'
  | 'redirect'
  | 'delay'
  | 'rewriteHeaders'
  | 'rewriteBody'
  | 'fulfill'
  | 'mock'

export interface RuleMatch {
  /** `*` 通配（可跨 `/`）、`?` 单字符；`re:` 前缀则整串按正则处理 */
  urlPattern: string
  method?: string[]
  resourceType?: string[]
  /** 只在 response 阶段有意义 */
  statusCode?: number[]
  /** 发起页面的 URL，glob */
  frameUrl?: string
  targetType?: string[]
}

export type RuleAction =
  | { kind: 'block' }
  | { kind: 'redirect'; to: string }
  | { kind: 'delay'; ms: number }
  | { kind: 'rewriteHeaders'; set?: Record<string, string>; remove?: string[] }
  /** 脚本是一段函数体，拿到 (body, ctx)，return 新的 body */
  | { kind: 'rewriteBody'; script: string }
  | { kind: 'fulfill'; status: number; headers?: Record<string, string>; body: string }
  | { kind: 'mock'; fixture: string }

export interface Rule {
  id: string
  name: string
  enabled: boolean
  /** 数字大的优先；同号按列表顺序。每个阶段只应用命中的第一条 */
  priority: number
  match: RuleMatch
  stage: RuleStage
  action: RuleAction
}

export interface MockFixture {
  status?: number
  headers?: Record<string, string>
  body: string
}

export interface Injection {
  id: string
  name: string
  enabled: boolean
  /** 空串 = 所有文档 */
  urlPattern: string
  code: string
  /** document_start 走 addScriptToEvaluateOnNewDocument（Profile H 也支持） */
  runAt: 'document_start' | 'document_ready'
}

export interface RuleSet {
  version: number
  rules: Rule[]
  fixtures: Record<string, MockFixture>
  injections: Injection[]
}

export interface RuleProblem {
  ruleId: string
  ruleName: string
  message: string
}

export interface RuleHit {
  ts: number
  ruleId: string
  ruleName: string
  kind: string
  url: string
  ok: boolean
  detail?: string
  durationMs: number
}

export interface RuleStats {
  enabled: boolean
  /** 已编译进匹配器的条数 */
  total: number
  /** 被丢弃的规则（正则不合法、动作和阶段对不上等） */
  invalid: RuleProblem[]
  matched: number
  applied: number
  failed: number
  timeouts: number
  blocked: number
  redirected: number
  fulfilled: number
  delayed: number
  headersRewritten: number
  bodiesRewritten: number
  /** 二进制响应跳过改写（base64 往返会把字节改坏） */
  skippedBinary: number
  injections: number
  avgMatchUs: number
  maxMatchUs: number
  /** 最近若干条命中，给面板看 */
  recent: RuleHit[]
}

/* ------------------------------------------------------------- 探针与自动化 */

export type ProbeStatus = 'pass' | 'warn' | 'fail' | 'info'

export interface ProbeCheck {
  id: string
  /** CDP 痕迹 / 自动化标记 / 指纹一致性 / 运行环境 */
  group: string
  label: string
  status: ProbeStatus
  value: unknown
  detail: string
}

export interface ProbeSummary {
  pass: number
  warn: number
  fail: number
  info: number
}

/**
 * 探针报告。页面侧生成，容器只负责加 profile 字段。
 * `fingerprint` 是字典结构，字段随探针版本演化，UI 按需取值。
 */
export interface ProbeReport {
  version: number
  run: string
  ts: number
  durationMs: number
  url: string
  title: string
  readyState: string
  /** 控制器填：报告是在哪个 Profile 下跑出来的 */
  profile?: string
  checks: ProbeCheck[]
  fingerprint: Record<string, unknown>
  summary: ProbeSummary
  /** 按硬痕迹推断的**最小够用** profile */
  recommend: 'L' | 'H'
  reason: string
}

/** 控制台里的一条输出。Runtime 域的事件归一化之后长这样 */
export interface ConsoleEntry {
  id: number
  ts: number
  level: string
  text: string
  url?: string
  line?: number
  targetType?: string
}

export interface EvaluateResult {
  ok: boolean
  type?: string
  /** returnByValue 拿到的值；不可序列化时为 undefined，看 description */
  value?: unknown
  description?: string
  error?: string
  durationMs: number
}

/** §3.2 的能力矩阵在运行时的投影。UI 据此禁用按钮，而不是让用户点了报错 */
export interface CapabilitySet {
  profile: Profile
  runtime: boolean
  debugger: boolean
  emulation: boolean
  /** 探针走哪条通道：evaluate / inject */
  probe: string
  probeVia: 'evaluate' | 'inject'
  input: boolean
  captureScripts: boolean
  dom: 'full' | 'ondemand'
  /** 截图通道可用（页面起来了就有） */
  screenshot: boolean
  /** 站点资源（cookie / 存储）读写可用。Storage 域不在 §3.4 红线里，两个 Profile 都有 */
  siteData: boolean
}

export type InputKind = 'move' | 'click' | 'type' | 'scroll'

export interface InputAction {
  kind: InputKind
  x?: number
  y?: number
  /**
   * 用选择器代替坐标：先把元素中心解出来再动。
   * agent 说「点那个按钮」比「点 (660, 322)」稳 —— 坐标写死在调用里，页面一改就失效。
   * type 会先点一下聚焦，再敲键。
   */
  selector?: string
  text?: string
  deltaY?: number
  /** 固定 seed 可以让行为验收复现同一条轨迹 */
  seed?: number
  /** >1 更快，<1 更慢 */
  speed?: number
  jitter?: number
  overshoot?: boolean
}


/* ------------------------------------------------- 事件流与 WebSocket */

/** 事件流的 kind。列成联合类型是为了让采集侧和面板别各写一套字符串 */
export type MonitorEventKind =
  | 'navigation'
  | 'console'
  | 'exception'
  | 'websocket'
  | 'download'
  | 'dialog'
  | 'target'
  | 'rule'
  | 'overflow'
  /** cookie 罐的变化（种上 / 改写 / 过期 / 被策略拦下） */
  | 'cookie'
  /** 站点存储的变化（localStorage 逐键，缓存 / IndexedDB / SW 是域级） */
  | 'storage'

export interface MonitoredEvent {
  /** 库里的自增 id（增量拉取的游标）。刚采集还没落库时没有 */
  id?: number
  ts: number
  kind: MonitorEventKind
  level?: 'info' | 'warn' | 'error'
  targetType?: string
  url?: string
  detail?: unknown
}

export interface EventQuery {
  /** 只管要 id 比它大的（增量拉取）。上一次返回里的 nextSince 直接拿来用 */
  since?: number
  until?: number
  kinds?: MonitorEventKind[]
  kind?: MonitorEventKind
  level?: string
  targetType?: string
  search?: string
  limit?: number
  order?: 'asc' | 'desc'
}

export interface EventPage {
  rows: MonitoredEvent[]
  /** 库里当前最大的事件 id */
  latest: number
  /** 下一次该带的 since */
  nextSince: number
  total: number
}

export interface EventStats {
  rows: Array<{
    kind: string
    level: string | null
    count: number
    firstTs: number | null
    lastTs: number | null
    latestId: number
  }>
  latest: number
  total: number
}

export interface WsFrameRecord {
  seq?: number
  ts: number
  requestId: string
  url?: string
  direction: 'sent' | 'received'
  opcode: number
  /** 文本帧是原文；二进制帧是 base64（CDP 的约定），用 binary 区分 */
  payload: string
  /** 真实载荷字节数（二进制帧已按 base64 换算回解码后的长度） */
  size: number
  truncated: boolean
  binary: boolean
}

export interface WsFrameRow extends WsFrameRecord {
  id: number
  opcodeName: string
}

export interface WsFrameQuery {
  since?: number
  direction?: string
  requestId?: string
  opcode?: number
  search?: string
  limit?: number
  order?: 'asc' | 'desc'
}

export interface WsFramePage {
  rows: WsFrameRow[]
  latest: number
  nextSince: number
  total: number
}

/** 一条 WS 连接的汇总。面板先列连接、点开再看帧 */
export interface WsConnectionRow {
  requestId: string
  url: string
  frames: number
  sent: number
  received: number
  binaryFrames: number
  truncatedFrames: number
  bytes: number
  firstTs: number
  lastTs: number
  seq: number | null
}

/* ------------------------------------------------------------ 接口画像 */

export interface FieldDistribution {
  name: string
  count: number
  /** 每一个「有 body / 有 query」的样本里都出现才算必填 */
  required: boolean
  values: string[]
}

/** JSON 形状。object 带 fields、array 带 items，其余 t 就是叶子类型 */
export interface JsonSchemaNode {
  t: string
  count?: number
  seen?: number
  len?: number
  items?: JsonSchemaNode | null
  fields?: Record<string, JsonSchemaNode>
  of?: JsonSchemaNode[]
}

export interface SchemaPath {
  path: string
  type: string
  /** 样本里不是每次都有 */
  optional: boolean
}

export interface EndpointProfile {
  key: string
  calls: number
  distinctUrls: number
  sampleUrls: string[]
  samples: number[]
  statuses: Array<{ key: string; count: number }>
  mimeTypes: Array<{ key: string; count: number }>
  resourceTypes: Array<{ key: string; count: number }>
  targetTypes: Array<{ key: string; count: number }>
  durationMs: { p50: number | null; p95: number | null; min: number | null; max: number | null }
  bytes: number
  decodedBytes: number
  failed: number
  cached: number
  fromSw: number
  withBody: number
  query: FieldDistribution[]
  requestBody: {
    samples: number
    kinds: Array<{ key: string; count: number }>
    fields: FieldDistribution[]
  }
  /** 调用节奏（中位间隔）。看的是「这个接口是不是在被轮询」 */
  rhythm: { medianGapMs: number; spanMs: number } | null
  firstTs: number | null
  lastTs: number | null
}

export interface EndpointPage {
  endpoints: EndpointProfile[]
  /** 过滤后剩下的端点数（可能大于返回的条数） */
  matched: number
  scanned: number
  total: number
  /** 实例里还有行没被扫到（maxRows 之外） */
  truncated: boolean
  sort: string
}

export interface EndpointCallSample {
  seq: number
  ts: number
  url: string
  status: number | null
  durationMs: number | null
  ttfbMs: number | null
  bytes: number | null
  fromCache: boolean
  fromSw: boolean
  bodyState: string | null
  targetType: string | null
  failed: string | null
}

export interface EndpointDetail {
  key: string
  found: boolean
  error?: string
  totalCalls?: number
  profile?: EndpointProfile
  recent?: EndpointCallSample[]
  responseSchema?: JsonSchemaNode | null
  responseFields?: SchemaPath[]
  responseSamples?: number
  responseSamplesSkipped?: number
  requestSchema?: JsonSchemaNode | null
  requestSamples?: number
  truncated?: boolean
}

/* -------------------------------------------------------------- 调用图 */

export interface GraphNode {
  key: string
  /** endpoint / script / document / 其它 initiator 类型 */
  kind: string
  label: string
  url: string | null
  host: string | null
  method: string | null
  functionName: string | null
  outCalls: number
  inCalls: number
}

export interface GraphEdge {
  from: string
  to: string
  count: number
  failures: number
  avgMs: number | null
  p95Ms: number | null
  initiatorTypes: Array<{ key: string; count: number }>
  samples: number[]
  firstTs: number | null
  lastTs: number | null
}

export interface RequestGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** 连通分量 = 互相牵动的「功能簇」 */
  clusters: Array<{ size: number; nodes: string[] }>
  scanned: number
  total: number
  truncated: boolean
  droppedNodes: number
}

export interface RelationReport {
  sharedBodies: Array<{
    hash: string
    refs: number
    size: number | null
    distinctUrls: number
    sampleUrls: string[]
    endpoints: string[]
    samples: number[]
  }>
  redirectChains: Array<{
    requestId: string
    hops: number
    steps: Array<{ seq: number; method: string; url: string; status: number | null }>
  }>
  domainLinks: Array<{ frameHost: string; host: string; count: number }>
  sharedParams: Array<{
    name: string
    value: string
    count: number
    endpoints: string[]
    endpointCount: number
    hosts: string[]
    crossHost: boolean
  }>
  scanned: number
  total: number
  truncated: boolean
}

/* ---------------------------------------------------------------- 导出 */

export interface ExportQuery {
  /** 只导匹配的请求。不认识的字段会被忽略 */
  query?: RequestQuery
  /** 一次最多扫多少行（有上限，超了会报 truncated） */
  maxRows?: number
  includeBodies?: boolean
}

export interface HarExportReport {
  path: string
  bytes: number
  entries: number
  pages: number
  /** 有 body_hash 但 blob 已被 LRU 淘汰掉的条数 */
  bodyMissing: number
  scanned: number
  total: number
  truncated: boolean
  sample: Array<{ url: string; status: number; resourceType?: string }>
}

export interface JsonlExportReport {
  path: string
  bytes: number
  lines: number
  bodyMissing: number
  scanned: number
  total: number
  truncated: boolean
}

export interface ResourceExportReport {
  dir: string
  manifest: string
  files: number
  bytes: number
  skipped: number
  total: number
  truncated: boolean
}

/* ------------------------------------------------------------ 契约回归 */

export interface ContractSummary {
  id: number
  label: string
  inst: number
  createdAt: number
  endpoints: number
  calls: number
  truncated: boolean
}

export interface ContractListRow {
  id: number
  label: string
  inst: number
  createdAt: number
  bytes: number
}

export interface ContractDiff {
  base: { id: number | null; label: string | null; createdAt: number; endpoints: number }
  current: { createdAt: number; endpoints: number; calls: number }
  added: Array<{ key: string; calls: number; statuses: string[]; mimeTypes: string[] }>
  removed: Array<{ key: string; calls: number; statuses: string[]; mimeTypes: string[] }>
  changed: Array<{
    key: string
    statuses: { added: string[]; removed: string[] }
    mimeTypes: { added: string[]; removed: string[] }
    query: {
      added: Array<{ name: string; required: boolean; samples: string[] }>
      removed: Array<{ name: string }>
      requiredChanged: Array<{ name: string; from: boolean; to: boolean }>
    }
    requestFields: {
      added: Array<{ name: string; required: boolean; samples: string[] }>
      removed: Array<{ name: string }>
      requiredChanged: Array<{ name: string; from: boolean; to: boolean }>
    }
    response: {
      added: SchemaPath[]
      removed: SchemaPath[]
      typeChanged: Array<{ path: string; from: string; to: string }>
    }
    callsBefore: number
    callsAfter: number
  }>
  summary: {
    addedEndpoints: number
    removedEndpoints: number
    changedEndpoints: number
    unchangedEndpoints: number
    addedEndpointKeys: string[]
    removedEndpointKeys: string[]
    newStatusCodes: string[]
    droppedStatusCodes: string[]
    newResponseFields: string[]
    droppedResponseFields: string[]
    newRequestFields: string[]
    newQueryParams: string[]
  }
}

/* ------------------------------------------- 站点资源（Cookie / 站点存储） */

/**
 * cookie 罐里的一条。字段名刻意对齐 CDP 的 Storage.Cookie —— 我们只是搬运工，
 * 另造一套命名只会让「界面显示的」和「DevTools 显示的」对不上。
 */
export interface CookieRecord {
  /** 罐内主键：domain|path|name|partition。同一条 cookie 更新时靠它认领 */
  key: string
  name: string
  value: string
  /** 值被截断过（原值更大）。真长度在 valueLen */
  truncated?: boolean
  valueLen: number
  domain: string
  path: string
  /** 秒级时间戳；会话 cookie 没有 */
  expires?: number
  session: boolean
  secure: boolean
  httpOnly: boolean
  sameSite?: string
  priority?: string
  sourceScheme?: string
  sourcePort?: number
  /** 有值 = 分区 cookie（CHIPS），只有它自己的顶级站点能读到 */
  partitionKey?: string
  /** CDP 报的字节数（名字 + 值 + 属性） */
  size: number
  firstSeen: number
  lastSeen: number
  /** 被观察到变过几次。1 = 只见过一面 */
  changeCount: number
  /** 被带出去过多少次请求（来自 requestWillBeSentExtraInfo.associatedCookies） */
  sentCount: number
  /** 它被发往过哪些站点（请求所在文档的 host） */
  sentHosts: string[]
  /** 用到它的站点和它自己的域不是同一个 —— 这才是真的「第三方使用」 */
  crossSite: boolean
}

/** cookie 变更事件（事件流里 kind='cookie' 的 detail）。谁把哪条 cookie 改成了什么 */
export interface CookieQuery {
  /** 按域 / 名字模糊搜 */
  search?: string
  /** 精确匹配的域（含子域） */
  domain?: string
  name?: string
  path?: string
  /** 只看会话 cookie / 只看持久 cookie */
  session?: boolean
  /** 只看第三方（跨站使用过的） */
  crossSite?: boolean
  sameSite?: string
  secure?: boolean
  httpOnly?: boolean
  /** 只看分区 cookie */
  partitioned?: boolean
  /** 排序：size / lastSeen / sentCount / domain */
  sort?: string
  limit?: number
  offset?: number
  order?: 'asc' | 'desc'
}

export interface CookieChangeDetail {
  action: 'added' | 'changed' | 'removed' | 'blocked'
  name: string
  domain: string
  path: string
  value?: string
  valueLen?: number
  /** 变更来源：set-cookie(响应 URL) / cdp(我们自己改的) / scan(对账发现的) */
  source: string
  url?: string
  /** removed 时解释为什么：expired / cleared / overwritten */
  reason?: string
}

/**
 * 站点存储变更事件（事件流里 kind='storage' 的 detail）。
 *
 * 两类来源共用一个形状：DOMStorage 是逐键的（key/value 都有），
 * 缓存 / IndexedDB / ServiceWorker 的域事件只给名字 —— 浏览器只肯说
 * 「这个域的某个东西动了」，明细得重新扫。区分靠 action。
 */
export interface StorageChangeDetail {
  area: 'local' | 'session' | 'cache' | 'indexeddb' | 'serviceworker'
  action: 'set' | 'remove' | 'clear' | 'list' | 'content'
  origin: string
  key?: string
  value?: string
  oldValue?: string
  /** 域级事件带的名字：缓存名 / 库名 */
  name?: string
  /** IndexedDB 的 object store */
  objectStore?: string
}

/** 按 origin 汇总的站点资源。scanned=false 表示只是见过这个域，还没去扫过 */
export interface SiteOriginRow {
  origin: string
  updatedAt: number
  scanned: boolean
  cookieCount: number
  localStorageCount: number
  localStorageBytes: number
  sessionStorageCount: number
  sessionStorageBytes: number
  idbNames: string[]
  idbStores: number
  cacheNames: string[]
  cacheEntries: number
  swCount: number
  usageBytes: number | null
  quotaBytes: number | null
  usageBreakdown: Array<{ storageType: string; usage: number }>
}

export interface SiteStorageEntry {
  key: string
  value: string
  bytes: number
  truncated?: boolean
}

export interface SiteIdbStore {
  name: string
  keyPath?: string
  autoIncrement?: boolean
  indexes: string[]
}

export interface SiteIdbDatabase {
  name: string
  version: number
  objectStores: SiteIdbStore[]
}

export interface SiteCache {
  name: string
  count: number
  entries: Array<{ url: string; size: number | null; status?: number }>
}

export interface SiteServiceWorker {
  scopeURL: string
  registrationId?: string
  isDeleted?: boolean
  versionId?: string
  runningStatus?: string
  scriptURL?: string
  status?: string
}

/** 某个 origin 的全量明细（扫描得出来的东西全在这里） */
export interface SiteDetail extends SiteOriginRow {
  cookies: CookieRecord[]
  localStorage: SiteStorageEntry[]
  sessionStorage: SiteStorageEntry[]
  idb: SiteIdbDatabase[]
  caches: SiteCache[]
  serviceWorkers: SiteServiceWorker[]
}

/** cookie 画像。研究用：谁在用 cookie、用得多狠、跨了多少站 */
export interface CookieStats {
  total: number
  hosts: number
  session: number
  persistent: number
  secure: number
  httpOnly: number
  sameSiteNone: number
  crossSite: number
  partitioned: number
  totalBytes: number
  biggest: Array<{ name: string; domain: string; size: number }>
  bySameSite: Array<{ key: string; count: number }>
  /** 同一个名字出现在多个域上 —— 跟踪器最常见的特征 */
  sharedNames: Array<{ name: string; hosts: number; count: number }>
  longLived: Array<{ name: string; domain: string; expires: number; days: number }>
  /** 被带出去最多的 cookie（真正在「跟踪」的那些） */
  mostSent: Array<{ name: string; domain: string; sentCount: number; hosts: number }>
}

export interface SiteSnapshotSummary {
  id: number
  label: string | null
  createdAt: number
  origins: number
  cookies: number
  bytes: number
}

export interface SiteSnapshotDiff {
  baseId: number
  baseLabel: string | null
  createdAt: number
  origins: { added: string[]; removed: string[]; changed: Array<{ origin: string; summary: string[] }> }
  cookies: {
    added: Array<{ name: string; domain: string; path: string }>
    removed: Array<{ name: string; domain: string; path: string }>
    changed: Array<{ name: string; domain: string; path: string; fields: string[] }>
  }
  localStorage: { added: string[]; removed: string[]; changed: string[] }
  summary: {
    originsAdded: number
    originsRemoved: number
    cookiesAdded: number
    cookiesRemoved: number
    cookiesChanged: number
    keysAdded: number
    keysRemoved: number
    keysChanged: number
  }
}

export interface SiteScanReport {
  ok: boolean
  error?: string
  scannedAt: number
  durationMs: number
  origins: string[]
  cookies: { total: number; added: number; changed: number; removed: number }
}

/** 写 cookie 的入参（对齐 Network.setCookie） */
export interface CookieInput {
  name: string
  value?: string
  domain?: string
  url?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
  /** 秒级时间戳 */
  expires?: number
  /** 相对现在多少秒后过期；0 或负数 = 立刻删掉；不给 = 会话 cookie */
  maxAge?: number
}

/** 删 cookie 的口径。给几个条件就删几条，都不给 = 拒绝（防手滑清空） */
export interface CookieDeleteFilter {
  name?: string
  domain?: string
  path?: string
  url?: string
  /** 整站：这个域及其子域全删 */
  host?: string
  /** 只删「跨站使用过」的 */
  crossSiteOnly?: boolean
  /**
   * 罐内主键白名单（domain|path|name|partition）。
   * 「跨站使用过」这类判断只有库做得出来，主进程查完把清单交下来按主键删 ——
   * 上层再拼一遍匹配规则只会和库里的口径漂移。
   */
  extraKeys?: string[]
}

/** 清站点数据的类型位。对齐 CDP clearDataForOrigin 的 storageTypes */
export type SiteDataType =
  | 'cookies'
  | 'local_storage'
  | 'session_storage'
  | 'indexeddb'
  | 'cache_storage'
  | 'service_workers'
  | 'file_systems'
  | 'all'

export interface InputReport {
  kind: InputKind
  ok: boolean
  /** 派发了多少个 mouseMoved —— 一次跳到位 = 1，这个数字就是拟人化的直接证据 */
  points: number
  durationMs: number
  /** 起点到终点的直线距离 */
  straight: number
  /** 实际走过的路程，弧线/抖动会让它大于直线距离 */
  pathLength: number
  maxStep: number
  minStep: number
  maxStepMs: number
  minStepMs: number
  pauses: number
  landed?: { x: number; y: number }
  text?: string
  keys?: number
  scrollTicks?: number
  error?: string
}
