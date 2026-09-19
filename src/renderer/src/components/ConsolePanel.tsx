import { useCallback, useEffect, useRef, useState } from 'react'
import type { CapabilitySet, ConsoleEntry, EvaluateResult } from '../../../shared/types'
import { formatTime } from '../format'

export interface ConsolePanelProps {
  /** 与其它面板同一个心跳，用来兜底刷新能力矩阵 */
  liveTick: number
}

const LEVEL_CLASS: Record<string, string> = {
  error: 'st-err',
  assert: 'st-err',
  warning: 'st-warn',
  warn: 'st-warn',
  info: 'st-info',
  debug: 'st-info',
  verbose: 'dim'
}

function renderValue(result: EvaluateResult): string {
  if (!result.ok) return result.error ?? '执行失败'
  if (result.value === undefined) return result.description ?? 'undefined'
  if (typeof result.value === 'string') return JSON.stringify(result.value)
  try {
    return JSON.stringify(result.value, null, 2)
  } catch {
    return String(result.value)
  }
}

/**
 * 控制台（§7.1 #7）。
 *
 * Runtime.evaluate 只在 Profile L 可用 —— 它正是 §3.4 里那条红线域。
 * 所以这里第一件事是读能力矩阵：H 下整块禁用并说明原因，而不是让人点了等报错。
 *
 * 双向：下面是表达式输入，上面是页面里 console.* / 未捕获异常的回流。
 */
export function ConsolePanel({ liveTick }: ConsolePanelProps): React.JSX.Element {
  const [capability, setCapability] = useState<CapabilitySet | null>(null)
  const [entries, setEntries] = useState<ConsoleEntry[]>([])
  const [expression, setExpression] = useState('')
  const [result, setResult] = useState<EvaluateResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<string[]>([])
  const [historyAt, setHistoryAt] = useState<number | null>(null)
  const [follow, setFollow] = useState(true)

  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void window.monitor.getCapabilities().then(setCapability)
  }, [liveTick])

  useEffect(() => {
    void window.monitor.getConsole().then(setEntries)
    return window.monitor.onConsole((entry) => {
      // 环形缓冲是有上限的，前端也跟着截一下，别让它无限涨
      setEntries((current) => (current.length >= 500 ? [...current.slice(-499), entry] : [...current, entry]))
    })
  }, [])

  useEffect(() => {
    const element = listRef.current
    if (!element || !follow) return
    element.scrollTop = element.scrollHeight
  }, [entries, follow])

  const submit = useCallback(async (): Promise<void> => {
    const source = expression.trim()
    if (!source || busy) return
    setBusy(true)
    setHistory((current) => [source, ...current.filter((item) => item !== source)].slice(0, 50))
    setHistoryAt(null)
    try {
      const next = await window.monitor.evaluate(source)
      setResult(next)
    } finally {
      setBusy(false)
    }
  }, [busy, expression])

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
      return
    }
    // 上下键翻历史，和终端习惯一致
    if (event.key === 'ArrowUp' && history.length > 0) {
      const next = historyAt === null ? 0 : Math.min(history.length - 1, historyAt + 1)
      setHistoryAt(next)
      setExpression(history[next])
      event.preventDefault()
    }
    if (event.key === 'ArrowDown' && historyAt !== null) {
      const next = historyAt - 1
      if (next < 0) {
        setHistoryAt(null)
        setExpression('')
      } else {
        setHistoryAt(next)
        setExpression(history[next])
      }
      event.preventDefault()
    }
  }

  const runtime = capability?.runtime ?? false

  return (
    <div className="console-panel">
      <div className="console-bar">
        <span className={`pill ${runtime ? 'st-ok' : 'st-err'}`}>
          Runtime {runtime ? '可用' : '关闭'}
        </span>
        {capability && <span className="mono dim small">{capability.probe}</span>}
        <span className="spacer" />
        <label className="check">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          跟随最新
        </label>
        <button
          type="button"
          className="btn"
          onClick={() => {
            void window.monitor.clearConsole()
            setEntries([])
          }}
        >
          清空
        </button>
      </div>

      {!runtime && (
        <div className="banner banner-err">
          Profile H 没有 Runtime 域（§3.4 红线），控制台不可用。要读页面里的值就走
          「规则 → 注入脚本」：注入脚本用 <code>document_start</code> 执行，不需要 Runtime。
        </div>
      )}

      <div className="console-list" ref={listRef}>
        {entries.length === 0 && (
          <div className="empty">
            页面里的 console 输出和未捕获异常会出现在这里{runtime ? '' : '（当前 Profile 下不会有）'}
          </div>
        )}
        {entries.map((entry) => (
          <div key={entry.id} className="console-line">
            <span className="c-time mono dim">{formatTime(entry.ts)}</span>
            <span className={`console-level ${LEVEL_CLASS[entry.level] ?? ''}`}>{entry.level}</span>
            <span className="console-text">{entry.text}</span>
            {entry.url && (
              <span className="mono dim small console-src">
                {entry.targetType ? entry.targetType + ' · ' : ''}
                {entry.url.slice(0, 70)}
                {entry.line ? ':' + entry.line : ''}
              </span>
            )}
          </div>
        ))}
      </div>

      {result && (
        <div className={`console-result ${result.ok ? '' : 'st-err'}`}>
          <div className="console-result-head mono dim">
            {result.ok ? `${result.type ?? 'value'} · ${result.durationMs}ms` : `失败 · ${result.durationMs}ms`}
            <button type="button" className="link" onClick={() => setResult(null)}>
              收起
            </button>
          </div>
          <pre className="console-result-body">{renderValue(result)}</pre>
        </div>
      )}

      <div className="console-input">
        <textarea
          className="console-textarea"
          placeholder={runtime ? '表达式，Enter 执行、Shift+Enter 换行；多行按 DevTools 规则包 async IIFE' : 'Profile H 下不可用'}
          value={expression}
          disabled={!runtime}
          spellCheck={false}
          onChange={(e) => setExpression(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="button" className="btn btn-primary" disabled={!runtime || busy} onClick={() => void submit()}>
          {busy ? '执行中…' : '执行'}
        </button>
      </div>
    </div>
  )
}