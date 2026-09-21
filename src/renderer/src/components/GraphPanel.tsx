import { useCallback, useEffect, useState } from 'react'
import type { RelationReport, RequestGraph } from '../../../shared/types'
import { formatCount, formatMs, formatSize, formatTime } from '../format'

/**
 * 调用图 + 关联分析。
 *
 * 两件事分开看：调用图回答「谁引起的谁」（页面 → 脚本 → 接口），
 * 关联回答「它们之间共享了什么」（同一份响应体、同一条跳转链、同一批参数）。
 * 判读方式不一样，挤一屏反而都看不清，所以做成两个页签。
 */

const BAR_MAX = 28

function shortKey(key: string): string {
  return key.length > 64 ? key.slice(0, 61) + '…' : key
}

export function GraphPanel({ liveTick }: { liveTick: number }): React.JSX.Element {
  const [tab, setTab] = useState<'graph' | 'relations'>('graph')
  const [graph, setGraph] = useState<RequestGraph | null>(null)
  const [relations, setRelations] = useState<RelationReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      if (tab === 'graph') setGraph(await window.monitor.getRequestGraph({ maxRows: 20000, maxNodes: 400 }))
      else setRelations(await window.monitor.getRelations({ maxRows: 20000, limit: 50 }))
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [tab])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), liveTick === 0 ? 0 : 600)
    return () => window.clearTimeout(timer)
  }, [liveTick, load, tab])

  const maxEdge = Math.max(...(graph?.edges.map((edge) => edge.count) ?? [1]), 1)
  const nodeOf = useCallback(
    (key: string) => graph?.nodes.find((node) => node.key === key) ?? null,
    [graph]
  )

  return (
    <div className="gph-panel">
      <div className="gph-tabs">
        <div className="tabs tabs-sm">
          <button type="button" className={`tab ${tab === 'graph' ? 'tab-active' : ''}`} onClick={() => setTab('graph')}>
            调用图
          </button>
          <button type="button" className={`tab ${tab === 'relations' ? 'tab-active' : ''}`} onClick={() => setTab('relations')}>
            关联分析
          </button>
        </div>
        <span className="spacer" />
        {tab === 'graph' && graph && (
          <span className="mono dim small">
            {graph.nodes.length} 节点 · {graph.edges.length} 边 · {graph.clusters.length} 簇 · 扫描{' '}
            {formatCount(graph.scanned)}/{formatCount(graph.total)}
            {graph.truncated ? ' · 已截断' : ''}
            {graph.droppedNodes > 0 ? ` · 丢节点 ${graph.droppedNodes}` : ''}
          </span>
        )}
        {tab === 'relations' && relations && (
          <span className="mono dim small">
            扫描 {formatCount(relations.scanned)}/{formatCount(relations.total)}
            {relations.truncated ? ' · 已截断' : ''}
          </span>
        )}
        <button type="button" className="ghost" onClick={() => void load()} disabled={loading}>
          {loading ? '扫描中…' : '刷新'}
        </button>
      </div>

      {error && <div className="banner banner-err">{error}</div>}

      {tab === 'graph' && (
        <div className="gph-graph">
          {!graph && <div className="empty">正在建图…</div>}
          {graph && graph.edges.length === 0 && (
            <div className="empty">还没有调用关系。页面跑起来、有 XHR/Fetch 之后就有了</div>
          )}
          {graph && graph.edges.length > 0 && (
            <div className="gph-split">
              <div className="gph-edges">
                {graph.edges.map((edge) => {
                  const key = `${edge.from}→${edge.to}`
                  const from = nodeOf(edge.from)
                  const to = nodeOf(edge.to)
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`gph-edge ${selected === key ? 'gph-edge-active' : ''}`}
                      onClick={() => setSelected(selected === key ? null : key)}
                    >
                      <span className="gph-bar" style={{ width: `${(edge.count / maxEdge) * BAR_MAX}%` }} />
                      <span className="mono small gph-from ellipsis">
                        {from?.kind === 'endpoint' ? from.label : `${from?.kind ?? '?'} ${from?.label ?? edge.from}`}
                      </span>
                      <span className="mono dim small">→</span>
                      <span className="mono small gph-to ellipsis">
                        {to?.kind === 'endpoint' ? to.label : `${to?.kind ?? '?'} ${to?.label ?? edge.to}`}
                      </span>
                      <span className="mono dim small gph-num">
                        {edge.count} 次 · 均 {formatMs(edge.avgMs)} · p95 {formatMs(edge.p95Ms)}
                        {edge.failures > 0 ? ` · 失败 ${edge.failures}` : ''}
                      </span>
                      <span className="gph-initiators">
                        {edge.initiatorTypes.slice(0, 3).map((item) => (
                          <span key={item.key} className="chip chip-xs">
                            {item.key} ×{item.count}
                          </span>
                        ))}
                      </span>
                      {selected === key && (
                        <span className="gph-samples mono dim small">
                          seq {edge.samples.slice(0, 30).join(', ')}
                          {edge.firstTs ? ` · ${formatTime(edge.firstTs)} → ${formatTime(edge.lastTs ?? edge.firstTs)}` : ''}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>

              <div className="gph-side">
                <h4>功能簇（{graph.clusters.length}）</h4>
                <div className="dim small">
                  连通的节点算一簇 —— 互相牵动的东西会被分到一起，孤立的小簇通常是可以忽略的噪声
                </div>
                {graph.clusters.slice(0, 12).map((cluster, index) => (
                  <div key={index} className="gph-cluster">
                    <span className="chip chip-xs">{cluster.size} 节点</span>
                    <span className="mono dim small ellipsis">
                      {cluster.nodes.slice(0, 4).map(shortKey).join(' · ')}
                      {cluster.nodes.length > 4 ? ` … +${cluster.nodes.length - 4}` : ''}
                    </span>
                  </div>
                ))}

                <h4>节点（{graph.nodes.length}）</h4>
                <table className="kv ep-table">
                  <tbody>
                    {graph.nodes.slice(0, 60).map((node) => (
                      <tr key={node.key}>
                        <td className="mono dim small">{node.kind}</td>
                        <td className="mono small ellipsis" title={node.url ?? node.key}>
                          {node.label}
                        </td>
                        <td className="mono dim small">出 {node.outCalls}</td>
                        <td className="mono dim small">入 {node.inCalls}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'relations' && (
        <div className="gph-rel">
          {!relations && <div className="empty">正在算关联…</div>}
          {relations && (
            <>
              <Section title={`共享响应体（${relations.sharedBodies.length}）`}>
                <div className="dim small">
                  同一份响应体（内容 hash 相同）被多个地址拿到 —— 后端的重复资源、或者缓存没生效
                </div>
                {relations.sharedBodies.map((item) => (
                  <div key={item.hash} className="gph-rel-row">
                    <span className="mono dim small">{item.hash.slice(0, 12)}</span>
                    <span className="mono dim small">{formatSize(item.size)}</span>
                    <span className="chip chip-xs">{item.refs} 次</span>
                    <span className="chip chip-xs">{item.distinctUrls} URL</span>
                    <span className="mono dim small ellipsis">{item.sampleUrls.slice(0, 2).join(' | ')}</span>
                  </div>
                ))}
                {relations.sharedBodies.length === 0 && <div className="dim small">没有（每份正文都只被取过一次）</div>}
              </Section>

              <Section title={`重定向链（${relations.redirectChains.length}）`}>
                {relations.redirectChains.map((chain) => (
                  <div key={chain.requestId} className="gph-rel-row">
                    <span className="chip chip-xs">{chain.hops} 跳</span>
                    <span className="mono dim small ellipsis">
                      {chain.steps.map((step) => `${step.status ?? '?'} ${step.method} ${step.url}`).join('  →  ')}
                    </span>
                  </div>
                ))}
                {relations.redirectChains.length === 0 && <div className="dim small">这次没有任何 3xx 跳转</div>}
              </Section>

              <Section title={`共享 Query 参数（${relations.sharedParams.length}）`}>
                <div className="dim small">同一个 name=value 出现在多个端点上 —— token、会话 id、埋点参数都会这样露出来</div>
                <table className="kv ep-table">
                  <tbody>
                    {relations.sharedParams.map((item) => (
                      <tr key={`${item.name}=${item.value}`}>
                        <td className="mono small">{item.name}</td>
                        <td className="mono dim small ellipsis" title={item.value}>
                          {item.value.length > 40 ? item.value.slice(0, 40) + '…' : item.value}
                        </td>
                        <td className="mono dim small">{item.count} 次</td>
                        <td className="mono dim small">{item.endpointCount} 端点</td>
                        <td className="mono dim small">{item.hosts.join(', ').slice(0, 40)}</td>
                        <td>{item.crossHost && <span className="chip chip-xs chip-hot">跨域</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Section>

              <Section title={`页面 → 域的关联（${relations.domainLinks.length}）`}>
                <table className="kv ep-table">
                  <tbody>
                    {relations.domainLinks.slice(0, 40).map((item) => (
                      <tr key={`${item.frameHost}-${item.host}`}>
                        <td className="mono small ellipsis">{item.frameHost}</td>
                        <td className="mono dim small">→</td>
                        <td className="mono small ellipsis">{item.host}</td>
                        <td className="mono dim small">{item.count} 次</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Section>
            </>
          )}
        </div>
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