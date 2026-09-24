import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  CapabilitySet,
  ControllerStatus,
  InputKind,
  InputReport,
  ProbeCheck,
  ProbeReport
} from '../../../shared/types'

export interface EnvPanelProps {
  liveTick: number
}

const STATUS_CLASS: Record<string, string> = {
  pass: 'st-ok',
  warn: 'st-warn',
  fail: 'st-err',
  info: 'st-info'
}

const STATUS_LABEL: Record<string, string> = {
  pass: '通过',
  warn: '注意',
  fail: '失败',
  info: '记录'
}

const FINGERPRINT_ORDER: Array<[string, string]> = [
  ['userAgent', 'UA'],
  ['platform', '平台'],
  ['vendor', '厂商'],
  ['timezone', '时区'],
  ['locale', '区域'],
  ['languages', '语言'],
  ['screen', '屏幕'],
  ['devicePixelRatio', 'DPR'],
  ['hardwareConcurrency', 'CPU 核数'],
  ['deviceMemory', '设备内存'],
  ['webgl', 'WebGL'],
  ['canvasHash', 'Canvas 指纹'],
  ['audioHash', 'Audio 指纹'],
  ['fonts', '已装字体'],
  ['plugins', '插件'],
  ['mediaDevices', '媒体设备'],
  ['userAgentData', 'Client Hints'],
  ['chromeObject', 'window.chrome']
]

function display(value: unknown): string {
  if (value === null) return '—'
  if (value === undefined) return '—'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function short(value: unknown, max = 90): string {
  const text = display(value)
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

/**
 * 环境与指纹（§7.1 #8）。
 *
 * 三块：
 *   1. 环境 —— 这个浏览器到底带着哪些启动参数在跑（每一个参数都是一处特征，§8.1）。
 *   2. 探针 —— §3.6 的检测报告，让 Profile 选择有数据支撑。
 *   3. 输入自动化 —— §6.4 的拟人化轨迹，把「点数/路程/步长/停顿」摊开给人看，
 *      一眼能分出「贝塞尔曲线 + 变速」和「一次跳到位」。
 */
export function EnvPanel({ liveTick }: EnvPanelProps): React.JSX.Element {
  const [capability, setCapability] = useState<CapabilitySet | null>(null)
  const [status, setStatus] = useState<ControllerStatus | null>(null)
  const [viaInject, setViaInject] = useState(false)
  const [probing, setProbing] = useState(false)
  const [probeError, setProbeError] = useState<string | null>(null)
  const [report, setReport] = useState<ProbeReport | null>(null)
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})

  const [inputX, setInputX] = useState('640')
  const [inputY, setInputY] = useState('360')
  const [inputText, setInputText] = useState('monitor')
  const [seed, setSeed] = useState('20260919')
  const [speed, setSpeed] = useState('1')
  const [busyKind, setBusyKind] = useState<InputKind | null>(null)
  const [inputReport, setInputReport] = useState<InputReport | null>(null)
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [network, setNetwork] = useState<{ activeVersion: number; appliedVersion: number | null; pendingRestart: boolean; versions: Array<Record<string, unknown>> } | null>(null)
  const [networkText, setNetworkText] = useState('')
  const [networkResult, setNetworkResult] = useState<string>('')

  useEffect(() => {
    void window.monitor.getCapabilities().then(setCapability)
    void window.monitor.getStatus().then(setStatus)
  }, [liveTick])

  useEffect(() => {
    void window.monitor.getWorkspaces().then(async (result) => {
      const id = result.output?.activeWorkspaceId
      if (!id) return
      setWorkspaceId(id)
      const state = await window.monitor.executeAction({ action: 'environment.get', input: {}, target: { kind: 'workspace', workspaceId: id } })
      if (!state.output) return
      const value = state.output as typeof network
      setNetwork(value)
      const active = value?.versions.find((item) => item['version'] === value.activeVersion)
      if (active) {
        const { version: _version, createdAt: _createdAt, ...editable } = active
        setNetworkText(JSON.stringify(editable, null, 2))
      }
    }).catch(() => undefined)
  }, [liveTick])

  const saveNetwork = useCallback(async (): Promise<void> => {
    if (!workspaceId) return
    try {
      const input = JSON.parse(networkText) as Record<string, unknown>
      const result = await window.monitor.executeAction({ action: 'environment.save', input, target: { kind: 'workspace', workspaceId } })
      if (result.task.error) throw new Error(result.task.error.message)
      const version = (result.output as { version: number }).version
      const refreshed = await window.monitor.executeAction({ action: 'environment.get', input: {}, target: { kind: 'workspace', workspaceId } })
      if (refreshed.output) setNetwork(refreshed.output as typeof network)
      setNetworkResult(`已保存 v${version}；应用后重启浏览器生效`)
    } catch (error) { setNetworkResult(error instanceof Error ? error.message : String(error)) }
  }, [networkText, workspaceId])

  const applyNetwork = useCallback(async (): Promise<void> => {
    if (!workspaceId || !network) return
    const result = await window.monitor.executeAction({ action: 'environment.apply', input: { version: network.activeVersion }, target: { kind: 'workspace', workspaceId } })
    setNetworkResult(result.task.error?.message ?? '配置已冻结，待重启浏览器生效')
  }, [network, workspaceId])

  const diagnoseNetwork = useCallback(async (): Promise<void> => {
    if (!workspaceId) return
    const result = await window.monitor.executeAction({ action: 'environment.diagnose', input: {}, target: { kind: 'workspace', workspaceId } })
    setNetworkResult(result.task.error?.message ?? JSON.stringify(result.output))
  }, [workspaceId])

  const runProbe = useCallback(async (): Promise<void> => {
    setProbing(true)
    setProbeError(null)
    try {
      const result = await window.monitor.runProbe({ viaInject })
      if (result.ok && result.report) {
        setReport(result.report)
        // 有 fail 的组默认展开，其它折叠 —— 报告一屏能看完
        const opened: Record<string, boolean> = {}
        for (const check of result.report.checks) {
          if (check.status === 'fail' || check.status === 'warn') opened[check.group] = true
        }
        setOpenGroups(opened)
      } else {
        setProbeError(result.error ?? '探针失败')
      }
    } finally {
      setProbing(false)
    }
  }, [viaInject])

  const runInput = useCallback(
    async (kind: InputKind): Promise<void> => {
      setBusyKind(kind)
      try {
        const action = {
          kind,
          x: Number(inputX) || 0,
          y: Number(inputY) || 0,
          seed: Number(seed) || undefined,
          speed: Number(speed) || 1,
          ...(kind === 'type' ? { text: inputText } : {}),
          ...(kind === 'scroll' ? { deltaY: 600 } : {})
        }
        setInputReport(await window.monitor.runInput(action))
      } finally {
        setBusyKind(null)
      }
    },
    [inputText, inputX, inputY, seed, speed]
  )

  const grouped = useMemo(() => {
    const map = new Map<string, ProbeCheck[]>()
    for (const check of report?.checks ?? []) {
      const list = map.get(check.group) ?? []
      list.push(check)
      map.set(check.group, list)
    }
    return [...map.entries()]
  }, [report])

  const fingerprintRows = useMemo(() => {
    if (!report) return []
    const source = report.fingerprint as Record<string, unknown>
    const screen = source['screen'] as Record<string, unknown> | null | undefined
    const rows: Array<[string, unknown]> = FINGERPRINT_ORDER.map(([key, label]) => {
      if (key === 'devicePixelRatio' && screen) return [label, screen['devicePixelRatio']]
      return [label, source[key]]
    })
    return rows
  }, [report])

  return (
    <div className="env-panel">
      <section className="group probe-block">
        <h4>网络环境中心 <span className="spacer" />{network ? `v${network.activeVersion}${network.pendingRestart ? ' · 待重启' : ''}` : '读取中'}</h4>
        <div className="rules-note">配置按工作区版本化；认证只能写 secret:// 引用。必经代理失败时不会自动回退直连。</div>
        <textarea className="rules-textarea" rows={10} value={networkText} onChange={(event) => setNetworkText(event.target.value)} spellCheck={false} />
        <div className="rules-actions">
          <button type="button" className="btn" onClick={() => void saveNetwork()}>保存新版本</button>
          <button type="button" className="btn" onClick={() => void diagnoseNetwork()}>DNS / TCP 诊断</button>
          <button type="button" className="btn btn-primary" onClick={() => void applyNetwork()}>应用当前版本</button>
        </div>
        {networkResult ? <div className="mono small break">{networkResult}</div> : null}
      </section>
      <div className="env-cards">
        <div className="card">
          <div className="card-label">Profile</div>
          <b>{capability?.profile ?? '-'}</b>
        </div>
        <div className="card">
          <div className="card-label">Runtime 域</div>
          <b className={capability?.runtime ? 'ok' : 'err'}>
            {capability?.runtime ? '开启' : '关闭'}
          </b>
        </div>
        <div className="card">
          <div className="card-label">探针通道</div>
          <b>{capability?.probeVia ?? '-'}</b>
        </div>
        <div className="card">
          <div className="card-label">内核</div>
          <b>{status?.browserVersion ?? '-'}</b>
        </div>
      </div>

      <div className="env-grid">
        <section className="group">
          <h4>启动参数</h4>
          <div className="rules-note">
            每个参数都是一处可被识别的特征（§8.1）。Profile H 的目标是让这张表尽量接近真实浏览器。
          </div>
          <div className="env-args">
            {(status?.browserArgs ?? []).map((arg) => (
              <code key={arg} className="env-arg">
                {arg}
              </code>
            ))}
            {(status?.browserArgs ?? []).length === 0 && <span className="dim">还没有启动参数</span>}
          </div>
          <div className="mono dim small break">{status?.browserPath ?? '未找到内核'}</div>
          <div className="mono dim small break">{status?.userDataDir ?? '-'}</div>
        </section>

        <section className="group">
          <h4>能力矩阵（§3.2）</h4>
          <div className="env-caps">
            {(
              [
                ['runtime', 'Runtime'],
                ['debugger', 'Debugger'],
                ['emulation', 'Emulation'],
                ['input', '输入自动化'],
                ['captureScripts', '脚本采集']
              ] as const
            ).map(([key, label]) => (
              <span key={key} className={`pill ${capability?.[key] ? 'st-ok' : 'st-err'}`}>
                {label} {capability?.[key] ? '开启' : '关闭'}
              </span>
            ))}
            <span className="pill st-info">DOM {capability?.dom ?? '-'}</span>
          </div>
          <div className="rules-note">
            H 下缺失的能力不是 bug，是设计：断点/求值/指纹伪装都会留下检测面，只能换成注入 + 规则。
          </div>
        </section>
      </div>

      <section className="group probe-block">
        <h4>
          检测探针
          <span className="spacer" />
          <label className="check">
            <input
              type="checkbox"
              checked={viaInject}
              onChange={(event) => setViaInject(event.target.checked)}
            />
            强制走注入 + 信标回传
          </label>
          <button
            type="button"
            className="btn btn-primary probe-run"
            disabled={probing}
            onClick={() => void runProbe()}
          >
            {probing ? '探针运行中…' : '运行探针'}
          </button>
        </h4>

        {probeError && <div className="banner banner-err">{probeError}</div>}

        {!report && !probeError && (
          <div className="empty">
            还没有报告。探针会在受控页面上跑一组自检：CDP 痕迹、自动化标记、指纹一致性、运行环境。
            {capability?.probeVia === 'inject' && '　当前 Profile 会先注入脚本再刷新页面，报告经信标回传。'}
          </div>
        )}

        {report && (
          <div className="probe-report">
            <div className="probe-head">
              <span
                className={`pill ${report.recommend === 'L' ? 'st-ok' : 'st-warn'} probe-recommend`}
              >
                建议 Profile {report.recommend}
              </span>
              <span className="probe-summary mono small">
                <span className="st-ok" data-pass={report.summary.pass}>通过 {report.summary.pass}</span>
                {' · '}
                <span className="st-warn">注意 {report.summary.warn}</span>
                {' · '}
                <span className="st-err">失败 {report.summary.fail}</span>
                {' · '}
                <span className="dim">记录 {report.summary.info}</span>
              </span>
              <span className="spacer" />
              <span className="mono dim small">
                {report.profile ?? '-'} · {report.durationMs}ms · {short(report.url, 60)}
              </span>
            </div>
            <div className="probe-reason">{report.reason}</div>

            <div className="probe-groups">
              {grouped.map(([group, checks]) => {
                const fails = checks.filter((check) => check.status === 'fail').length
                const warns = checks.filter((check) => check.status === 'warn').length
                const open = openGroups[group] ?? fails + warns > 0
                return (
                  <div key={group} className="probe-group">
                    <button
                      type="button"
                      className="probe-group-head"
                      onClick={() => setOpenGroups((current) => ({ ...current, [group]: !open }))}
                    >
                      <span>{open ? '▾' : '▸'}</span>
                      <b>{group}</b>
                      <span className="dim small">
                        {checks.length} 项
                        {fails > 0 ? ` · ${fails} 失败` : ''}
                        {warns > 0 ? ` · ${warns} 注意` : ''}
                      </span>
                    </button>
                    {open && (
                      <table className="probe-table">
                        <tbody>
                          {checks.map((check) => (
                            <tr key={check.id} className={STATUS_CLASS[check.status] ?? ''}>
                              <td className="probe-status">{STATUS_LABEL[check.status] ?? check.status}</td>
                              <td className="probe-label">{check.label}</td>
                              <td className="mono small">{short(check.value, 58)}</td>
                              <td className="dim small">{check.detail}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )
              })}
            </div>

            <details className="probe-fingerprint">
              <summary>指纹明细（{report.fingerprint ? Object.keys(report.fingerprint).length : 0} 项）</summary>
              <table className="probe-table">
                <tbody>
                  {fingerprintRows.map(([label, value]) => (
                    <tr key={label}>
                      <td className="probe-label">{label}</td>
                      <td className="mono small break">{short(value, 160)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </div>
        )}
      </section>

      <section className="group">
        <h4>拟人化输入（§6.4）</h4>
        <div className="rules-note">
          CDP 的输入是「瞬间跳到目标点」，真人是贝塞尔曲线 + 变速 + 停顿 + 微抖动。
          同一个 seed 会复现同一条轨迹，验收才有意义。
        </div>
        <div className="field-row">
          <label className="field field-narrow">
            <span>x</span>
            <input value={inputX} onChange={(e) => setInputX(e.target.value)} />
          </label>
          <label className="field field-narrow">
            <span>y</span>
            <input value={inputY} onChange={(e) => setInputY(e.target.value)} />
          </label>
          <label className="field field-narrow">
            <span>seed</span>
            <input value={seed} onChange={(e) => setSeed(e.target.value)} />
          </label>
          <label className="field field-narrow">
            <span>速度</span>
            <input value={speed} onChange={(e) => setSpeed(e.target.value)} />
          </label>
          <label className="field">
            <span>文本</span>
            <input value={inputText} onChange={(e) => setInputText(e.target.value)} />
          </label>
        </div>
        <div className="rules-actions">
          {(['move', 'click', 'type', 'scroll'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              className={`btn input-run input-run-${kind}`}
              disabled={busyKind !== null}
              onClick={() => void runInput(kind)}
            >
              {busyKind === kind
                ? '执行中…'
                : { move: '移动', click: '单击', type: '输入文本', scroll: '滚动' }[kind]}
            </button>
          ))}
        </div>

        {inputReport && (
          <div className={`input-report ${inputReport.ok ? '' : 'st-err'}`}>
            {inputReport.ok ? (
              <div className="rules-stats">
                <span>
                  <b>{inputReport.points}</b> 轨迹点
                </span>
                <span>
                  <b>{inputReport.durationMs}</b> ms
                </span>
                <span>
                  <b>{inputReport.pathLength}</b> px 路程 / 直线 {inputReport.straight} px
                </span>
                <span>
                  步长 <b>{inputReport.maxStep}</b> px 上限
                </span>
                <span>
                  单步 <b>{inputReport.minStepMs}</b>~<b>{inputReport.maxStepMs}</b> ms
                </span>
                <span>
                  <b>{inputReport.pauses}</b> 次停顿
                </span>
                {inputReport.keys !== undefined && (
                  <span>
                    <b>{inputReport.keys}</b> 键
                  </span>
                )}
                {inputReport.scrollTicks !== undefined && (
                  <span>
                    <b>{inputReport.scrollTicks}</b> 次滚轮
                  </span>
                )}
                {inputReport.landed && (
                  <span className="mono dim">
                    落点 {inputReport.landed.x}, {inputReport.landed.y}
                  </span>
                )}
              </div>
            ) : (
              <div>{inputReport.error ?? '执行失败'}</div>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
