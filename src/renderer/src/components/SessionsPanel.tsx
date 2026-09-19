import { useCallback, useEffect, useState } from 'react'
import type { Profile, SessionOverview } from '../../../shared/types'
import { formatCount, formatSize } from '../format'

/** 时间戳 → 'MM-DD HH:mm:ss'。只给会话管理看，不引第三方库 */
function when(ms: number | null): string {
  if (ms === null || ms === undefined) return '-'
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    pad(date.getMonth() + 1) +
    '-' +
    pad(date.getDate()) +
    ' ' +
    pad(date.getHours()) +
    ':' +
    pad(date.getMinutes()) +
    ':' +
    pad(date.getSeconds())
  )
}

function duration(startedAt: number, endedAt: number | null): string {
  const end = endedAt ?? Date.now()
  const seconds = Math.max(0, Math.round((end - startedAt) / 1000))
  if (seconds < 60) return seconds + 's'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes + 'm' + (seconds % 60) + 's'
  return Math.floor(minutes / 60) + 'h' + (minutes % 60) + 'm'
}

export function SessionsPanel({ liveTick }: { liveTick: number }): React.JSX.Element {
  const [data, setData] = useState<SessionOverview | null>(null)
  const [switching, setSwitching] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setData(await window.monitor.getSessions())
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => void load(), liveTick === 0 ? 0 : 500)
    return () => clearTimeout(timer)
  }, [liveTick, load])

  const switchTo = useCallback(
    async (profile: Profile) => {
      setSwitching(true)
      setMessage(null)
      setError(null)
      const result = await window.monitor.switchProfile(profile)
      setSwitching(false)
      if (result.ok) {
        setMessage(`已切到 Profile ${result.profile} —— 浏览器已重启，库里多一条实例记录`)
        await load()
      } else {
        setError(result.error ?? '切换失败')
      }
    },
    [load]
  )

  if (!data) {
    return <div className="sessions empty">正在读会话…</div>
  }

  const current = data.instances.find((row) => row.id === data.current) ?? null
  const profile = current?.profile ?? null

  return (
    <div className="sessions">
      <div className="sessions-bar">
        <span className="sessions-label">当前实例</span>
        <span className="chip chip-hot">{data.current ? '#' + data.current : '未开始'}</span>
        {profile && <span className="chip">{profile}</span>}
        <span className="chip chip-dim">{current ? duration(current.started_at, current.ended_at) : '-'}</span>
        <span className="chip chip-dim">{data.targets.length} target</span>
        <span className="spacer" />
        <span className="dim small">切 Profile 会收工并重启浏览器（热切是假的：启动参数与 domain 白名单钉在进程生命周期里）</span>
        <button
          type="button"
          className="btn"
          disabled={switching || profile === 'L'}
          onClick={() => void switchTo('L')}
        >
          切到 Profile L
        </button>
        <button
          type="button"
          className="btn"
          disabled={switching || profile === 'H'}
          onClick={() => void switchTo('H')}
        >
          切到 Profile H
        </button>
        <button type="button" className="ghost" onClick={() => void load()}>
          刷新
        </button>
        {switching && <span className="dim small">切换中…</span>}
      </div>

      {message && <div className="banner">{message}</div>}
      {error && <div className="banner banner-err">{error}</div>}

      <div className="sessions-cards">
        <Card label="实例数" value={formatCount(data.instances.length)} />
        <Card label="当前请求" value={formatCount(current?.stats?.requests ?? 0)} />
        <Card label="当前 body" value={formatCount(current?.stats?.bodies ?? 0)} />
        <Card label="当前脚本" value={formatCount(current?.stats?.scripts ?? 0)} />
        <Card label="库文件" value={data.storage ? formatSize(data.storage.dbBytes) : '-'} />
        <Card
          label="body 占用"
          value={data.storage ? formatSize(data.storage.bodyBytes) : '-'}
        />
      </div>

      <h4>实例（最近 {data.instances.length} 次）</h4>
      <table className="kv sessions-table">
        <tbody>
          {data.instances.map((row) => (
            <tr key={row.id} className={row.live ? 'session-live' : ''}>
              <td className="mono">#{row.id}</td>
              <td className="mono dim">{when(row.started_at)}</td>
              <td className="mono dim">{when(row.ended_at)}</td>
              <td className="mono">{row.profile ?? '-'}</td>
              <td className="mono dim">{row.kernel_version ?? '-'}</td>
              <td className="mono">{formatCount(row.stats?.requests ?? 0)} 请求</td>
              <td className="mono dim">
                body {formatCount(row.stats?.bodies ?? 0)} · 脚本 {formatCount(row.stats?.scripts ?? 0)}
              </td>
              <td className="mono dim ellipsis">{row.url ?? '-'}</td>
              <td>{row.live ? <span className="chip chip-xs chip-hot">live</span> : <span className="dim small">已结束</span>}</td>
            </tr>
          ))}
          {data.instances.length === 0 && (
            <tr>
              <td className="dim small">还没有实例记录（存储没起来时不会有）</td>
            </tr>
          )}
        </tbody>
      </table>

      <h4>存储分区</h4>
      {data.storage ? (
        <>
          <div className="mono small break dim">{data.storage.dbPath}</div>
          <table className="kv sessions-table">
            <tbody>
              {data.storage.tables.map((table) => (
                <tr key={table.name}>
                  <td className="mono">{table.name}</td>
                  <td className="mono dim">{formatCount(table.rows)} 行</td>
                </tr>
              ))}
              <tr>
                <td className="mono">body 去重后</td>
                <td className="mono dim">{formatSize(data.storage.bodyBytes)}</td>
              </tr>
              <tr>
                <td className="mono">库文件（含 WAL）</td>
                <td className="mono dim">{formatSize(data.storage.dbBytes)}</td>
              </tr>
            </tbody>
          </table>
          <button type="button" className="link" onClick={() => void window.monitor.openDataDir()}>
            打开数据目录
          </button>
        </>
      ) : (
        <div className="dim small">存储未启用，读不到分区信息</div>
      )}

      <h4>本次 target（{data.targets.length}）</h4>
      <div className="sessions-targets">
        {data.targets.map((target) => (
          <span
            key={target.targetId}
            className={`chip chip-xs ${target.attached ? 'chip-hot' : 'chip-dim'}`}
            title={target.url}
          >
            {target.type} {target.url ? target.url.replace(/^https?:\/\//, '').slice(0, 40) : ''}
          </span>
        ))}
        {data.targets.length === 0 && <span className="dim small">还没有 target</span>}
      </div>
    </div>
  )
}

function Card(props: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="card">
      <span className="card-label">{props.label}</span>
      <b>{props.value}</b>
    </div>
  )
}