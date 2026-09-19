import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  Injection,
  Rule,
  RuleAction,
  RuleActionKind,
  RuleSet,
  RuleStats
} from '../../../shared/types'

const ACTION_LABELS: Record<RuleActionKind, string> = {
  block: '拦截（连接失败）',
  redirect: '跳转到别的 URL',
  delay: '延迟放行',
  rewriteHeaders: '改写头部',
  rewriteBody: '改写响应体（脚本）',
  fulfill: '伪造响应',
  mock: '用 fixture 伪造'
}

const REQUEST_ACTIONS: RuleActionKind[] = [
  'block',
  'redirect',
  'delay',
  'rewriteHeaders',
  'fulfill',
  'mock'
]
const RESPONSE_ACTIONS: RuleActionKind[] = ['rewriteHeaders', 'rewriteBody', 'fulfill', 'mock']

const DEFAULT_ACTION: Record<RuleActionKind, () => RuleAction> = {
  block: () => ({ kind: 'block' }),
  redirect: () => ({ kind: 'redirect', to: '' }),
  delay: () => ({ kind: 'delay', ms: 1000 }),
  rewriteHeaders: () => ({ kind: 'rewriteHeaders', set: {}, remove: [] }),
  rewriteBody: () => ({ kind: 'rewriteBody', script: 'return body' }),
  fulfill: () => ({ kind: 'fulfill', status: 200, body: '' }),
  mock: () => ({ kind: 'mock', fixture: '' })
}

const EMPTY: RuleSet = { version: 1, rules: [], fixtures: {}, injections: [] }

const uid = (prefix: string): string => prefix + Math.random().toString(36).slice(2, 8)

function blankRule(): Rule {
  return {
    id: uid('r-'),
    name: '新规则',
    enabled: true,
    priority: 0,
    match: { urlPattern: '*' },
    stage: 'request',
    action: { kind: 'block' }
  }
}

function blankInjection(): Injection {
  return {
    id: uid('i-'),
    name: '新注入',
    enabled: true,
    urlPattern: '',
    code: 'console.log("[monitor] injected")',
    runAt: 'document_start'
  }
}

const listToText = (values?: string[]): string => (values ?? []).join(', ')

function textToList(text: string): string[] | undefined {
  const out = text
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  return out.length ? out : undefined
}

const headersToText = (set?: Record<string, string>): string =>
  Object.entries(set ?? {})
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')

function textToHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return out
}

export function RulePanel({ liveTick }: { liveTick: number }): React.JSX.Element {
  const [set, setSet] = useState<RuleSet>(EMPTY)
  const [stats, setStats] = useState<RuleStats | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [note, setNote] = useState('')

  useEffect(() => {
    let alive = true
    void window.monitor.getRules().then((rules) => {
      if (!alive) return
      setSet(rules ?? EMPTY)
      setSelectedId((rules?.rules[0]?.id ?? null) as string | null)
      setLoaded(true)
    })
    const off = window.monitor.onRules((rules) => {
      setSet(rules)
      setDirty(false)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(
      () => {
        void window.monitor.getRuleStats().then(setStats)
      },
      liveTick === 0 ? 0 : 400
    )
    return () => clearTimeout(timer)
  }, [liveTick])

  const selected = useMemo(
    () => set.rules.find((rule) => rule.id === selectedId) ?? null,
    [set.rules, selectedId]
  )

  const mutate = useCallback((update: (draft: RuleSet) => RuleSet) => {
    setSet((current) => update(current))
    setDirty(true)
    setNote('')
  }, [])

  const patchRule = useCallback(
    (id: string, patch: Partial<Rule>) =>
      mutate((draft) => ({
        ...draft,
        rules: draft.rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule))
      })),
    [mutate]
  )

  const save = useCallback(async () => {
    const result = await window.monitor.saveRules(set)
    if (result.ok) {
      const problems = result.invalid ?? []
      setNote(problems.length ? `已保存；${problems.length} 条规则被丢弃` : '已保存并生效')
      setDirty(false)
    } else {
      setNote(`保存失败：${result.error ?? '未知错误'}`)
    }
  }, [set])

  if (!loaded) return <div className="stats empty">正在读取规则…</div>

  const problems = stats?.invalid ?? []
  const rate = stats && stats.matched > 0 ? (stats.applied / stats.matched) * 100 : 100

  return (
    <div className="rules">
      <div className="rules-bar">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void save()}
          disabled={!dirty}
        >
          保存并生效
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            const rule = blankRule()
            mutate((draft) => ({ ...draft, rules: [...draft.rules, rule] }))
            setSelectedId(rule.id)
          }}
        >
          + 规则
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            const injection = blankInjection()
            mutate((draft) => ({ ...draft, injections: [...draft.injections, injection] }))
          }}
        >
          + 注入脚本
        </button>
        <button
          type="button"
          className="btn"
          disabled={!dirty}
          onClick={() => {
            void window.monitor.getRules().then((rules) => {
              setSet(rules ?? EMPTY)
              setDirty(false)
              setNote('已放弃未保存的改动')
            })
          }}
        >
          放弃改动
        </button>
        <span className={dirty ? 'rules-note warn' : 'rules-note dim'}>
          {dirty ? '有未保存的改动' : note || '已同步'}
        </span>
      </div>

      {stats && (
        <div className="rules-stats">
          <span>
            生效规则 <b>{stats.total}</b>
          </span>
          <span>
            命中 <b>{stats.matched}</b>
          </span>
          <span>
            生效 <b className="ok">{stats.applied}</b>
          </span>
          <span>
            失败 <b className={stats.failed ? 'err' : ''}>{stats.failed}</b>
          </span>
          <span>
            成功率 <b className={rate >= 99 ? 'ok' : 'warn'}>{rate.toFixed(1)}%</b>
          </span>
          <span className="dim">
            平均匹配 {stats.avgMatchUs.toFixed(1)}µs / 最大 {stats.maxMatchUs.toFixed(0)}µs
          </span>
          <span className="dim">
            拦截 {stats.blocked} · 跳转 {stats.redirected} · 延时 {stats.delayed} · 头{' '}
            {stats.headersRewritten} · body {stats.bodiesRewritten}
          </span>
          <span className="dim">注入 {stats.injections} 段</span>
        </div>
      )}

      {problems.length > 0 && (
        <div className="rules-problems">
          {problems.map((problem) => (
            <div key={problem.ruleId} className="err">
              丢弃「{problem.ruleName}」：{problem.message}
            </div>
          ))}
        </div>
      )}

      <div className="rules-split">
        <div className="rules-list">
          {set.rules.length === 0 && <div className="dim pad">还没有规则</div>}
          {set.rules.map((rule) => (
            <button
              key={rule.id}
              type="button"
              className={`rule-row${rule.id === selectedId ? ' rule-row-active' : ''}`}
              onClick={() => setSelectedId(rule.id)}
            >
              <input
                type="checkbox"
                checked={rule.enabled}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => patchRule(rule.id, { enabled: event.target.checked })}
              />
              <span className="rule-name">{rule.name}</span>
              <span className="chip chip-xs">{rule.stage === 'request' ? '请求' : '响应'}</span>
              <span className="chip chip-xs">{ACTION_LABELS[rule.action.kind]}</span>
              <span className="dim small">P{rule.priority}</span>
            </button>
          ))}
        </div>

        <div className="rules-editor">
          {!selected && <div className="dim pad">左边选一条规则</div>}
          {selected && (
            <>
              <div className="field-row">
                <label className="field">
                  <span>名称</span>
                  <input
                    value={selected.name}
                    onChange={(event) => patchRule(selected.id, { name: event.target.value })}
                  />
                </label>
                <label className="field field-narrow">
                  <span>优先级</span>
                  <input
                    type="number"
                    value={selected.priority}
                    onChange={(event) =>
                      patchRule(selected.id, { priority: Number(event.target.value) || 0 })
                    }
                  />
                </label>
                <label className="field field-narrow">
                  <span>阶段</span>
                  <select
                    value={selected.stage}
                    onChange={(event) => {
                      const stage = event.target.value === 'response' ? 'response' : 'request'
                      const allowed = stage === 'request' ? REQUEST_ACTIONS : RESPONSE_ACTIONS
                      patchRule(selected.id, {
                        stage,
                        action: allowed.includes(selected.action.kind)
                          ? selected.action
                          : DEFAULT_ACTION[allowed[0]]()
                      })
                    }}
                  >
                    <option value="request">请求</option>
                    <option value="response">响应</option>
                  </select>
                </label>
              </div>

              <label className="field">
                <span>URL 匹配</span>
                <input
                  className="mono"
                  value={selected.match.urlPattern}
                  onChange={(event) =>
                    patchRule(selected.id, {
                      match: { ...selected.match, urlPattern: event.target.value }
                    })
                  }
                />
                <em className="dim small">
                  `*` 跨 `/` 通配、`?` 单字符；写 `re:` 前缀则整串按正则
                </em>
              </label>

              <div className="field-row">
                <label className="field">
                  <span>方法（逗号分隔）</span>
                  <input
                    value={listToText(selected.match.method)}
                    onChange={(event) =>
                      patchRule(selected.id, {
                        match: { ...selected.match, method: textToList(event.target.value) }
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>资源类型</span>
                  <input
                    value={listToText(selected.match.resourceType)}
                    onChange={(event) =>
                      patchRule(selected.id, {
                        match: { ...selected.match, resourceType: textToList(event.target.value) }
                      })
                    }
                  />
                </label>
                <label className="field field-narrow">
                  <span>状态码</span>
                  <input
                    value={listToText(selected.match.statusCode?.map(String))}
                    onChange={(event) =>
                      patchRule(selected.id, {
                        match: {
                          ...selected.match,
                          statusCode: textToList(event.target.value)?.map(Number)
                        }
                      })
                    }
                  />
                </label>
              </div>

              <div className="field-row">
                <label className="field">
                  <span>发起页面（glob，可空）</span>
                  <input
                    value={selected.match.frameUrl ?? ''}
                    onChange={(event) =>
                      patchRule(selected.id, {
                        match: { ...selected.match, frameUrl: event.target.value || undefined }
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>target 类型</span>
                  <input
                    value={listToText(selected.match.targetType)}
                    onChange={(event) =>
                      patchRule(selected.id, {
                        match: { ...selected.match, targetType: textToList(event.target.value) }
                      })
                    }
                  />
                </label>
              </div>

              <label className="field">
                <span>动作</span>
                <select
                  value={selected.action.kind}
                  onChange={(event) => {
                    const kind = event.target.value as RuleActionKind
                    patchRule(selected.id, { action: DEFAULT_ACTION[kind]() })
                  }}
                >
                  {(selected.stage === 'request' ? REQUEST_ACTIONS : RESPONSE_ACTIONS).map((kind) => (
                    <option key={kind} value={kind}>
                      {ACTION_LABELS[kind]}
                    </option>
                  ))}
                </select>
              </label>

              {selected.action.kind === 'redirect' && (
                <label className="field">
                  <span>跳到</span>
                  <input
                    className="mono"
                    value={selected.action.to}
                    onChange={(event) =>
                      patchRule(selected.id, { action: { kind: 'redirect', to: event.target.value } })
                    }
                  />
                  <em className="dim small">可用 $URL / $HOST 占位</em>
                </label>
              )}

              {selected.action.kind === 'delay' && (
                <label className="field field-narrow">
                  <span>延迟毫秒（上限 30000）</span>
                  <input
                    type="number"
                    value={selected.action.ms}
                    onChange={(event) =>
                      patchRule(selected.id, {
                        action: { kind: 'delay', ms: Number(event.target.value) || 0 }
                      })
                    }
                  />
                </label>
              )}

              {selected.action.kind === 'rewriteHeaders' && (
                <>
                  <label className="field">
                    <span>设置（每行 name: value）</span>
                    <textarea
                      className="mono"
                      rows={3}
                      value={headersToText(selected.action.set)}
                      onChange={(event) =>
                        patchRule(selected.id, {
                          action: {
                            kind: 'rewriteHeaders',
                            set: textToHeaders(event.target.value),
                            remove: selected.action.kind === 'rewriteHeaders' ? selected.action.remove : []
                          }
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>删除（每行一个名字）</span>
                    <textarea
                      className="mono"
                      rows={2}
                      value={(selected.action.remove ?? []).join('\n')}
                      onChange={(event) =>
                        patchRule(selected.id, {
                          action: {
                            kind: 'rewriteHeaders',
                            set: selected.action.kind === 'rewriteHeaders' ? selected.action.set : {},
                            remove: event.target.value
                              .split('\n')
                              .map((line) => line.trim())
                              .filter(Boolean)
                          }
                        })
                      }
                    />
                  </label>
                </>
              )}

              {selected.action.kind === 'rewriteBody' && (
                <label className="field">
                  <span>脚本（函数体，返回新 body；拿不到字符串=不改）</span>
                  <textarea
                    className="mono code"
                    rows={10}
                    value={selected.action.script}
                    onChange={(event) =>
                      patchRule(selected.id, {
                        action: { kind: 'rewriteBody', script: event.target.value }
                      })
                    }
                  />
                  <em className="dim small">可用 ctx.url / ctx.status / ctx.headers</em>
                </label>
              )}

              {(selected.action.kind === 'fulfill' || selected.action.kind === 'mock') && (
                <>
                  {selected.action.kind === 'mock' && (
                    <label className="field">
                      <span>fixture 名字</span>
                      <input
                        className="mono"
                        value={selected.action.fixture}
                        onChange={(event) =>
                          patchRule(selected.id, { action: { kind: 'mock', fixture: event.target.value } })
                        }
                      />
                    </label>
                  )}
                  {selected.action.kind === 'fulfill' && (
                    <label className="field field-narrow">
                      <span>状态码</span>
                      <input
                        type="number"
                        value={selected.action.status}
                        onChange={(event) =>
                          patchRule(selected.id, {
                            action: {
                              kind: 'fulfill',
                              status: Number(event.target.value) || 200,
                              body: selected.action.kind === 'fulfill' ? selected.action.body : ''
                            }
                          })
                        }
                      />
                    </label>
                  )}
                  {selected.action.kind === 'fulfill' && (
                    <label className="field">
                      <span>响应体</span>
                      <textarea
                        className="mono"
                        rows={6}
                        value={selected.action.body}
                        onChange={(event) =>
                          patchRule(selected.id, {
                            action: { kind: 'fulfill', status: selected.action.kind === 'fulfill' ? selected.action.status : 200, body: event.target.value }
                          })
                        }
                      />
                    </label>
                  )}
                </>
              )}

              <div className="rules-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    const copy = { ...selected, id: uid('r-'), name: selected.name + ' 副本' }
                    mutate((draft) => ({ ...draft, rules: [...draft.rules, copy] }))
                    setSelectedId(copy.id)
                  }}
                >
                  复制
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => {
                    mutate((draft) => ({
                      ...draft,
                      rules: draft.rules.filter((rule) => rule.id !== selected.id)
                    }))
                    setSelectedId(null)
                  }}
                >
                  删除
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="rules-inject">
        <h3>注入脚本</h3>
        <p className="dim small">
          document_start 走 addScriptToEvaluateOnNewDocument（Profile H 也能用）；document_ready
          需要 Runtime，Profile H 下只登记不执行。
        </p>
        {set.injections.map((injection) => (
          <div key={injection.id} className="inject-card">
            <div className="field-row">
              <input
                type="checkbox"
                checked={injection.enabled}
                onChange={(event) =>
                  mutate((draft) => ({
                    ...draft,
                    injections: draft.injections.map((item) =>
                      item.id === injection.id ? { ...item, enabled: event.target.checked } : item
                    )
                  }))
                }
              />
              <label className="field">
                <span>名称</span>
                <input
                  value={injection.name}
                  onChange={(event) =>
                    mutate((draft) => ({
                      ...draft,
                      injections: draft.injections.map((item) =>
                        item.id === injection.id ? { ...item, name: event.target.value } : item
                      )
                    }))
                  }
                />
              </label>
              <label className="field">
                <span>URL 匹配（空=所有文档）</span>
                <input
                  className="mono"
                  value={injection.urlPattern}
                  onChange={(event) =>
                    mutate((draft) => ({
                      ...draft,
                      injections: draft.injections.map((item) =>
                        item.id === injection.id ? { ...item, urlPattern: event.target.value } : item
                      )
                    }))
                  }
                />
              </label>
              <label className="field field-narrow">
                <span>时机</span>
                <select
                  value={injection.runAt}
                  onChange={(event) =>
                    mutate((draft) => ({
                      ...draft,
                      injections: draft.injections.map((item) =>
                        item.id === injection.id
                          ? {
                              ...item,
                              runAt: event.target.value === 'document_ready' ? 'document_ready' : 'document_start'
                            }
                          : item
                      )
                    }))
                  }
                >
                  <option value="document_start">document_start</option>
                  <option value="document_ready">document_ready</option>
                </select>
              </label>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() =>
                  mutate((draft) => ({
                    ...draft,
                    injections: draft.injections.filter((item) => item.id !== injection.id)
                  }))
                }
              >
                删除
              </button>
            </div>
            <textarea
              className="mono code"
              rows={5}
              value={injection.code}
              onChange={(event) =>
                mutate((draft) => ({
                  ...draft,
                  injections: draft.injections.map((item) =>
                    item.id === injection.id ? { ...item, code: event.target.value } : item
                  )
                }))
              }
            />
          </div>
        ))}
        {set.injections.length === 0 && <div className="dim pad">还没有注入脚本</div>}
      </div>

      {stats && stats.recent.length > 0 && (
        <div className="rules-recent">
          <h3>最近命中</h3>
          {stats.recent.slice(0, 8).map((hit, index) => (
            <div key={`${hit.ts}-${index}`} className="recent-row">
              <span className={hit.ok ? 'chip chip-xs' : 'chip chip-xs err'}>{hit.ok ? '生效' : '失败'}</span>
              <span className="rule-name">{hit.ruleName}</span>
              <span className="dim small">{hit.kind}</span>
              <span className="mono small ellipsis">{hit.url || '-'}</span>
              <span className="dim small">{hit.durationMs}ms</span>
              {hit.detail && <span className="err small">{hit.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}