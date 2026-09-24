import { useEffect, useMemo, useRef, useState } from 'react'
import type { BodyPayload, InitiatorInfo, RequestDetail } from '../../../shared/types'
import { bodyStateLabel, formatMs, formatSize, formatTime, statusClass } from '../format'

/** 代理侧分段的顺序与配色，和瀑布图里保持一致（同一个东西不该两处两种颜色） */
const PROXY_SEGMENTS = [
  ['net_dns_ms', '#8b7bff', 'DNS'],
  ['net_connect_ms', '#4c8dff', 'TCP'],
  ['net_tls_ms', '#2fc6a8', 'TLS'],
  ['ttfb_ms', '#f0b23a', 'TTFB'],
  ['net_download_ms', '#7bd88f', 'download']
] as const

/**
 * 发起链在库里是 JSON 字符串。坏数据不该把整个面板打挂 —— 解析失败就当没有。
 */
function parseInitiator(raw: string | null): InitiatorInfo | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as InitiatorInfo
    return Array.isArray(parsed?.frames) ? parsed : null
  } catch {
    return null
  }
}

/** 栈里的 URL 常带长 query，缩到「主机 + 路径」，查询串单独看详情用不着 */
function shortUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname}`
  } catch {
    return url.length > 80 ? url.slice(0, 80) + '…' : url
  }
}

const MERGE_LABELS: Record<string, string> = {
  merged: '三源已关联',
  'cdp-only': '只有 CDP（代理没看到）',
  'proxy-only': '只有代理（CDP 没看到）'
}

/**
 * 代理给的分段耗时。CDP 只有「总耗时」，DNS / 连接 / TLS 这三段它给不了（§5.1），
 * 所以这里按段画，而不是只报一个总数 —— 慢在哪一段是这张图唯一要回答的问题。
 */
function ProxyTiming(props: {
  row: RequestDetail['request']
}): React.JSX.Element | null {
  const { row } = props
  // flatMap 而不是 map+filter：这样 value 的类型在返回处就被收窄成 number，不用断言
  const segments = PROXY_SEGMENTS.flatMap(([key, color, label]) => {
    const value = row[key]
    return typeof value === 'number' && value > 0 ? [{ key, color, label, value }] : []
  })
  if (segments.length === 0) return null
  const total = segments.reduce((sum, item) => sum + item.value, 0) || 1

  return (
    <div className="proxy-timing">
      <div className="proxy-timing-bar">
        {segments.map((item) => (
          <span
            key={item.key}
            style={{ width: `${(item.value / total) * 100}%`, background: item.color }}
            title={`${item.label} ${formatMs(item.value)}`}
          />
        ))}
      </div>
      <div className="proxy-timing-legend">
        {segments.map((item) => (
          <span key={item.key} className="legend-item">
            <i style={{ background: item.color }} />
            {item.label} {formatMs(item.value)}
          </span>
        ))}
      </div>
    </div>
  )
}

export interface DetailPanelProps {
  seq: number | null
  onClose(): void
}

type BodyView = 'auto' | 'text' | 'json' | 'hex'
type DetailTab = 'overview' | 'headers' | 'initiator' | 'body'

/** 开局停在哪个 tab（MONITOR_UI_DTAB）。截响应体那一屏时省得手点 */
function initialDetailTab(): DetailTab {
  const value = new URLSearchParams(window.location.search).get('dtab')
  return value === 'headers' || value === 'body' || value === 'initiator' ? value : 'overview'
}

/**
 * 详情面板。body 默认按文本展示；二进制或解码失败时给 hex，
 * 不猜、不静默显示乱码。
 */
export function DetailPanel({ seq, onClose }: DetailPanelProps): React.JSX.Element {
  const [detail, setDetail] = useState<RequestDetail | null>(null)
  const [body, setBody] = useState<BodyPayload | null>(null)
  const [bodyError, setBodyError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<BodyView>('auto')
  const [tab, setTab] = useState<DetailTab>('overview')
  const [sensitiveUnlocked, setSensitiveUnlocked] = useState(false)
  // 指定的 tab 只对开门第一条生效，之后换请求都回到概览
  const preferredTab = useRef<DetailTab>(initialDetailTab())

  async function loadDetail(targetSeq: number): Promise<void> {
    const result = await window.monitor.getDetail(targetSeq)
    setDetail(result)
    setBody(null)
    setBodyError(null)
    if (result?.body?.stored) {
      const payload = await window.monitor.getBody(result.body.hash, true)
      if (payload) setBody(payload)
      else setBodyError('body 记录在，但内容读取失败')
    }
  }

  useEffect(() => {
    if (seq === null) {
      setDetail(null)
      return
    }
    // 只在真的选到一条时才消费「指定 tab」，否则开局那次空选就把它吃掉了
    setTab(preferredTab.current)
    preferredTab.current = 'overview'
    setView('auto')
    setSensitiveUnlocked(false)
    void loadDetail(seq)
  }, [seq])

  const decoded = useMemo(() => decodeBody(body), [body])

  async function handleFetchNow(): Promise<void> {
    if (seq === null) return
    setBusy(true)
    try {
      const result = await window.monitor.fetchBodyNow(seq)
      if (!result.ok) {
        setBodyError(
          result.state === 'evicted'
            ? '这条响应已经被浏览器驱逐，拿不回来了'
            : `现捞失败：${result.state}`
        )
      } else {
        await loadDetail(seq)
      }
    } finally {
      setBusy(false)
    }
  }

  if (seq === null || !detail) {
    return (
      <aside className="detail">
        <p className="dim">选中一行查看详情</p>
      </aside>
    )
  }

  const { request: row } = detail
  const reqHeaders = parseHeaders(row.req_headers)
  const respHeaders = parseHeaders(row.resp_headers)
  const initiator = parseInitiator(row.initiator_stack)

  return (
    <aside className="detail">
      <div className="detail-head">
        <h3>请求详情</h3>
        <button type="button" className="ghost small-btn" onClick={onClose}>
          关闭
        </button>
      </div>

      <div className="tabs tabs-sm">
        {(
          [
            ['overview', '概览'],
            ['headers', `头 (${reqHeaders.length + respHeaders.length})`],
            ['initiator', `发起链${initiator ? ` (${initiator.frames.length})` : ''}`],
            ['body', '响应体']
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`tab${tab === key ? ' tab-active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <dl>
          <dt>URL</dt>
          <dd className="mono break">{row.url}</dd>
          <dt>方法 / 状态</dt>
          <dd className={`mono ${statusClass(row.status, row.failed)}`}>
            {row.method} · {row.status ?? '—'} {row.status_text ?? ''}
          </dd>
          <dt>资源类型</dt>
          <dd className="mono">
            {row.resource_type ?? '-'}
            {row.initiator_type ? ` · initiator ${row.initiator_type}` : ''}
          </dd>
          <dt>MIME / 协议</dt>
          <dd className="mono">
            {row.mime_type ?? '-'} · {row.protocol ?? '-'}
          </dd>
          <dt>来源 target</dt>
          <dd className="mono">
            {row.target_type}
            {row.session_id ? ` · ${row.session_id.slice(0, 10)}` : ''}
          </dd>
          <dt>发起页面</dt>
          <dd className="mono break">{row.frame_url || '-'}</dd>
          <dt>时间</dt>
          <dd className="mono">
            {formatTime(row.start_ts)} → {formatTime(row.end_ts)}
          </dd>
          <dt>耗时 / TTFB</dt>
          <dd className="mono">
            {formatMs(row.duration_ms)}
            {row.ttfb_ms !== null ? ` · TTFB ${formatMs(row.ttfb_ms)}` : ''}
          </dd>
          <dt>传输 / 解码</dt>
          <dd className="mono">
            {formatSize(row.encoded_len)} / {formatSize(row.decoded_len)}
          </dd>
          <dt>缓存 / SW</dt>
          <dd className="mono">
            {row.from_cache ? '磁盘缓存' : '网络'}
            {row.from_sw ? ' · Service Worker' : ''}
            {row.canceled ? ' · 会话结束时未完成' : ''}
          </dd>
          <dt>响应体</dt>
          <dd className="mono">
            {bodyStateLabel(row.body_state)}
            {row.body_size ? ` · ${formatSize(row.body_size)}` : ''}
            {row.body_trunc ? ' · 已截断' : ''}
            {row.body_hash && (
              <span className="dim"> · {row.body_hash.slice(0, 12)}</span>
            )}
          </dd>
          {row.failed && (
            <>
              <dt>失败原因</dt>
              <dd className="mono err">{row.failed}</dd>
            </>
          )}
          {row.merge_state && (
            <>
              <dt>三源关联</dt>
              <dd className="mono">
                {MERGE_LABELS[row.merge_state] ?? row.merge_state}
                {row.proxy_flow_id ? <span className="dim"> · {row.proxy_flow_id}</span> : null}
                {row.merge_ambiguous ? <span className="warn"> · 窗口内有多条候选，这条是就近猜的</span> : null}
              </dd>
              <dt>上游</dt>
              <dd className="mono">
                {row.upstream_ip ?? '-'}
                {row.tls_version ? ` · ${row.tls_version}` : ''}
                {row.upstream_alpn ? ` · ${row.upstream_alpn}` : ''}
              </dd>
              {row.tls_cipher && (
                <>
                  <dt>TLS 套件</dt>
                  <dd className="mono">{row.tls_cipher}</dd>
                </>
              )}
              <dt>网络分段</dt>
              <dd>
                <ProxyTiming row={row} />
                {row.proxy_delta_ms !== null && (
                  <p className="dim small">
                    代理比 CDP 晚 {formatMs(row.proxy_delta_ms)} 看到这条请求
                    {row.proxy_delta_ms > 50 ? '（突发并发下的排队）' : ''}
                  </p>
                )}
                {row.proxy_open ? (
                  <p className="dim small">
                    长连接：这条到收工还没结束，download 这一段本来就不存在
                  </p>
                ) : null}
              </dd>
            </>
          )}
        </dl>
      )}

      {tab === 'initiator' && (
        <div className="initiator">
          {!initiator ? (
            <p className="dim">这条请求没有发起链记录（老库或采集时没带 initiator）</p>
          ) : (
            <>
              <p className="dim">
                发起类型 <span className="mono">{initiator.type}</span>
                {initiator.url
                  ? ` · ${shortUrl(initiator.url)}:${initiator.lineNumber ?? 0}:${initiator.columnNumber ?? 0}`
                  : ''}
              </p>
              {initiator.frames.length === 0 ? (
                <p className="dim">
                  这一类发起方（如 HTML 解析器）只给 URL 不给调用栈，所以没有帧可看
                </p>
              ) : (
                <ol className="initiator-frames">
                  {initiator.frames.map((frame, index) => (
                    <li key={`${frame.scriptId ?? 'x'}:${frame.lineNumber}:${frame.columnNumber}:${index}`}>
                      <span className="mono">{frame.functionName}</span>
                      <span className="dim mono">
                        {' '}
                        {frame.url ? shortUrl(frame.url) : '(无 URL)'}:{frame.lineNumber}:
                        {frame.columnNumber}
                        {frame.scriptId ? ` · script ${frame.scriptId}` : ''}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              {initiator.truncated ? <p className="dim">调用栈过长，只留了最上面 16 帧</p> : null}
            </>
          )}
        </div>
      )}

      {tab === 'headers' && (
        <div className="headers">
          <h4>请求头</h4>
          {reqHeaders.length === 0 && <p className="dim small">未采集请求头</p>}
          <table className="kv">
            <tbody>
              {reqHeaders.map(([name, value]) => (
                <tr key={`req-${name}`}>
                  <td className="mono dim">{name}</td>
                  <td className="mono break">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4>响应头</h4>
          {respHeaders.length === 0 && <p className="dim small">未采集响应头</p>}
          <table className="kv">
            <tbody>
              {respHeaders.map(([name, value]) => (
                <tr key={`res-${name}`}>
                  <td className="mono dim">{name}</td>
                  <td className="mono break">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {row.req_headers === null && row.resp_headers === null && (
            <p className="dim small">
              这一条没有任何头部记录。命中磁盘缓存、以及 Worker / Service Worker
              target 里发出的请求，浏览器根本不发 ExtraInfo 事件（实测：worker 会话
              只有 requestWillBeSent / responseReceived，没有 ExtraInfo），
              拿不到是正常的；页面主线程的请求都会有。
            </p>
          )}
        </div>
      )}

      {tab === 'body' && (
        <div className="body-view">
          <div className="body-toolbar">
            <div className="tabs tabs-xs">
              {(['auto', 'text', 'json', 'hex'] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`tab${view === key ? ' tab-active' : ''}`}
                  onClick={() => setView(key)}
                >
                  {key === 'auto' ? '自动' : key === 'text' ? '文本' : key === 'json' ? 'JSON' : 'HEX'}
                </button>
              ))}
            </div>
            {!body && (
              <button
                type="button"
                className="ghost small-btn"
                onClick={() => void handleFetchNow()}
                disabled={busy || row.body_state === 'stored'}
              >
                {busy ? '取回中…' : '现捞一次'}
              </button>
            )}
          </div>

          {bodyError && <p className="err small">{bodyError}</p>}
          {!body && !bodyError && <p className="dim small">这条响应没有落盘的 body。</p>}
          {body && decoded && (
            <>
              <p className="dim small">
                {formatSize(body.size)}
                {body.trunc ? ' · 已截断' : ''} · {decoded.kind === 'text' ? '文本' : '二进制'}
              </p>
              {decoded.sensitive && !sensitiveUnlocked ? <div className="banner">检测到 token / 密钥类字段，预览已遮罩。<button type="button" className="tab" onClick={() => setSensitiveUnlocked(true)}>显式解锁本次预览</button></div> : null}
              {row.mime_type?.startsWith('image/') && view === 'auto' ? <img className="body-image" alt="响应正文预览" src={`data:${row.mime_type};base64,${body.b64}`} /> :
                <pre className="body-pre">
                  {view === 'hex' ? decoded.hex
                    : view === 'json' ? (decoded.json ?? '不是有效 JSON')
                      : view === 'text' ? (decoded.sensitive && !sensitiveUnlocked ? decoded.masked : decoded.text)
                        : decoded.kind === 'text' ? (decoded.sensitive && !sensitiveUnlocked ? decoded.masked : decoded.json ?? decoded.text) : decoded.hex}
                </pre>}
            </>
          )}
        </div>
      )}
    </aside>
  )
}

function parseHeaders(raw: string | null | undefined): Array<[string, string]> {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as Record<string, string | string[]>
    return Object.entries(parsed).map(([name, value]) => [
      name,
      Array.isArray(value) ? value.join(', ') : String(value)
    ])
  } catch {
    return []
  }
}

interface DecodedBody {
  kind: 'text' | 'binary'
  text: string
  hex: string
  json: string | null
  masked: string
  sensitive: boolean
}

const HEX_LIMIT = 64 * 1024

function decodeBody(body: BodyPayload | null): DecodedBody | null {
  if (!body?.b64) return null
  const binary = atob(body.b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)

  const text = toText(bytes)
  let json: string | null = null
  try { json = JSON.stringify(JSON.parse(text), null, 2) } catch { /* 普通文本 */ }
  const masked = maskSensitive(json ?? text)
  return { kind: looksText(bytes) ? 'text' : 'binary', text, hex: toHex(bytes), json, masked, sensitive: masked !== (json ?? text) }
}

function maskSensitive(text: string): string {
  return text
    .replace(/("?(?:authorization|cookie|set-cookie|password|passwd|token|secret|api[_-]?key)"?\s*[:=]\s*")([^"\r\n]+)(")/gi, '$1••••••$3')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{8,}/gi, '$1••••••')
}

/** 有 NUL 或大量替换字符就当二进制 —— 乱码比 hex 更难用 */
function looksText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 4096)
  let suspicious = 0
  for (const byte of sample) {
    if (byte === 0) return false
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious += 1
  }
  return suspicious / Math.max(sample.length, 1) < 0.02
}

function toText(bytes: Uint8Array): string {
  const slice = bytes.subarray(0, 512 * 1024)
  const text = new TextDecoder('utf-8', { fatal: false }).decode(slice)
  return text.length < bytes.length ? `${text}\n… (只显示前 512KB)` : text
}

function toHex(bytes: Uint8Array): string {
  const slice = bytes.subarray(0, HEX_LIMIT)
  const lines: string[] = []
  for (let offset = 0; offset < slice.length; offset += 16) {
    const chunk = slice.subarray(offset, offset + 16)
    const hex = [...chunk].map((byte) => byte.toString(16).padStart(2, '0')).join(' ')
    const ascii = [...chunk]
      .map((byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.'))
      .join('')
    lines.push(`${offset.toString(16).padStart(6, '0')}  ${hex.padEnd(47)}  ${ascii}`)
  }
  if (slice.length < bytes.length) lines.push(`… 共 ${bytes.length} 字节，只显示前 ${HEX_LIMIT}`)
  return lines.join('\n')
}
