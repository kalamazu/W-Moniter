import { useCallback, useEffect, useState } from 'react'
import type { BrowserTree, BrowserActionEvidence, BrowserTabCommand } from '../../../shared/contracts/browser'

export function BrowserPanel({ liveTick = 0 }: { liveTick?: number }): React.JSX.Element {
  const [workspaceId, setWorkspaceId] = useState('')
  const [tree, setTree] = useState<BrowserTree | null>(null)
  const [timeline, setTimeline] = useState<BrowserActionEvidence[]>([])
  const [selected, setSelected] = useState('')
  const [url, setUrl] = useState('https://example.com/')
  const [note, setNote] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    const workspaces = await window.monitor.getWorkspaces(); const id = workspaces.output?.activeWorkspaceId
    if (!id) return; setWorkspaceId(id); const target = { kind: 'workspace' as const, workspaceId: id }
    const [treeResult, historyResult] = await Promise.all([window.monitor.executeAction({ action: 'browser.tree', input: {}, target }), window.monitor.executeAction({ action: 'browser.timeline', input: { limit: 50 }, target })])
    if (treeResult.output) { const next = treeResult.output as BrowserTree; setTree(next); if (!selected && next.tabs[0]) setSelected(next.tabs[0].targetId) }
    if (Array.isArray(historyResult.output)) setTimeline(historyResult.output as BrowserActionEvidence[])
  }, [selected])
  useEffect(() => { void refresh() }, [refresh, liveTick])

  const run = async (command: BrowserTabCommand): Promise<void> => {
    const tab = tree?.tabs.find((item) => item.targetId === selected); if (!tab || !workspaceId) return
    const result = await window.monitor.executeAction({ action: 'tab.command', input: { generation: tab.generation, command }, target: { kind: 'tab', workspaceId, browserId: 'primary', tabId: tab.targetId } })
    setNote(result.task.error?.message ?? JSON.stringify(result.output)); await refresh()
  }
  const create = async (): Promise<void> => { if (!workspaceId) return; const result = await window.monitor.executeAction({ action: 'browser.tabCreate', input: { url }, target: { kind: 'workspace', workspaceId } }); setNote(result.task.error?.message ?? '已创建'); await refresh() }
  const tab = tree?.tabs.find((item) => item.targetId === selected)
  return <div className="sp-panel">
    <div className="sp-bar"><input className="search" value={url} onChange={(event) => setUrl(event.target.value)} /><button className="tab" onClick={() => void create()}>新建标签</button><button className="tab" disabled={!tab} onClick={() => void run({ kind: 'navigate', url })}>导航</button><button className="tab" disabled={!tab} onClick={() => void run({ kind: 'reload', ignoreCache: true })}>强制刷新</button><button className="tab" disabled={!tab} onClick={() => void run({ kind: 'activate' })}>激活</button><button className="tab" disabled={!tab} onClick={() => void run({ kind: 'close' })}>关闭</button></div>
    {note ? <div className="rules-note">{note}</div> : null}
    <div className="sp-layout"><div className="sp-origins">{tree?.tabs.map((item) => <button key={item.targetId} className={'sp-origin' + (selected === item.targetId ? ' is-active' : '')} onClick={() => { setSelected(item.targetId); setUrl(item.url) }}><span className="sp-origin-name">{item.url || 'about:blank'}</span><small>代次 {item.generation} · Frame {item.frames.length}</small></button>)}</div>
      <div className="sp-detail">{tab ? <><div className="sp-head"><b>{tab.url}</b></div><div className="sp-body"><h4>Frame 树</h4>{tab.frames.map((frame) => <div className="sp-line" key={frame.id}><span className="sp-mono">{frame.id.slice(0, 8)}</span><span>{frame.url}</span></div>)}<h4>动作时间线</h4>{timeline.filter((item) => item.targetId === tab.targetId).map((item) => <div className="sp-line" key={item.actionId}><span className={item.ok ? 'st-ok' : 'st-err'}>{item.kind}</span><span>g{item.generation}</span><span>{new Date(item.finishedAt).toLocaleTimeString()}</span><span>{item.error}</span></div>)}</div></> : <div className="sp-empty">选择一个标签页</div>}</div></div>
  </div>
}
