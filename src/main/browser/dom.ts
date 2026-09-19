import type { CdpClient } from './cdp'
import type {
  DomBoxModel,
  DomEventListener,
  DomInspectResult,
  DomMatchedRule,
  DomTreeRow
} from '../../shared/types'

/** DOM.getDocument / DOM.describeNode 返回的节点，只列我们真用到的字段 */
interface RawNode {
  nodeId: number
  backendNodeId?: number
  parentId?: number
  nodeType: number
  nodeName: string
  nodeValue?: string
  attributes?: string[]
  childNodeCount?: number
  children?: RawNode[]
}

interface RawCssProperty {
  name: string
  value: string
  disabled?: boolean
  implicit?: boolean
}

interface RawCssRule {
  /** 实测里会混进没有 style / selectorList 的规则，取字段前一律要挡 */
  rule?: {
    selectorList?: { text: string }
    origin?: string
    style?: { cssProperties?: RawCssProperty[] }
  }
}

/** 这些标签不会有子节点，别给用户画一个永远展不开的箭头 */
const VOID_TAGS = new Set([
  'AREA',
  'BASE',
  'BR',
  'COL',
  'EMBED',
  'HR',
  'IMG',
  'INPUT',
  'LINK',
  'META',
  'PARAM',
  'SOURCE',
  'TRACK',
  'WBR'
])

function pairs(list: string[] | undefined): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (let i = 0; list && i + 1 < list.length; i += 2) {
    out.push([list[i] as string, list[i + 1] as string])
  }
  return out
}

/** nodeId 作废的几种说法（页面刷新、重新取过文档、节点被删） */
function isStaleNode(error: unknown): boolean {
  const text = msgOf(error)
  return /Could not find node with given id|No node with given id|Invalid node|Node is detached|Cannot find context/i.test(
    text
  )
}

function msgOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + '…(' + (text.length - max) + ' 字省略)'
}

/**
 * §7.1 #3「DOM 与元素检查」的浏览器侧实现。
 *
 * 按需启用（§3.4）：DOM / CSS 在 Profile H 下标的是「⚠️ 按需」，L 下也没有理由开局就开 ——
 * 这里一律「第一次真要用才 enable」，并把启用过的 domain 报回给 UI 当证据。
 * 树是懒展开的：只有被展开过的节点才去取子树，页面上万个节点也不会一次拖回来。
 */
export class DomInspector {
  /** 每个会话已经启用过哪些 domain */
  private readonly enabled = new Map<string, Set<string>>()
  /** 已被展开过的节点 */
  private readonly expanded = new Set<number>()
  /** nodeId → 它在文档里的路径，展开子树时要用它拼子节点的路径 */
  private readonly pathByNodeId = new Map<number, string>()
  /**
   * 会话 → 文档根 nodeId。
   * DOM.getDocument 会让先前发出的 nodeId 全部作废，所以一个会话只取一次根，
   * 之后一律在这根上用 describeNode / querySelector —— 否则面板里刚点开的节点
   * 下一次点击就报「找不到节点」。
   */
  private readonly rootId = new Map<string, number>()

  constructor(private readonly cdp: CdpClient) {}

  enabledDomains(sessionId: string): string[] {
    return [...(this.enabled.get(sessionId) ?? [])]
  }

  clear(): void {
    this.enabled.clear()
    this.forgetNodes()
  }

  /**
   * 页面换过文档（刷新/跳转）后 nodeId 全废 —— 丢掉缓存的根与路径，下次调用重取。
   * domain 的启用状态不动：它是会话级的，跨导航依然有效。
   */
  forgetNodes(): void {
    this.rootId.clear()
    this.expanded.clear()
    this.pathByNodeId.clear()
  }

  /** 取（或重取）文档根 */
  private async documentRoot(sessionId: string, refresh = false): Promise<number> {
    if (refresh) this.rootId.delete(sessionId)
    const cached = this.rootId.get(sessionId)
    if (cached !== undefined) return cached
    const doc = (await this.cdp.send(
      'DOM.getDocument',
      { depth: 0, pierce: false },
      sessionId
    )) as { root: RawNode }
    this.rootId.set(sessionId, doc.root.nodeId)
    return doc.root.nodeId
  }

  /** 撞上「节点失效」就重取一次文档根再试一遍；其它错误原样抛出 */
  private async retryOnStale<T>(
    sessionId: string,
    run: (refresh: boolean) => Promise<T>
  ): Promise<T> {
    try {
      return await run(false)
    } catch (error) {
      if (!isStaleNode(error)) throw error
      this.forgetNodes()
      return await run(true)
    }
  }

  private async ensure(sessionId: string, domains: string[]): Promise<string[]> {
    let have = this.enabled.get(sessionId)
    if (!have) {
      have = new Set<string>()
      this.enabled.set(sessionId, have)
    }
    const fresh: string[] = []
    for (const domain of domains) {
      if (have.has(domain)) continue
      await this.cdp.send(domain + '.enable', {}, sessionId)
      have.add(domain)
      fresh.push(domain)
    }
    return fresh
  }

  /** 文档根（不给 nodeId），或某个节点的子树（给了 nodeId）。depth 只决定这一次取多深 */
  async tree(
    sessionId: string,
    nodeId?: number,
    depth = 2
  ): Promise<{ rows: DomTreeRow[]; fresh: string[] }> {
    const fresh = await this.ensure(sessionId, ['DOM'])
    const rows: DomTreeRow[] = []

    if (nodeId === undefined) {
      // 根只在缓存缺失时取一次（getDocument 会让先前发出的 nodeId 全废，
      // 面板和截图脚本可能同时在用同一批编号）。拿到根之后一律 describeNode + pushIds：
      // 不改变已有编号，别人手里的 id 也就不会突然失效。
      await this.retryOnStale(sessionId, async (refresh) => {
        rows.length = 0
        const rootId = await this.documentRoot(sessionId, refresh)
        const described = (await this.cdp.send(
          'DOM.describeNode',
          { nodeId: rootId, depth },
          sessionId
        )) as { node: RawNode }
        await this.pushIds(sessionId, described.node)
        this.walk(described.node, 0, '', rows)
      })
      return { rows, fresh }
    }

    const described = (await this.cdp.send(
      'DOM.describeNode',
      { nodeId, depth },
      sessionId
    )) as { node: RawNode }
    await this.pushIds(sessionId, described.node)
    const known = this.pathByNodeId.get(nodeId) ?? ''
    const base = this.toRow(described.node, 0, this.parentOf(known))
    rows.push(base)
    this.pathByNodeId.set(base.nodeId, base.path)
    this.expanded.add(nodeId)
    for (const child of described.node.children ?? []) this.walk(child, 1, base.path, rows)
    return { rows, fresh }
  }

  /** 'html > body > div#app' → 'html > body' */
  private parentOf(path: string): string {
    const parts = path.split(' > ')
    parts.pop()
    return parts.join(' > ')
  }

  /**
   * describeNode 只把「被描述的那一个」推进前端的节点表，子节点的 nodeId 是 0、
   * 只有 backendNodeId 是真的。要画整棵子树就得拿 backendNodeId 换回前端编号。
   */
  private async pushIds(sessionId: string, node: RawNode): Promise<void> {
    const pending: RawNode[] = []
    const collect = (item: RawNode): void => {
      if (!item.nodeId && item.backendNodeId) pending.push(item)
      for (const child of item.children ?? []) collect(child)
    }
    collect(node)
    if (!pending.length) return

    const answer = (await this.cdp.send(
      'DOM.pushNodesByBackendIdsToFrontend',
      { backendNodeIds: pending.map((item) => item.backendNodeId) },
      sessionId
    )) as { nodeIds: number[] }
    const byBackend = new Map<number, number>()
    pending.forEach((item, index) => {
      const id = answer.nodeIds?.[index]
      if (id) byBackend.set(item.backendNodeId as number, id)
    })
    const fill = (item: RawNode): void => {
      if (!item.nodeId && item.backendNodeId) item.nodeId = byBackend.get(item.backendNodeId) ?? 0
      for (const child of item.children ?? []) fill(child)
    }
    fill(node)
  }

  private walk(node: RawNode, depth: number, parentPath: string, rows: DomTreeRow[]): void {
    // 换不到前端编号的节点点了也没用，别画出来让用户白点
    if (!node.nodeId) return
    const row = this.toRow(node, depth, parentPath)
    rows.push(row)
    this.pathByNodeId.set(node.nodeId, row.path)
    if (node.children && node.children.length) this.expanded.add(node.nodeId)
    for (const child of node.children ?? []) this.walk(child, depth + 1, row.path, rows)
  }

  private toRow(node: RawNode, depth: number, parentPath: string): DomTreeRow {
    const attrs = pairs(node.attributes)
    const label = this.labelOf(node, attrs)
    const childCount = node.childNodeCount ?? node.children?.length ?? 0
    const value = node.nodeValue?.trim() ?? ''
    return {
      nodeId: node.nodeId,
      parentId: node.parentId ?? 0,
      depth,
      nodeType: node.nodeType,
      nodeName: node.nodeName,
      label,
      path: parentPath ? parentPath + ' > ' + label : label,
      ...(attrs.length ? { attributes: attrs } : {}),
      ...(value ? { preview: clip(value, 120) } : {}),
      childCount,
      expandable: childCount > 0 && node.nodeType === 1 && !VOID_TAGS.has(node.nodeName),
      expanded: this.expanded.has(node.nodeId)
    }
  }

  private labelOf(node: RawNode, attrs: Array<[string, string]>): string {
    if (node.nodeType === 1) {
      const id = attrs.find(([name]) => name === 'id')?.[1]
      const classAttr = attrs.find(([name]) => name === 'class')?.[1]
      const classes = classAttr ? classAttr.split(/\s+/).filter(Boolean) : []
      return (
        node.nodeName.toLowerCase() +
        (id ? '#' + id : '') +
        (classes.length ? '.' + classes.join('.') : '')
      )
    }
    if (node.nodeType === 3) return '#text'
    if (node.nodeType === 8) return '#comment'
    if (node.nodeType === 9) return '#document'
    if (node.nodeType === 10) return '<!DOCTYPE ' + node.nodeName + '>'
    if (node.nodeType === 11) return '#fragment'
    return node.nodeName
  }

  /**
   * 给一个节点补出 `#document > html > body > div#x` 这样的路径。
   * CDP 的 describeNode 不一定给 parentId（单独描述一个节点时常常是 0），所以不能靠往上问；
   * 改成从根一层层往下走，命中了就返回 —— 层数有上限，代价是可预期的。
   * 路径只是辅助信息，拿不到就退回标签，不让它把整个检查带崩。
   */
  private async pathOfNode(sessionId: string, row: DomTreeRow): Promise<string> {
    const known = this.pathByNodeId.get(row.nodeId)
    if (known) return known
    try {
      const rootId = await this.documentRoot(sessionId)
      for (let depth = 1; depth <= 10; depth += 1) {
        const described = (await this.cdp.send(
          'DOM.describeNode',
          { nodeId: rootId, depth },
          sessionId
        )) as { node: RawNode }
        const hit = this.findPath(described.node, '', row.nodeId)
        if (hit) return hit
      }
    } catch {
      /* 拿不到就算了 */
    }
    return row.path
  }

  /** 深度优先找目标节点，顺手把路上所有节点的路径记进缓存 */
  private findPath(node: RawNode, parentPath: string, targetId: number): string | null {
    if (!node?.nodeId) return null
    const label = this.labelOf(node, pairs(node.attributes))
    const path = parentPath ? parentPath + ' > ' + label : label
    this.pathByNodeId.set(node.nodeId, path)
    if (node.nodeId === targetId) return path
    for (const child of node.children ?? []) {
      const hit = this.findPath(child, path, targetId)
      if (hit) return hit
    }
    return null
  }

  /** 一次取全：outerHTML / 盒模型 / 命中样式 / 计算样式 / 事件监听器 */
  async inspect(
    sessionId: string,
    target: { selector?: string; nodeId?: number }
  ): Promise<DomInspectResult> {
    const started = Date.now()

    try {
      await this.ensure(sessionId, ['DOM'])

      let nodeId = target.nodeId
      if (nodeId === undefined) {
        if (!target.selector) {
          return {
            ok: false,
            error: '既没给选择器也没给 nodeId',
            enabledDomains: this.enabledDomains(sessionId),
            durationMs: Date.now() - started
          }
        }
        const selector = target.selector
        const hit = await this.retryOnStale(sessionId, async (refresh) => {
          const rootId = await this.documentRoot(sessionId, refresh)
          return (await this.cdp.send(
            'DOM.querySelector',
            { nodeId: rootId, selector },
            sessionId
          )) as { nodeId: number }
        })
        if (!hit.nodeId) {
          return {
            ok: false,
            error: '选择器没匹配到元素：' + target.selector,
            enabledDomains: this.enabledDomains(sessionId),
            durationMs: Date.now() - started
          }
        }
        nodeId = hit.nodeId
      }

      const described = await this.retryOnStale(
        sessionId,
        async () =>
          (await this.cdp.send('DOM.describeNode', { nodeId, depth: 0 }, sessionId)) as {
            node: RawNode
          }
      )
      const row = this.toRow(described.node, 0, '')
      row.path = await this.pathOfNode(sessionId, row)

      const outer = (await this.cdp.send('DOM.getOuterHTML', { nodeId }, sessionId)) as {
        outerHTML: string
      }

      // 不可见元素（display:none、游离节点）拿不到盒模型 —— 那是正常状态，不是错误
      let box: DomBoxModel | null = null
      try {
        const raw = (await this.cdp.send('DOM.getBoxModel', { nodeId }, sessionId)) as {
          model: {
            content: number[]
            padding: number[]
            border: number[]
            margin: number[]
            width: number
            height: number
          }
        }
        box = {
          content: raw.model.content,
          padding: raw.model.padding,
          border: raw.model.border,
          margin: raw.model.margin,
          width: raw.model.width,
          height: raw.model.height
        }
      } catch {
        box = null
      }

      // 命中样式与计算样式分开兜底：两条 CDP 命令的失败原因无关，一条挂了不该把另一条吞掉；
      // 失败原因也不能静默丢掉 —— 面板和验收脚本都要看得见（曾经这里一声不响地全空）
      let matched: DomMatchedRule[] | undefined
      let computed: Array<[string, string]> | undefined
      let styleError: string | undefined
      try {
        await this.ensure(sessionId, ['CSS'])
        const styles = (await this.cdp.send(
          'CSS.getMatchedStylesForNode',
          { nodeId },
          sessionId
        )) as {
          inlineStyle?: { cssProperties?: RawCssProperty[] }
          matchedCSSRules?: RawCssRule[]
        }
        matched = this.toMatched(styles)
      } catch (error) {
        styleError = '命中样式取不到：' + msgOf(error)
      }
      try {
        const computedRaw = (await this.cdp.send(
          'CSS.getComputedStyleForNode',
          { nodeId },
          sessionId
        )) as { computedStyle: Array<{ name: string; value: string }> }
        computed = computedRaw.computedStyle.map(
          (item) => [item.name, item.value] as [string, string]
        )
      } catch (error) {
        styleError = (styleError ? styleError + '；' : '') + '计算样式取不到：' + msgOf(error)
      }

      // 事件监听器。DOM.resolveNode 不用开 Runtime 就能拿到 objectId（§3.4 红线）
      let listeners: DomEventListener[] | undefined
      let listenerError: string | undefined
      let listenerTotal = 0
      try {
        const resolved = (await this.cdp.send('DOM.resolveNode', { nodeId }, sessionId)) as {
          object?: { objectId?: string }
        }
        if (resolved.object?.objectId) {
          const raw = (await this.cdp.send(
            'DOMDebugger.getEventListeners',
            { objectId: resolved.object.objectId, depth: 1, pierce: true },
            sessionId
          )) as {
            listeners: Array<{
              type: string
              useCapture: boolean
              passive: boolean
              once: boolean
              scriptId?: string
              lineNumber?: number
              columnNumber?: number
              handler?: { description?: string }
            }>
          }
          listenerTotal = raw.listeners.length
          listeners = raw.listeners.map((item) => ({
            type: item.type,
            useCapture: item.useCapture,
            passive: item.passive,
            once: item.once,
            ...(item.handler?.description
              ? { handler: clip(item.handler.description.replace(/\s+/g, ' '), 200) }
              : {}),
            ...(item.scriptId !== undefined
              ? { location: item.scriptId + ':' + (item.lineNumber ?? 0) + ':' + (item.columnNumber ?? 0) }
              : {})
          }))
        }
      } catch (error) {
        listenerError = msgOf(error)
      }

      const html = outer.outerHTML ?? ''
      return {
        ok: true,
        // 报「到这个会话为止开过哪些」而不是「这次刚开了哪些」：
        // UI 用它当 §3.4「H 下按需启用」的证据，累计值才是证据
        enabledDomains: this.enabledDomains(sessionId),
        durationMs: Date.now() - started,
        node: row,
        outerHTML: clip(html, 20000),
        outerTruncated: html.length > 20000,
        box,
        ...(matched ? { matched } : {}),
        ...(computed ? { computed } : {}),
        ...(listeners ? { listeners, listenerTotal } : {}),
        ...(styleError ? { styleError } : {}),
        ...(listenerError ? { listenerError } : {})
      }
    } catch (error) {
      return {
        ok: false,
        error: isStaleNode(error)
          ? '节点已失效：页面刷新或 DOM 变动过，点「重取 DOM 树」再选一次'
          : msgOf(error),
        enabledDomains: this.enabledDomains(sessionId),
        durationMs: Date.now() - started
      }
    }
  }

  /**
   * 命中样式 → 带覆盖标记的规则列表。
   *
   * 覆盖判定按「高优先级先扫」：先扫到的规则声明过的属性名，后面（优先级更低）的规则里
   * 再出现就算被盖掉。顺序 = inline（最高）→ matchedCSSRules 的倒序（低 → 高 倒过来）。
   * 这个方向由 `npm run test:dom` 用真实计算结果反向验证：赢的那条必须没被标覆盖。
   */
  private toMatched(styles: {
    inlineStyle?: { cssProperties?: RawCssProperty[] }
    matchedCSSRules?: RawCssRule[]
  }): DomMatchedRule[] {
    // CDP 对同一条规则会给两遍：先是声明值，再是使用值（如 #aabbcc → rgb(170,187,204)）。
    // 留声明值就够，使用值在「计算样式」那一栏里有
    const propsOf = (list: RawCssProperty[] | undefined): Array<[string, string]> => {
      const out: Array<[string, string]> = []
      const seen = new Set<string>()
      for (const item of list ?? []) {
        if (item.disabled || item.implicit || item.value === '') continue
        if (seen.has(item.name)) continue
        seen.add(item.name)
        out.push([item.name, item.value])
      }
      return out
    }

    const ordered: DomMatchedRule[] = []
    // CSSStyle 的属性直接挂在 cssProperties 上。这里曾经多写了一层 .style，
    // 于是行内样式那条规则从来没出现过 —— 「inline 优先级最高」等于没实现
    const inline = propsOf(styles.inlineStyle?.cssProperties)
    if (inline.length) {
      ordered.push({ selector: 'element.style', origin: 'inline', properties: inline, overridden: [] })
    }
    // 这里曾经直接读 entry.rule.style.cssProperties：matchedCSSRules 里混着没有 style 的
    // 规则，一读就 TypeError，被 catch 吞掉之后面板上只剩一个空列表
    const matched = (styles.matchedCSSRules ?? [])
      .map((entry) => {
        const rule = entry?.rule
        if (!rule) return null
        const properties = propsOf(rule.style?.cssProperties)
        if (!properties.length) return null
        const item: DomMatchedRule = {
          selector: rule.selectorList?.text ?? '(无选择器)',
          origin: rule.origin ?? 'regular',
          properties,
          overridden: []
        }
        return item
      })
      .filter((entry): entry is DomMatchedRule => entry !== null)
    for (const entry of [...matched].reverse()) {
      ordered.push({ ...entry, overridden: [] })
    }

    const seen = new Set<string>()
    for (const rule of ordered) {
      if (rule.origin !== 'inline') {
        rule.overridden = rule.properties
          .filter(([name]) => seen.has(name))
          .map(([name]) => name)
      }
      for (const [name] of rule.properties) seen.add(name)
    }
    return ordered
  }

  /**
   * 只要一个元素的位置（点击 / 输入的落点）。
   *
   * 只开 DOM 域 —— 不因为一次点击就把 CSS / DOMDebugger / Overlay 打开（§3.4 的按需启用
   * 是给「看样式」「看监听器」用的，点个按钮不需要）。给不出几何就返回 null，
   * 由调用方如实报「没找到可见元素」，绝不静默点 (0,0)。
   */
  async box(
    sessionId: string,
    selector: string
  ): Promise<{ x: number; y: number; width: number; height: number } | null> {
    await this.ensure(sessionId, ['DOM'])
    const hit = await this.retryOnStale(sessionId, async (refresh) => {
      const rootId = await this.documentRoot(sessionId, refresh)
      return (await this.cdp.send(
        'DOM.querySelector',
        { nodeId: rootId, selector },
        sessionId
      )) as { nodeId: number }
    })
    if (!hit.nodeId) return null

    // getContentQuads 对 inline 元素也管用；getBoxModel 在少数节点上会给空模型
    let quad: number[] | undefined
    try {
      const raw = (await this.cdp.send('DOM.getContentQuads', { nodeId: hit.nodeId }, sessionId)) as {
        quads?: number[][]
      }
      quad = raw.quads?.find((item) => Array.isArray(item) && item.length >= 8)
    } catch {
      /* 落到 getBoxModel */
    }
    if (!quad) {
      const model = (await this.cdp.send('DOM.getBoxModel', { nodeId: hit.nodeId }, sessionId)) as {
        content?: number[]
        border?: number[]
      }
      quad = model.border ?? model.content
    }
    if (!quad || quad.length < 8) return null
    const xs = [quad[0], quad[2], quad[4], quad[6]] as number[]
    const ys = [quad[1], quad[3], quad[5], quad[7]] as number[]
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    return {
      x: Math.round((minX + maxX) / 2),
      y: Math.round((minY + maxY) / 2),
      width: Math.round(maxX - minX),
      height: Math.round(maxY - minY)
    }
  }

  /** 页面里高亮一个节点（Overlay）。页面侧看不见，风险表里没把它列成红线 */
  async highlight(sessionId: string, nodeId: number, on: boolean): Promise<string[]> {
    const fresh = await this.ensure(sessionId, ['Overlay'])
    if (on) {
      await this.cdp.send(
        'Overlay.highlightNode',
        {
          nodeId,
          highlightConfig: {
            showInfo: true,
            contentColor: { r: 111, g: 168, b: 220, a: 0.5 },
            paddingColor: { r: 147, g: 196, b: 125, a: 0.4 },
            borderColor: { r: 255, g: 229, b: 153, a: 0.5 },
            marginColor: { r: 246, g: 178, b: 107, a: 0.4 }
          }
        },
        sessionId
      )
      return fresh
    }
    await this.cdp.send('Overlay.hideHighlight', {}, sessionId)
    return fresh
  }
}