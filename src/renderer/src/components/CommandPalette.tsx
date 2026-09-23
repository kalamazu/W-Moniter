import { useEffect, useMemo, useRef, useState } from 'react'

export interface CommandItem {
  id: string
  title: string
  detail: string
  shortcut?: string
  run: () => void
}

interface Props { open: boolean; items: CommandItem[]; onClose: () => void }

/** 不依赖浏览器原生 dialog：Electron 下可以精确控制焦点、Esc 与命令执行后的关闭。 */
export function CommandPalette({ open, items, onClose }: Props): React.JSX.Element | null {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => { if (open) { setQuery(''); window.setTimeout(() => inputRef.current?.focus(), 0) } }, [open])
  const matched = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return needle ? items.filter((item) => `${item.title} ${item.detail}`.toLocaleLowerCase().includes(needle)) : items
  }, [items, query])
  if (!open) return null
  const execute = (item: CommandItem): void => { item.run(); onClose() }
  return <div className="command-scrim" role="presentation" onMouseDown={onClose}>
    <section className="command-palette" role="dialog" aria-modal="true" aria-label="命令面板" onMouseDown={(event) => event.stopPropagation()}>
      <div className="command-input-row"><span aria-hidden="true">⌕</span><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
        if (event.key === 'Enter' && matched[0]) execute(matched[0])
      }} placeholder="搜索命令、视图和设置…" aria-label="搜索命令" /><kbd>Esc</kbd></div>
      <div className="command-results" role="listbox" aria-label="命令结果">
        {matched.map((item) => <button key={item.id} type="button" role="option" className="command-item" onClick={() => execute(item)}>
          <span><b>{item.title}</b><small>{item.detail}</small></span>{item.shortcut && <kbd>{item.shortcut}</kbd>}
        </button>)}
        {matched.length === 0 && <p className="command-empty">没有匹配的命令</p>}
      </div>
    </section>
  </div>
}
