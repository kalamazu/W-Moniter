import { useCallback, useEffect, useState } from 'react'
import type {
  ContractDiff,
  ContractListRow,
  EndpointDetail,
  EndpointPage,
  EndpointProfile,
  HarExportReport,
  JsonlExportReport,
  JsonSchemaNode,
  RequestQuery,
  ResourceExportReport,
  SchemaPath
} from '../../../shared/types'
import { formatCount, formatMs, formatSize, formatTime } from '../format'

/**
 * 接口画像面板：把「同一个接口被反复调用」的那些次收成一个端点，看它的
 * 调用次数 / 耗时分布 / 状态码 / 字段分布 / 响应结构，再往下做契约回归与导出。
 *
 * 三个页签不是装饰：画像看「现在是什么样」，契约看「跟上次比变没变」，
 * 导出把库里的东西搬成能拿走的文件。三件事的节奏完全不同，挤一屏会很吵。
 */

const SORTS: Array<{ id: string; label: string }> = [
  { id: 'calls', label: '调用次数' },
  { id: 'p95', label: 'P95 耗时' },
  { id: 'bytes', label: '传输量' },
  { id: 'failed', label: '失败数' },
  { id: 'recent', label: '最近调用' },
  { id: 'name', label: '端点名' }
]

/** 服务端返回的 schema 拍平成路径表。optional 的语义 = 不是每个样本都有（见 storage/server.mjs） */
function flatten(node: JsonSchemaNode | null | undefined, prefix = '', parentOptional = false): SchemaPath[] {
  const out: SchemaPath[] = []
  const walk = (current: JsonSchemaNode | null | undefined, path: string, optional: boolean): void => {
    if (!current) return
    const seen = current.seen
    const count = current.count
    const here = optional || (seen !== undefined && count !== undefined && seen < count)
    if (current.t === 'object' && current.fields) {
      for (const [key, child] of Object.entries(current.fields)) {
        walk(child, path ? `${path}.${key}` : key, here)
      }
      return
    }
    if (current.t === 'array' && current.items) {
      walk(current.items, `${path}[]`, here)
      return
    }
    if (current.of && current.of.length > 0) {
      out.push({ path: path || '(root)', type: current.of.map((item) => item.t).join('|'), optional: here })
      return
    }
    out.push({ path: path || '(root)', type: current.t, optional: here })
  }
  walk(node, prefix, parentOptional)
  return out
}

export function EndpointsPanel({ liveTick }: { liveTick: number }): React.JSX.Element {
  const [tab, setTab] = useState<'profiles' | 'contract' | 'export'>('profiles')

  // 画像
  const [page, setPage] = useState<EndpointPage | null>(null)
  const [sort, setSort] = useState('calls')
  const [minCalls, setMinCalls] = useState(1)
  const [search, setSearch] = useState('')
  const [applied, setApplied] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<EndpointDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 契约
  const [contracts, setContracts] = useState<ContractListRow[]>([])
  const [baseId, setBaseId] = useState<number | null>(null)
  const [diff, setDiff] = useState<ContractDiff | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  // 导出
  const [har, setHar] = useState<HarExportReport | null>(null)
  const [jsonl, setJsonl] = useState<JsonlExportReport | null>(null)
  const [mirror, setMirror] = useState<ResourceExportReport | null>(null)

  useEffect(() => {
    const timer = window.setTimeout(() => setApplied(search.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [search])

  const query: RequestQuery = applied ? { search: applied } : {}

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const next = await window.monitor.getEndpointProfiles({ query, sort, minCalls, limit: 200 })
      setPage(next)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [query, sort, minCalls])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), liveTick === 0 ? 0 : 500)
    return () => window.clearTimeout(timer)
  }, [liveTick, load])

  const openDetail = useCallback(
    async (key: string): Promise<void> => {
      setSelected(key)
      setDetail(null)
      const next = await window.monitor.getEndpointDetail(key, { query, sampleLimit: 24, callLimit: 60 })
      setDetail(next)
    },
    [query]
  )

  const loadContracts = useCallback(async (): Promise<void> => {
    const list = await window.monitor.listContracts(50)
    setContracts(list ?? [])
  }, [])

  useEffect(() => {
    if (tab === 'contract') void loadContracts()
  }, [tab, loadContracts])

  const run = useCallback(
    async (name: string, action: () => Promise<void>): Promise<void> => {
      setBusy(name)
      setMessage(null)
      try {
        await action()
      } catch (err) {
        setMessage(`${name} 失败：${(err as Error).message}`)
      } finally {
        setBusy(null)
      }
    },
    []
  )

  const snapshot = (): Promise<void> =>
    run('快照', async () => {
      const summary = await window.monitor.contractSnapshot({ query, sampleLimit: 200 })
      setMessage(`已存契约 #${summary.id}：${summary.endpoints} 个端点 / ${summary.calls} 次调用${summary.truncated ? '（扫描被上限截断）' : ''}`)
      await loadContracts()
      setBaseId(summary.id)
    })

  const regress = (): Promise<void> =>
    run('回归', async () => {
      if (baseId === null) {
        setMessage('先选一个基线契约')
        return
      }
      const result = await window.monitor.contractDiff({ baseId, query, sampleLimit: 200 })
      setDiff(result)
      setMessage(
        `相对 #${result.base.id}：新增端点 ${result.summary.addedEndpoints} · 消失 ${result.summary.removedEndpoints} · 有变化 ${result.summary.changedEndpoints}`
      )
    })

  return (
    <div className="ep-panel">
      <div className="ep-tabs">
        <div className="tabs tabs-sm">
          <button type="button" className={`tab ${tab === 'profiles' ? 'tab-active' : ''}`} onClick={() => setTab('profiles')}>
            接口画像
          </button>
          <button type="button" className={`tab ${tab === 'contract' ? 'tab-active' : ''}`} onClick={() => setTab('contract')}>
            契约回归
          </button>
          <button type="button" className={`tab ${tab === 'export' ? 'tab-active' : ''}`} onClick={() => setTab('export')}>
            导出
          </button>
        </div>
        <span className="spacer" />
        {page && (
          <span className="mono dim small">
            端点 {page.matched} / 扫描 {formatCount(page.scanned)} 行{page.truncated ? ' · 已截断' : ''}
          </span>
        )}
      </div>

      {message && (
        <div className="banner">
          {message}
          <span className="spacer" />
          <button type="button" className="link" onClick={() => setMessage(null)}>
            知道了
          </button>
        </div>
      )}
      {error && <div className="banner banner-err">{error}</div>}

      {tab === 'profiles' && (
        <div className="ep-profiles">
          <div className="ep-bar">
            <input
              className="search"
              placeholder="按 URL 过滤"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <select value={sort} onChange={(event) => setSort(event.target.value)} title="排序">
              {SORTS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <label className="check" title="调用次数少于这个数的端点不列出来（默认 1 条也不漏）">
              ≥
              <input
                className="ep-min"
                type="number"
                min={1}
                value={minCalls}
                onChange={(event) => setMinCalls(Math.max(1, Number(event.target.value) || 1))}
              />
              次
            </label>
            <button type="button" className="btn" onClick={() => void load()} disabled={loading}>
              {loading ? '扫描中…' : '刷新'}
            </button>
          </div>

          <div className="ep-split">
            <div className="ep-list">
              {(page?.endpoints ?? []).map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`ep-row ${item.key === selected ? 'ep-row-active' : ''}`}
                  onClick={() => void openDetail(item.key)}
                  title={item.sampleUrls.join('\n')}
                >
                  <span className="ep-key mono ellipsis">{item.key}</span>
                  <span className="ep-meta mono dim small">
                    {item.calls} 次 · {item.distinctUrls} URL · p50 {formatMs(item.durationMs.p50)} · p95{' '}
                    {formatMs(item.durationMs.p95)} · {formatSize(item.bytes)}
                    {item.failed > 0 ? ` · 失败 ${item.failed}` : ''}
                    {item.rhythm ? ` · 节奏 ${Math.round(item.rhythm.medianGapMs)}ms` : ''}
                  </span>
                  <span className="ep-statuses">
                    {item.statuses.slice(0, 4).map((status) => (
                      <span key={status.key} className={`chip chip-xs ${Number(status.key) >= 400 ? 'st-err' : 'st-ok'}`}>
                        {status.key}×{status.count}
                      </span>
                    ))}
                  </span>
                </button>
              ))}
              {page && page.endpoints.length === 0 && (
                <div className="empty">
                  没有匹配的端点。画像只统计 XHR / Fetch 这类「接口调用」，页面还在跑就有数据了
                </div>
              )}
              {!page && <div className="empty">正在扫描…</div>}
            </div>

            <div className="ep-detail">
              {!detail && <div className="empty">左边点一个端点看详情（字段分布 / 响应结构 / 最近调用）</div>}
              {detail && detail.found === false && <div className="banner banner-err">{detail.error ?? '查不到'}</div>}
              {detail && detail.found && detail.profile && (
                <EndpointDetailView detail={detail} profile={detail.profile} />
              )}
            </div>
          </div>
        </div>
      )}

      {tab === 'contract' && (
        <div className="ep-contract">
          <div className="ep-bar">
            <button type="button" className="btn btn-primary" onClick={() => void snapshot()} disabled={busy !== null}>
              {busy === '快照' ? '存档中…' : '给现在的接口存个快照'}
            </button>
            <label className="check">
              基线
              <select
                value={baseId ?? ''}
                onChange={(event) => setBaseId(event.target.value ? Number(event.target.value) : null)}
              >
                <option value="">（选一个）</option>
                {contracts.map((item) => (
                  <option key={item.id} value={item.id}>
                    #{item.id} {item.label} · {formatTime(item.createdAt)}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="btn" onClick={() => void regress()} disabled={busy !== null || baseId === null}>
              {busy === '回归' ? '比对中…' : '跑回归'}
            </button>
            <span className="spacer" />
            <button type="button" className="ghost" onClick={() => void loadContracts()}>
              刷新列表
            </button>
          </div>

          <div className="ep-contract-list">
            {contracts.length === 0 && <div className="empty">还没有契约快照。存一份，之后每次改完再跑一次回归</div>}
            {contracts.map((item) => (
              <div key={item.id} className="ep-contract-row">
                <span className="mono">#{item.id}</span>
                <span className="ellipsis">{item.label}</span>
                <span className="mono dim small">{formatTime(item.createdAt)}</span>
                <span className="mono dim small">{formatSize(item.bytes)}</span>
                <span className="spacer" />
                <button type="button" className="link" onClick={() => setBaseId(item.id)}>
                  设为基线
                </button>
                <button
                  type="button"
                  className="link"
                  onClick={() =>
                    void run('删除', async () => {
                      await window.monitor.deleteContract(item.id)
                      if (baseId === item.id) setBaseId(null)
                      await loadContracts()
                    })
                  }
                >
                  删除
                </button>
              </div>
            ))}
          </div>

          {diff && <ContractDiffView diff={diff} />}
        </div>
      )}

      {tab === 'export' && (
        <div className="ep-export">
          <div className="ep-bar">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy !== null}
              onClick={() =>
                void run('HAR', async () => {
                  const report = await window.monitor.exportHar({ query, maxRows: 5000, includeBodies: true })
                  setHar(report)
                  setMessage(`HAR 落盘：${report.entries} 条 entry / ${formatSize(report.bytes)}${report.bodyMissing > 0 ? ` · ${report.bodyMissing} 条正文已被驱逐` : ''}`)
                })
              }
            >
              {busy === 'HAR' ? '导出中…' : '导出 HAR'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() =>
                void run('JSONL', async () => {
                  const report = await window.monitor.exportJsonl({ query, maxRows: 200000 })
                  setJsonl(report)
                  setMessage(`JSONL 落盘：${report.lines} 行 / ${formatSize(report.bytes)}`)
                })
              }
            >
              {busy === 'JSONL' ? '导出中…' : '导出 JSONL'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() =>
                void run('资源镜像', async () => {
                  const report = await window.monitor.exportBodies({ query, maxRows: 20000, includeBodies: true })
                  setMirror(report)
                  setMessage(`资源镜像：${report.files} 个文件 / ${formatSize(report.bytes)}${report.skipped > 0 ? ` · 跳过 ${report.skipped}` : ''}`)
                })
              }
            >
              {busy === '资源镜像' ? '镜像中…' : '采集资源镜像'}
            </button>
            <span className="spacer" />
            <span className="dim small">当前过滤：{applied ? `URL 含 “${applied}”` : '全部请求'}</span>
            <button type="button" className="ghost" onClick={() => void window.monitor.openDataDir()}>
              打开数据目录
            </button>
          </div>

          <div className="ep-reports">
            {!har && !jsonl && !mirror && (
              <div className="empty">
                导出的东西落在数据目录下的 exports/ 里。HAR 能直接拖进 DevTools 看时序，JSONL 是给脚本吃的，
                资源镜像是把响应体落成真文件（按类型分子目录 + manifest.json）
              </div>
            )}
            {har && (
              <div className="ep-report">
                <h4>HAR</h4>
                <div className="mono small break">{har.path}</div>
                <div className="ep-report-meta mono dim small">
                  {har.entries} entry · {har.pages} page · {formatSize(har.bytes)} · 扫描 {har.scanned}/{har.total}
                  {har.bodyMissing > 0 ? ` · 正文缺失 ${har.bodyMissing}` : ''}
                  {har.truncated ? ' · 已截断' : ''}
                </div>
                {har.sample.map((item, index) => (
                  <div key={`${item.url}-${index}`} className="mono small dim ellipsis">
                    {item.status} {item.url}
                  </div>
                ))}
              </div>
            )}
            {jsonl && (
              <div className="ep-report">
                <h4>JSONL</h4>
                <div className="mono small break">{jsonl.path}</div>
                <div className="ep-report-meta mono dim small">
                  {jsonl.lines} 行 · {formatSize(jsonl.bytes)} · 扫描 {jsonl.scanned}/{jsonl.total}
                  {jsonl.bodyMissing > 0 ? ` · 正文缺失 ${jsonl.bodyMissing}` : ''}
                </div>
              </div>
            )}
            {mirror && (
              <div className="ep-report">
                <h4>资源镜像</h4>
                <div className="mono small break">{mirror.dir}</div>
                <div className="ep-report-meta mono dim small">
                  {mirror.files} 文件 · {formatSize(mirror.bytes)} · 跳过 {mirror.skipped} · 扫描 {mirror.total}
                </div>
                <div className="mono small break dim">manifest: {mirror.manifest}</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function EndpointDetailView(props: { detail: EndpointDetail; profile: EndpointProfile }): React.JSX.Element {
  const { detail, profile } = props
  const responseFields = detail.responseFields ?? flatten(detail.responseSchema)
  const requestFields = flatten(detail.requestSchema)
  return (
    <div className="ep-profile">
      <h3 className="mono ep-profile-key break">{profile.key}</h3>
      <div className="cards">
        <MiniCard label="调用" value={String(profile.calls)} />
        <MiniCard label="不同 URL" value={String(profile.distinctUrls)} />
        <MiniCard label="失败" value={String(profile.failed)} tone={profile.failed > 0 ? 'err' : undefined} />
        <MiniCard label="命中缓存" value={String(profile.cached)} />
        <MiniCard label="经 SW" value={String(profile.fromSw)} />
        <MiniCard label="有响应体" value={String(profile.withBody)} />
        <MiniCard label="传输" value={formatSize(profile.bytes)} />
        <MiniCard label="解码后" value={formatSize(profile.decodedBytes)} />
        <MiniCard label="p50" value={formatMs(profile.durationMs.p50)} />
        <MiniCard label="p95" value={formatMs(profile.durationMs.p95)} />
        <MiniCard label="最快" value={formatMs(profile.durationMs.min)} />
        <MiniCard label="最慢" value={formatMs(profile.durationMs.max)} />
      </div>

      <div className="ep-cols">
        <Section title="状态码">
          <Dist rows={profile.statuses} />
        </Section>
        <Section title="MIME">
          <Dist rows={profile.mimeTypes} />
        </Section>
        <Section title="资源类型">
          <Dist rows={profile.resourceTypes} />
        </Section>
        <Section title="来源 target">
          <Dist rows={profile.targetTypes} />
        </Section>
      </div>

      {profile.rhythm && (
        <div className="mono dim small">
          调用节奏：中位间隔 {Math.round(profile.rhythm.medianGapMs)}ms，跨度 {Math.round(profile.rhythm.spanMs / 1000)}s
          {profile.rhythm.medianGapMs > 0 && profile.rhythm.medianGapMs < 5000 ? '（看着像轮询）' : ''}
        </div>
      )}

      {profile.query.length > 0 && (
        <Section title={`Query 参数（${profile.query.length}）`}>
          <table className="kv ep-table">
            <tbody>
              {profile.query.map((field) => (
                <tr key={field.name}>
                  <td className="mono">{field.name}</td>
                  <td className="mono dim small">{field.count} 次</td>
                  <td className="mono dim small">{field.required ? '必有' : '可选'}</td>
                  <td className="mono dim small ellipsis">{field.values.slice(0, 4).join(' | ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {profile.requestBody.samples > 0 && (
        <Section title={`请求体（样本 ${profile.requestBody.samples} 次）`}>
          <Dist rows={profile.requestBody.kinds} />
          <table className="kv ep-table">
            <tbody>
              {profile.requestBody.fields.map((field) => (
                <tr key={field.name}>
                  <td className="mono">{field.name}</td>
                  <td className="mono dim small">{field.count} 次</td>
                  <td className="mono dim small">{field.required ? '必有' : '可选'}</td>
                  <td className="mono dim small ellipsis">{field.values.slice(0, 4).join(' | ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {responseFields.length > 0 && (
        <Section
          title={`响应结构（${responseFields.length} 条路径${
            detail.responseSamples === undefined ? '' : ` · 样本 ${detail.responseSamples}`
          }${detail.responseSamplesSkipped ? ` · 跳过 ${detail.responseSamplesSkipped}` : ''}）`}
        >
          <table className="kv ep-table">
            <tbody>
              {responseFields.map((field) => (
                <tr key={field.path}>
                  <td className="mono ellipsis">{field.path}</td>
                  <td className="mono dim small">{field.type}</td>
                  <td className="mono dim small">{field.optional ? '非每次都有' : '必有'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {requestFields.length > 0 && (
        <Section title={`请求体结构（样本 ${detail.requestSamples ?? 0}）`}>
          <table className="kv ep-table">
            <tbody>
              {requestFields.map((field) => (
                <tr key={field.path}>
                  <td className="mono ellipsis">{field.path}</td>
                  <td className="mono dim small">{field.type}</td>
                  <td className="mono dim small">{field.optional ? '非每次都有' : '必有'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {detail.recent && detail.recent.length > 0 && (
        <Section title={`最近调用（${detail.recent.length}）`}>
          <table className="kv ep-table">
            <tbody>
              {detail.recent.map((call) => (
                <tr key={call.seq}>
                  <td className="mono dim small">#{call.seq}</td>
                  <td className="mono dim small">{formatTime(call.ts)}</td>
                  <td className={`mono small ${call.status && call.status >= 400 ? 'st-err' : 'st-ok'}`}>
                    {call.status ?? '-'}
                  </td>
                  <td className="mono dim small">{formatMs(call.durationMs)}</td>
                  <td className="mono dim small">{formatSize(call.bytes)}</td>
                  <td className="mono dim small">{call.fromCache ? 'cache' : ''}{call.fromSw ? ' sw' : ''}</td>
                  <td className="mono dim small ellipsis">{call.failed ?? call.bodyState ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
    </div>
  )
}

function ContractDiffView({ diff }: { diff: ContractDiff }): React.JSX.Element {
  const { summary } = diff
  return (
    <div className="ep-diff">
      <div className="cards">
        <MiniCard label="新增端点" value={String(summary.addedEndpoints)} tone={summary.addedEndpoints > 0 ? 'ok' : undefined} />
        <MiniCard label="消失端点" value={String(summary.removedEndpoints)} tone={summary.removedEndpoints > 0 ? 'err' : undefined} />
        <MiniCard label="有变化" value={String(summary.changedEndpoints)} tone={summary.changedEndpoints > 0 ? 'warn' : undefined} />
        <MiniCard label="没变" value={String(summary.unchangedEndpoints)} />
      </div>

      {(summary.newStatusCodes.length > 0 || summary.droppedStatusCodes.length > 0) && (
        <div className="ep-diff-line">
          新状态码：{summary.newStatusCodes.join(', ') || '—'} · 消失状态码：{summary.droppedStatusCodes.join(', ') || '—'}
        </div>
      )}
      {(summary.newResponseFields.length > 0 || summary.droppedResponseFields.length > 0) && (
        <div className="ep-diff-line mono small">
          新响应字段：{summary.newResponseFields.slice(0, 12).join(', ') || '—'}
          {summary.droppedResponseFields.length > 0 && ` · 消失：${summary.droppedResponseFields.slice(0, 12).join(', ')}`}
        </div>
      )}
      {(summary.newRequestFields.length > 0 || summary.newQueryParams.length > 0) && (
        <div className="ep-diff-line mono small">
          新请求字段：{summary.newRequestFields.slice(0, 12).join(', ') || '—'} · 新 Query：
          {summary.newQueryParams.slice(0, 12).join(', ') || '—'}
        </div>
      )}

      {diff.added.length > 0 && (
        <Section title={`新增端点（${diff.added.length}）`}>
          {diff.added.map((item) => (
            <div key={item.key} className="mono small ellipsis">
              + {item.key} · {item.calls} 次 · {item.statuses.join('/') || '-'}
            </div>
          ))}
        </Section>
      )}
      {diff.removed.length > 0 && (
        <Section title={`消失的端点（${diff.removed.length}）`}>
          {diff.removed.map((item) => (
            <div key={item.key} className="mono small ellipsis st-err">
              − {item.key} · 基线里 {item.calls} 次
            </div>
          ))}
        </Section>
      )}
      {diff.changed.length > 0 && (
        <Section title={`有变化的端点（${diff.changed.length}）`}>
          {diff.changed.map((item) => (
            <div key={item.key} className="ep-diff-changed">
              <div className="mono small ellipsis">{item.key}</div>
              <div className="mono dim small">
                {item.statuses.added.length > 0 && `+状态 ${item.statuses.added.join(',')} `}
                {item.statuses.removed.length > 0 && `−状态 ${item.statuses.removed.join(',')} `}
                {item.query.added.length > 0 && `+query ${item.query.added.map((f) => f.name).join(',')} `}
                {item.query.requiredChanged.length > 0 &&
                  `必填变化 ${item.query.requiredChanged.map((f) => `${f.name}:${f.from ? '必填' : '可选'}→${f.to ? '必填' : '可选'}`).join(',')} `}
                {item.requestFields.added.length > 0 && `+字段 ${item.requestFields.added.map((f) => f.name).join(',')} `}
                {item.response.added.length > 0 && `+响应 ${item.response.added.slice(0, 6).map((f) => f.path).join(',')} `}
                {item.response.removed.length > 0 && `−响应 ${item.response.removed.slice(0, 6).map((f) => f.path).join(',')} `}
                {item.response.typeChanged.length > 0 &&
                  `类型变化 ${item.response.typeChanged.map((f) => `${f.path}:${f.from}→${f.to}`).join(',')} `}
                （调用 {item.callsBefore} → {item.callsAfter}）
              </div>
            </div>
          ))}
        </Section>
      )}
    </div>
  )
}

function Section(props: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="ep-section">
      <h4>{props.title}</h4>
      {props.children}
    </div>
  )
}

function MiniCard(props: { label: string; value: string; tone?: string }): React.JSX.Element {
  return (
    <div className="card">
      <span className="card-label">{props.label}</span>
      <b className={props.tone ?? ''}>{props.value}</b>
    </div>
  )
}

function Dist(props: { rows: Array<{ key: string; count: number }> }): React.JSX.Element {
  if (props.rows.length === 0) return <span className="dim small">—</span>
  return (
    <div className="ep-dist">
      {props.rows.slice(0, 8).map((row) => (
        <span key={row.key} className="chip chip-xs">
          {row.key} ×{row.count}
        </span>
      ))}
    </div>
  )
}