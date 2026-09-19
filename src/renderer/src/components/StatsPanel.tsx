import { useEffect, useState } from 'react'
import type { Stats } from '../../../shared/types'
import { formatCount, formatMs, formatSize, typeColor } from '../format'

const GROUP_TITLES: Record<string, string> = {
  resource_type: '资源类型',
  status: '状态码',
  host: '主机',
  mime_type: 'MIME',
  target_type: '来源 target',
  method: '方法',
  scheme: '协议',
  initiator_type: '发起方',
  body_state: '响应体状态'
}

const MAIN_GROUPS = ['resource_type', 'status', 'host', 'target_type', 'body_state']

export function StatsPanel({ liveTick }: { liveTick: number }): React.JSX.Element {
  const [stats, setStats] = useState<Stats | null>(null)

  useEffect(() => {
    const timer = setTimeout(
      () => {
        void window.monitor.getStats().then(setStats)
      },
      liveTick === 0 ? 0 : 500
    )
    return () => clearTimeout(timer)
  }, [liveTick])

  if (!stats) {
    return <div className="stats empty">正在统计…</div>
  }

  return (
    <div className="stats">
      <div className="cards">
        <Card label="请求总数" value={formatCount(stats.total)} />
        <Card label="传输总量" value={formatSize(stats.bytes)} />
        <Card label="平均耗时" value={formatMs(stats.avgMs)} />
        <Card label="失败" value={formatCount(stats.failed)} tone={stats.failed > 0 ? 'err' : undefined} />
        <Card label="命中缓存" value={formatCount(stats.cached)} />
        <Card label="Service Worker" value={formatCount(stats.sw)} />
        <Card label="有响应体" value={formatCount(stats.withBody)} />
        <Card
          label="body 占用"
          value={`${formatSize(stats.bodies.bytes)} / ${formatSize(stats.bodies.budgetBytes)}`}
        />
        <Card label="数据库体积" value={formatSize(stats.dbBytes)} />
      </div>

      <div className="groups">
        {MAIN_GROUPS.filter((key) => stats.by[key]?.length).map((key) => (
          <Group key={key} title={GROUP_TITLES[key] ?? key} rows={stats.by[key]} total={stats.total} />
        ))}
      </div>
    </div>
  )
}

function Card(props: { label: string; value: string; tone?: string }): React.JSX.Element {
  return (
    <div className="card">
      <span className="card-label">{props.label}</span>
      <b className={props.tone === 'err' ? 'err' : ''}>{props.value}</b>
    </div>
  )
}

function Group(props: {
  title: string
  rows: Stats['by'][string]
  total: number
}): React.JSX.Element {
  const max = Math.max(...props.rows.map((row) => row.c), 1)
  return (
    <div className="group">
      <h4>{props.title}</h4>
      <table className="group-table">
        <tbody>
          {props.rows.slice(0, 14).map((row, index) => (
            <tr key={`${props.title}-${String(row.k)}-${index}`}>
              <td className="mono group-key" title={String(row.k ?? '(空)')}>
                <span className="group-key-inner">
                  <i className="swatch" style={{ background: typeColor(String(row.k)) }} />
                  <span className="group-key-text">{String(row.k ?? '(空)')}</span>
                </span>
              </td>
              <td className="group-bar">
                <div className="bar-track">
                  <div
                    className="bar-fill"
                    style={{ width: `${(row.c / max) * 100}%`, background: typeColor(String(row.k)) }}
                  />
                </div>
              </td>
              <td className="mono group-num">{formatCount(row.c)}</td>
              <td className="mono group-num dim">{formatSize(row.bytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
