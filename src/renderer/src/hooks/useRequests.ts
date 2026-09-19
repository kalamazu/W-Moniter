import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RequestQuery, StoredRequest } from '../../../shared/types'

const PAGE_SIZE = 500
/** 实时流量到达后多久去库里捞一次新数据 */
const LIVE_DEBOUNCE_MS = 400

export interface RequestsState {
  rows: StoredRequest[]
  total: number
  loading: boolean
  hasMore: boolean
  error: string | null
  /** 列表不在顶部时攒下的新请求条数 */
  pendingNew: number
  loadMore(): void
  refresh(): void
  /** 表格告诉我们它在不在顶部，决定要不要自动刷新 */
  notifyScrollTop(atTop: boolean): void
}

/**
 * 列表数据来自数据库，不是内存里的流水账。
 *
 * 这样筛选/排序/翻页都只有一条代码路径，而且滚回去看历史时数据是准的。
 * 实时性靠「有新请求 + 停在顶部」时防抖重查第一页来保证 ——
 * 和 DevTools 的「N 条新请求」是一个思路，不在顶部就不打扰用户。
 */
export function useRequests(query: RequestQuery, enabled: boolean, liveTick: number): RequestsState {
  const [rows, setRows] = useState<StoredRequest[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingNew, setPendingNew] = useState(0)

  // 查询条件变了要重新数一遍，序列化成 key 最省心
  const queryKey = useMemo(() => JSON.stringify(query), [query])

  const nonceRef = useRef(0)
  const atTopRef = useRef(true)
  const rowsLenRef = useRef(0)
  rowsLenRef.current = rows.length
  const loadingRef = useRef(false)
  loadingRef.current = loading

  const run = useCallback(
    async (mode: 'reset' | 'more', offset: number) => {
      if (!enabled) return
      const nonce = ++nonceRef.current
      setLoading(true)
      try {
        const page = await window.monitor.queryRequests(query, PAGE_SIZE, offset, 'time_desc')
        // 期间条件又变了或者又发起了一次查询，这次结果作废
        if (nonce !== nonceRef.current) return
        if (!page) {
          setError('存储不可用，列表数据取不到')
          return
        }
        setError(null)
        setTotal(page.total)
        setRows((previous) => (mode === 'reset' ? page.rows : previous.concat(page.rows)))
        if (mode === 'reset') setPendingNew(0)
      } catch (err) {
        if (nonce === nonceRef.current) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (nonce === nonceRef.current) setLoading(false)
      }
    },
    [enabled, query]
  )

  // 条件变化 / 首次进入：重置并查第一页
  useEffect(() => {
    setRows([])
    setTotal(0)
    setPendingNew(0)
    if (!enabled) return
    void run('reset', 0)
    // queryKey 覆盖了 query 的内容，run 已随之更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, enabled])

  // 实时刷新：只在停在顶部时做，否则只累计提示
  const lastTickRef = useRef(liveTick)
  useEffect(() => {
    if (liveTick === lastTickRef.current) return
    lastTickRef.current = liveTick
    if (!enabled) return
    if (!atTopRef.current) {
      setPendingNew((value) => value + 1)
      return
    }
    const timer = setTimeout(() => {
      void run('reset', 0)
    }, LIVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTick, enabled])

  const loadMore = useCallback(() => {
    if (loadingRef.current) return
    if (rowsLenRef.current >= total) return
    void run('more', rowsLenRef.current)
  }, [run, total])

  const refresh = useCallback(() => {
    // 刷新时把已加载的窗口一起补上，不然用户滚到 2000 条处会突然只剩 500 条
    void run('reset', 0)
  }, [run])

  const notifyScrollTop = useCallback((atTop: boolean) => {
    atTopRef.current = atTop
  }, [])

  return {
    rows,
    total,
    loading,
    hasMore: rows.length < total,
    error,
    pendingNew,
    loadMore,
    refresh,
    notifyScrollTop
  }
}
