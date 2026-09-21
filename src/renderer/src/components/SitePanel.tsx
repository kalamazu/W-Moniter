import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  CookieRecord,
  CookieStats,
  SiteDetail,
  SiteOriginRow,
  SiteSnapshotDiff,
  SiteSnapshotSummary
} from '../../../shared/types'
import { formatCount, formatSize, formatTime } from '../format'

/**
 * 站点资源面板：这个浏览器里，每个站到底存了什么。
 *
 * 和请求列表那种「流量流过就记下」的面板不同，这里的每一行都要**主动去问浏览器**：
 * cookie 罐是浏览器级的（问一次很便宜，所以自动轮询），站点存储要按域扫
 * （每个域要连着问好几条 CDP，所以是「点了才扫」）。
 *
 * 也因此，面板上永远有两个时间概念：库里那份是「上次扫描的快照」，
 * 顶栏那个「刷新」才是「现在」。这两个混起来看会得出错误结论，所以分开标。
 */

type Tab = 'cookie' | 'storage' | 'idb' | 'cache' | 'sw' | 'snapshot'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'cookie', label: 'Cookie' },
  { id: 'storage', label: '本地存储' },
  { id: 'idb', label: 'IndexedDB' },
  { id: 'cache', label: '缓存' },
  { id: 'sw', label: 'Service Worker' },
  { id: 'snapshot', label: '快照' }
]

/** 列表轮询：库里的东西变得没那么快，1s 足够 */
const POLL_MS = 1000
/** 值在屏上最多显示这么多字符。cookie 里塞 JSON 的不少见，全铺出来会把表格撑爆 */
const VALUE_PREVIEW = 90

function clip(value: string, max = VALUE_PREVIEW): string {
  if (value.length <= max) return value
  return value.slice(0, max) + '…'
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname
  } catch {
    return origin
  }
}

function cookieFlags(cookie: CookieRecord): string[] {
  const flags: string[] = []
  if (cookie.httpOnly) flags.push('HttpOnly')
  if (cookie.secure) flags.push('Secure')
  if (cookie.partitionKey) flags.push('分区')
  if (cookie.crossSite) flags.push('跨站')
  if (cookie.session) flags.push('会话')
  if (cookie.sameSite) flags.push('SameSite=' + cookie.sameSite)
  return flags
}

export function SitePanel({ liveTick = 0 }: { liveTick?: number }): React.JSX.Element {
  const [origins, setOrigins] = useState<SiteOriginRow[]>([])
  const [stats, setStats] = useState<CookieStats | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<SiteDetail | null>(null)
  const [tab, setTab] = useState<Tab>('cookie')
  const [search, setSearch] = useState('')
  const [onlyScanned, setOnlyScanned] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [snapshots, setSnapshots] = useState<SiteSnapshotSummary[]>([])
  const [diff, setDiff] = useState<SiteSnapshotDiff | null>(null)
  const [expandedCache, setExpandedCache] = useState<string | null>(null)

  // 轮询回调里要读它，但它的变化不该重建轮询（重建会打断正在进行的请求）
  const selectedRef = useRef<string | null>(null)
  useEffect(() => {
    selectedRef.current = selected
  }, [selected])

  const refresh = useCallback(async (): Promise<void> => {
    const [list, cookieStats] = await Promise.all([
      window.monitor.getSiteOrigins({ limit: 300, onlyScanned }),
      window.monitor.getCookieStats()
    ])
    if (list) setOrigins(list.rows)
    setStats(cookieStats)
    const current = selectedRef.current
    if (current) setDetail(await window.monitor.getSiteDetail(current))
  }, [onlyScanned])

  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      try {
        await refresh()
        if (alive) setError(null)
      } catch (err) {
        if (alive) setError((err as Error).message)
      }
    }
    void tick()
    const id = window.setInterval(() => void tick(), POLL_MS)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [refresh, liveTick])

  useEffect(() => {
    void window.monitor.listSiteSnapshots(50).then((rows) => setSnapshots(rows ?? []))
  }, [liveTick, busy])

  const act = useCallback(async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(label)
    setNote(null)
    try {
      const result = await fn()
      const resultError = (result as { error?: string } | null)?.error
      setNote(resultError ? `${label}：${resultError}` : `${label} 完成`)
      await refresh()
    } catch (err) {
      setNote(`${label} 失败：${(err as Error).message}`)
    } finally {
      setBusy('')
    }
  }, [refresh])

  const filtered = useMemo(() => {
    const text = search.trim().toLowerCase()
    if (!text) return origins
    return origins.filter((row) => row.origin.toLowerCase().includes(text))
  }, [origins, search])

  const selectedRow = useMemo(
    () => origins.find((row) => row.origin === selected) ?? null,
    [origins, selected]
  )

  const cookies = detail?.cookies ?? []

  return (
    <div className="sp-panel">
      <div className="sp-bar">
        <input
          className="search"
          placeholder="筛域名…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <label className="sp-check">
          <input type="checkbox" checked={onlyScanned} onChange={(event) => setOnlyScanned(event.target.checked)} />
          只看扫过的
        </label>
        <button
          type="button"
          className="tab"
          disabled={busy !== ''}
          title="去浏览器里真扫一遍：cookie 罐全量对账 + 站点存储"
          onClick={() => void act('扫描', () => window.monitor.scanSiteData({ origin: selected ?? undefined, limit: 30 }))}
        >
          {busy === '扫描' ? '扫描中…' : '刷新扫描'}
        </button>
        <button
          type="button"
          className="tab"
          disabled={busy !== ''}
          title="拍一份站点资源快照，之后可以 diff 出「多了什么」"
          onClick={() => void act('拍快照', () => window.monitor.siteSnapshot({ label: new Date().toLocaleTimeString() }))}
        >
          拍快照
        </button>
        <span className="sp-stat">
          cookie {stats ? `${formatCount(stats.total)} 条 / ${formatSize(stats.totalBytes)}` : '-'}
          {stats ? ` · 跨站 ${stats.crossSite} · 分区 ${stats.partitioned} · 域 ${stats.hosts}` : ''}
        </span>
      </div>

      {error ? <div className="sp-note sp-note-err">读取失败：{error}</div> : null}
      {note ? <div className="sp-note">{note}</div> : null}

      <div className="sp-split">
        <div className="sp-list">
          {filtered.length === 0 ? <div className="sp-empty">还没有站点。先刷新扫描。</div> : null}
          {filtered.map((row) => (
            <div
              key={row.origin}
              className={'sp-origin' + (row.origin === selected ? ' sp-origin-active' : '')}
              onClick={() => setSelected(row.origin)}
            >
              <div className="sp-origin-host">{row.origin}</div>
              <div className="sp-origin-meta">
                <span className={row.cookieCount > 0 ? 'st-info' : 'st-dim'}>cookie {row.cookieCount}</span>
                <span className={row.localStorageCount > 0 ? 'st-ok' : 'st-dim'}>
                  本地 {row.localStorageCount}
                </span>
                <span className={row.idbNames.length > 0 ? 'st-warn' : 'st-dim'}>IDB {row.idbNames.length}</span>
                <span className={row.cacheEntries > 0 ? 'st-ok' : 'st-dim'}>缓存 {row.cacheEntries}</span>
                <span className={row.swCount > 0 ? 'st-warn' : 'st-dim'}>SW {row.swCount}</span>
              </div>
              <div className="sp-origin-meta">
                <span className="st-dim">
                  {row.scanned ? `扫于 ${formatTime(row.updatedAt)}` : '还没扫过'}
                  {row.usageBytes === null ? '' : ` · ${formatSize(row.usageBytes)}`}
                </span>
              </div>
            </div>
          ))}
        </div>

        <div className="sp-detail">
          {!selected || !detail ? (
            <div className="sp-empty">左边选一个域，这里看它存了什么。</div>
          ) : (
            <>
              <div className="sp-head">
                <span className="sp-head-origin">{selected}</span>
                <span className="sp-spacer" />
                <button
                  type="button"
                  className="tab"
                  disabled={busy !== ''}
                  title="清掉这个域的 cookie / 本地存储 / IndexedDB / 缓存 / Service Worker"
                  onClick={() => {
                    if (!window.confirm(`清空 ${selected} 的站点数据？`)) return
                    void act('清空站点', () => window.monitor.clearSiteData(selected, ['all']))
                  }}
                >
                  清空该域
                </button>
              </div>

              <div className="sp-tabs">
                {TABS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={'tab' + (tab === item.id ? ' tab-on' : '')}
                    onClick={() => setTab(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <div className="sp-body">
                {tab === 'cookie' ? (
                  <>
                    <div className="sp-row-actions">
                      <button
                        type="button"
                        className="tab"
                        disabled={busy !== '' || cookies.length === 0}
                        onClick={() =>
                          void act('删该域 cookie', () =>
                            window.monitor.deleteCookies({ host: hostOf(selected) })
                          )
                        }
                      >
                        删掉这个域的 {cookies.length} 条 cookie
                      </button>
                    </div>
                    <table className="sp-table">
                      <thead>
                        <tr>
                          <th>名字</th>
                          <th>值</th>
                          <th>域 / 路径</th>
                          <th>体积</th>
                          <th>标记</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {cookies.map((cookie) => (
                          <tr key={cookie.key}>
                            <td className="sp-mono">{cookie.name}</td>
                            <td className="sp-mono sp-value" title={cookie.value}>
                              {clip(cookie.value)}
                              {cookie.truncated ? <span className="st-warn">（已截断）</span> : null}
                            </td>
                            <td className="sp-mono st-dim">
                              {cookie.domain}
                              {cookie.path}
                            </td>
                            <td className="sp-mono">{formatSize(cookie.size)}</td>
                            <td className="sp-flags">{cookieFlags(cookie).join(' · ')}</td>
                            <td>
                              <button
                                type="button"
                                className="tab"
                                title="删掉这一条"
                                onClick={() =>
                                  void act('删 cookie', () =>
                                    window.monitor.deleteCookies({
                                      name: cookie.name,
                                      domain: cookie.domain,
                                      path: cookie.path
                                    })
                                  )
                                }
                              >
                                ✕
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {cookies.length === 0 ? <div className="sp-empty">这个域没有 cookie。</div> : null}
                  </>
                ) : null}

                {tab === 'storage' ? (
                  <div className="sp-cols">
                    <StorageTable
                      title={`localStorage（${detail.localStorage.length} 项 / ${formatSize(detail.localStorageBytes)}）`}
                      rows={detail.localStorage}
                      onRemove={(key) =>
                        void act('删键', () =>
                          window.monitor.editStorage({ origin: selected, area: 'local', action: 'remove', key })
                        )
                      }
                      onClear={() =>
                        void act('清空 localStorage', () =>
                          window.monitor.editStorage({ origin: selected, area: 'local', action: 'clear' })
                        )
                      }
                    />
                    <StorageTable
                      title={`sessionStorage（${detail.sessionStorage.length} 项 / ${formatSize(detail.sessionStorageBytes)}）`}
                      rows={detail.sessionStorage}
                      onRemove={(key) =>
                        void act('删键', () =>
                          window.monitor.editStorage({ origin: selected, area: 'session', action: 'remove', key })
                        )
                      }
                      onClear={() =>
                        void act('清空 sessionStorage', () =>
                          window.monitor.editStorage({ origin: selected, area: 'session', action: 'clear' })
                        )
                      }
                    />
                  </div>
                ) : null}

                {tab === 'idb' ? (
                  <div>
                    {detail.idb.length === 0 ? <div className="sp-empty">没有 IndexedDB 库。</div> : null}
                    {detail.idb.map((db) => (
                      <div key={db.name} className="sp-card">
                        <div className="sp-card-head">
                          <span className="sp-mono">{db.name}</span>
                          <span className="st-dim">v{db.version}</span>
                          <span className="sp-spacer" />
                          <button
                            type="button"
                            className="tab"
                            onClick={() => void act('删 IndexedDB', () => window.monitor.deleteIdbDatabase(selected, db.name))}
                          >
                            删掉这个库
                          </button>
                        </div>
                        <div className="sp-card-body">
                          {db.objectStores.length === 0 ? (
                            <div className="st-dim">没有 object store</div>
                          ) : (
                            db.objectStores.map((store) => (
                              <div key={store.name} className="sp-line">
                                <span className="sp-mono">{store.name}</span>
                                {store.keyPath ? <span className="st-dim">keyPath={store.keyPath}</span> : null}
                                {store.autoIncrement ? <span className="st-dim">自增</span> : null}
                                {store.indexes.length > 0 ? (
                                  <span className="st-dim">索引 {store.indexes.join(', ')}</span>
                                ) : null}
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}

                {tab === 'cache' ? (
                  <div>
                    {detail.caches.length === 0 ? <div className="sp-empty">没有 CacheStorage 缓存。</div> : null}
                    {detail.caches.map((cache) => (
                      <div key={cache.name} className="sp-card">
                        <div className="sp-card-head">
                          <button
                            type="button"
                            className="sp-cache-toggle"
                            onClick={() => setExpandedCache(expandedCache === cache.name ? null : cache.name)}
                          >
                            {expandedCache === cache.name ? '▾' : '▸'} <span className="sp-mono">{cache.name}</span>
                          </button>
                          <span className="st-dim">{cache.count} 条</span>
                          <span className="sp-spacer" />
                          <button
                            type="button"
                            className="tab"
                            onClick={() => void act('删缓存', () => window.monitor.deleteCache(selected, cache.name))}
                          >
                            删掉这个缓存
                          </button>
                        </div>
                        {expandedCache === cache.name ? (
                          <div className="sp-card-body">
                            {cache.entries.map((entry) => (
                              <div key={entry.url} className="sp-line">
                                <span className="sp-mono sp-value" title={entry.url}>
                                  {clip(entry.url, 120)}
                                </span>
                                {entry.status === undefined ? null : <span className="st-dim">{entry.status}</span>}
                                <button
                                  type="button"
                                  className="tab"
                                  onClick={() =>
                                    void act('删缓存条目', () =>
                                      window.monitor.deleteCache(selected, cache.name, entry.url)
                                    )
                                  }
                                >
                                  ✕
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}

                {tab === 'sw' ? (
                  <div>
                    {detail.serviceWorkers.length === 0 ? (
                      <div className="sp-empty">没有 Service Worker 注册。</div>
                    ) : null}
                    {detail.serviceWorkers.map((worker) => (
                      <div key={worker.scopeURL} className="sp-card">
                        <div className="sp-card-head">
                          <span className="sp-mono">{worker.scopeURL}</span>
                          <span className={worker.isDeleted ? 'st-err' : 'st-ok'}>
                            {worker.isDeleted ? '已注销' : worker.runningStatus ?? worker.status ?? '已注册'}
                          </span>
                          <span className="sp-spacer" />
                          <button
                            type="button"
                            className="tab"
                            onClick={() => void act('注销 SW', () => window.monitor.unregisterServiceWorker(worker.scopeURL))}
                          >
                            注销
                          </button>
                        </div>
                        {worker.scriptURL ? <div className="sp-line st-dim sp-mono">{worker.scriptURL}</div> : null}
                      </div>
                    ))}
                    {detail.usageBreakdown.length > 0 ? (
                      <div className="sp-card">
                        <div className="sp-card-head">
                          <span>用量构成</span>
                          <span className="st-dim">
                            共 {formatSize(detail.usageBytes)} / 配额 {formatSize(detail.quotaBytes)}
                          </span>
                        </div>
                        <div className="sp-card-body">
                          {detail.usageBreakdown.map((item) => (
                            <div key={item.storageType} className="sp-line">
                              <span className="sp-mono">{item.storageType}</span>
                              <span className="st-dim">{formatSize(item.usage)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {tab === 'snapshot' ? (
                  <div>
                    <div className="sp-row-actions">
                      <button
                        type="button"
                        className="tab"
                        disabled={busy !== ''}
                        onClick={() => void act('拍快照', () => window.monitor.siteSnapshot({ label: new Date().toLocaleTimeString() }))}
                      >
                        拍一份快照
                      </button>
                      {diff ? (
                        <button type="button" className="tab" onClick={() => setDiff(null)}>
                          收起对比
                        </button>
                      ) : null}
                    </div>
                    {diff ? (
                      <div className="sp-card">
                        <div className="sp-card-head">
                          <span>与快照 #{diff.baseId} 的差异</span>
                          <span className="st-dim">{formatTime(diff.createdAt)}</span>
                        </div>
                        <div className="sp-card-body">
                          <div className="sp-line">
                            域：新增 {diff.summary.originsAdded} · 消失 {diff.summary.originsRemoved}
                          </div>
                          <div className="sp-line">
                            cookie：新增 {diff.summary.cookiesAdded} · 消失 {diff.summary.cookiesRemoved} · 改写{' '}
                            {diff.summary.cookiesChanged}
                          </div>
                          <div className="sp-line">
                            本地存储键：新增 {diff.summary.keysAdded} · 消失 {diff.summary.keysRemoved} · 内容变化{' '}
                            {diff.summary.keysChanged}
                          </div>
                          {diff.cookies.added.slice(0, 20).map((cookie) => (
                            <div key={'a' + cookie.domain + cookie.name} className="sp-line st-ok">
                              + {cookie.domain} {cookie.name}
                            </div>
                          ))}
                          {diff.cookies.changed.slice(0, 20).map((cookie) => (
                            <div key={'c' + cookie.domain + cookie.name} className="sp-line st-warn">
                              ~ {cookie.domain} {cookie.name}（{cookie.fields.join('/')}）
                            </div>
                          ))}
                          {diff.cookies.removed.slice(0, 20).map((cookie) => (
                            <div key={'r' + cookie.domain + cookie.name} className="sp-line st-err">
                              − {cookie.domain} {cookie.name}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    <table className="sp-table">
                      <thead>
                        <tr>
                          <th>id</th>
                          <th>标签</th>
                          <th>时间</th>
                          <th>域 / cookie</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {snapshots.map((snap) => (
                          <tr key={snap.id}>
                            <td className="sp-mono">{snap.id}</td>
                            <td>{snap.label ?? '-'}</td>
                            <td className="st-dim">{formatTime(snap.createdAt)}</td>
                            <td className="st-dim">
                              {snap.origins} / {snap.cookies}
                            </td>
                            <td>
                              <button
                                type="button"
                                className="tab"
                                onClick={() => void window.monitor.siteSnapshotDiff(snap.id).then((result) => setDiff(result))}
                              >
                                对比
                              </button>
                              <button
                                type="button"
                                className="tab"
                                onClick={() => void act('删快照', () => window.monitor.deleteSiteSnapshot(snap.id))}
                              >
                                ✕
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {snapshots.length === 0 ? <div className="sp-empty">还没有快照。</div> : null}
                  </div>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>

      {selectedRow ? null : null}
    </div>
  )
}

function StorageTable({
  title,
  rows,
  onRemove,
  onClear
}: {
  title: string
  rows: Array<{ key: string; value: string; bytes: number; truncated?: boolean }>
  onRemove: (key: string) => void
  onClear: () => void
}): React.JSX.Element {
  return (
    <div className="sp-storage">
      <div className="sp-card-head">
        <span>{title}</span>
        <span className="sp-spacer" />
        <button type="button" className="tab" disabled={rows.length === 0} onClick={onClear}>
          清空
        </button>
      </div>
      {rows.length === 0 ? <div className="sp-empty">空</div> : null}
      {rows.map((row) => (
        <div key={row.key} className="sp-line">
          <span className="sp-mono sp-key" title={row.key}>
            {clip(row.key, 40)}
          </span>
          <span className="sp-mono sp-value" title={row.value}>
            {clip(row.value)}
            {row.truncated ? <span className="st-warn">（已截断）</span> : null}
          </span>
          <span className="st-dim">{formatSize(row.bytes)}</span>
          <button type="button" className="tab" onClick={() => onRemove(row.key)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}