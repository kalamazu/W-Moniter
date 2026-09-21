import type { CdpClient, CdpEvent } from './cdp'
import type {
  CookieDeleteFilter,
  CookieInput,
  SiteCache,
  SiteIdbDatabase,
  SiteServiceWorker,
  SiteStorageEntry,
  StorageChangeDetail
} from '../../shared/types'

/**
 * 站点资源：cookie 罐与「站点存在浏览器里的那些东西」。
 *
 * 为什么把这一块单独拎出来：它和采集是两个方向 —— 采集是「流量流过去时顺手记下来」，
 * 这里是「主动去问浏览器：你这个域上到底存了什么，给我看看」。前者只能看见路过的，
 * 后者才能回答「这个站给我留了什么」。
 *
 * 三条约束决定了下面的写法：
 *   1. cookie 罐是**浏览器级**的（Storage.getCookies 不需要 session），别的地方都要 session
 *   2. DOMStorage / IndexedDB / CacheStorage 的 enable 是**按 session** 生效的，
 *      事件也只投给开了的那个 session —— 所以每个 page/iframe 都要开一遍
 *   3. 任何一个域没开上都不该让整个扫描失败。站点资源的现实就是「有些目标天生没有某个域」，
 *      失败要如实记进 warnings，而不是假装这里是空的
 */

/** 落库前把值剪短。localStorage 里塞几 MB 字符串的站点不少见 */
const STORAGE_VALUE_MAX = 2048
const STORAGE_KEYS_MAX = 500
const IDB_DB_MAX = 50
const CACHE_MAX = 50
const CACHE_ENTRIES_MAX = 200
/** cookie 值落库上限。cookie 本身有 4KB 上限，正常到不了 */
const COOKIE_VALUE_MAX = 4096

/** 去掉前导点：浏览器的域匹配不关心 `.example.com` 和 `example.com` 的区别 */
export function stripDots(text: string): string {
  let i = 0
  while (i < text.length && text[i] === '.') i += 1
  return text.slice(i)
}

export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.origin === 'null' ? null : parsed.origin
  } catch {
    return null
  }
}

export function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** CDP Storage.Cookie 的形状。我们不改造它，只搬运 */
export interface JarCookie {
  name: string
  value: string
  domain: string
  path: string
  expires?: number
  size: number
  httpOnly: boolean
  secure: boolean
  session: boolean
  sameSite?: string
  priority?: string
  sourceScheme?: string
  sourcePort?: number
  partitionKey?: string
}

export interface OriginScan {
  origin: string
  localStorage: SiteStorageEntry[]
  sessionStorage: SiteStorageEntry[]
  idb: SiteIdbDatabase[]
  caches: SiteCache[]
  serviceWorkers: SiteServiceWorker[]
  usageBytes: number | null
  quotaBytes: number | null
  usageBreakdown: Array<{ storageType: string; usage: number }>
  warnings: string[]
}

/** 一个域的扫描结果落库前的样子（和 shared/types 的 SiteOriginRow 对齐） */
export interface OriginRow {
  origin: string
  localStorageCount: number
  localStorageBytes: number
  sessionStorageCount: number
  sessionStorageBytes: number
  idbNames: string[]
  idbStores: number
  cacheNames: string[]
  cacheEntries: number
  swCount: number
  usageBytes: number | null
  quotaBytes: number | null
  usageBreakdown: Array<{ storageType: string; usage: number }>
  detail: {
    localStorage: SiteStorageEntry[]
    sessionStorage: SiteStorageEntry[]
    idb: SiteIdbDatabase[]
    caches: SiteCache[]
    serviceWorkers: SiteServiceWorker[]
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class SiteData {
  /** ServiceWorker.workerRegistrationUpdated 推的注册表。同一个 worker 会反复推，覆盖即可 */
  private registrations: SiteServiceWorker[] = []
  /** 已经 track 过的 origin（track 是幂等的，但没必要重复发） */
  private readonly tracking = new Set<string>()
  /** 已经 enable 过的 session */
  private readonly enabled = new Set<string>()

  /**
   * 站点存储的变化。
   *
   * DOMStorage 是逐键的（谁改了哪个键、改成了什么，事件里就有）；
   * 缓存 / IndexedDB / ServiceWorker 的域事件只给名字 —— 浏览器只肯告诉我们
   * 「这个域的某个东西动了」，明细得重新扫。两者都往这一条路上走，形状统一。
   */
  onStorageChange: (change: StorageChangeDetail) => void = () => {}
  onLog: (line: string) => void = () => {}

  constructor(
    private readonly cdp: CdpClient,
    /** 要一个 page 会话。除了 cookie 罐，别的命令都得挂在某个页面上发 */
    private readonly pageSession: () => Promise<string | null>
  ) {
    this.cdp.on('event', (event: CdpEvent) => {
      void this.onEvent(event)
    })
  }

  /**
   * 每个 page / iframe 会话都要开一遍。
   * 这些 domain 的事件按 session 投递，只在主 frame 上开就会漏掉 OOPIF 里的存储变化。
   */
  async attachSession(sessionId: string, targetType: string): Promise<void> {
    if (targetType !== 'page' && targetType !== 'iframe') return
    if (this.enabled.has(sessionId)) return
    this.enabled.add(sessionId)
    await Promise.all([
      this.cdp.send('DOMStorage.enable', {}, sessionId).catch(() => undefined),
      this.cdp.send('IndexedDB.enable', {}, sessionId).catch(() => undefined),
      this.cdp.send('ServiceWorker.enable', {}, sessionId).catch(() => undefined)
    ])
  }

  /** 让浏览器把某个域的缓存 / IndexedDB 变化推给我们。扫过一次就挂上 */
  async trackOrigin(origin: string): Promise<void> {
    if (!origin || this.tracking.has(origin)) return
    this.tracking.add(origin)
    const session = await this.pageSession()
    if (!session) {
      this.tracking.delete(origin)
      return
    }
    await Promise.all([
      this.cdp.send('Storage.trackCacheStorageForOrigin', { origin }, session).catch(() => undefined),
      this.cdp.send('Storage.trackIndexedDBForOrigin', { origin }, session).catch(() => undefined)
    ])
  }

  /* --------------------------------------------------------------- cookie 罐 */

  /** 全量 cookie 罐。浏览器级命令：浏览器起来的就能问，页面还没加载也无所谓 */
  async listCookies(): Promise<JarCookie[]> {
    const result = (await this.cdp.send('Storage.getCookies')) as { cookies?: JarCookie[] }
    return (result.cookies ?? []).map((cookie) => ({
      ...cookie,
      value: String(cookie.value ?? '').slice(0, COOKIE_VALUE_MAX)
    }))
  }

  async setCookie(input: CookieInput): Promise<{ ok: boolean; error?: string }> {
    if (!input.name) return { ok: false, error: 'cookie 必须有 name' }
    let domain = input.domain ? stripDots(input.domain) : ''
    if (!domain && input.url) {
      try {
        domain = new URL(input.url).hostname
      } catch {
        return { ok: false, error: 'url 解析不了：' + input.url }
      }
    }
    if (!domain) return { ok: false, error: '要么给 domain，要么给 url —— 不然不知道往哪个域写' }
    const cookie: Record<string, unknown> = { name: input.name, value: input.value ?? '', domain }
    cookie.path = input.path || '/'
    if (input.secure !== undefined) cookie.secure = input.secure
    if (input.httpOnly !== undefined) cookie.httpOnly = input.httpOnly
    if (input.sameSite) cookie.sameSite = input.sameSite
    if (input.expires !== undefined) cookie.expires = input.expires
    else if (input.maxAge !== undefined) {
      // maxAge <= 0 就是「立刻作废」：给一个过去的时间点，浏览器会当场删掉
      cookie.expires = input.maxAge > 0 ? Math.floor(Date.now() / 1000) + input.maxAge : 1
    }
    try {
      await this.cdp.send('Storage.setCookies', { cookies: [cookie] })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: message(error) }
    }
  }

  /**
   * 按条件删 cookie。一个条件都不给就拒绝 —— 这个口子从 agent 过来，
   * 「什么都不填」多半是参数没传对，不该被解释成「清空」。
   */
  async deleteCookies(
    filter: CookieDeleteFilter
  ): Promise<{ ok: boolean; error?: string; deleted: number }> {
    const hasFilter = Boolean(
      filter.name || filter.domain || filter.path || filter.url || filter.host ||
      (filter.extraKeys && filter.extraKeys.length > 0)
    )
    if (!hasFilter) {
      return { ok: false, error: '至少要给一个条件（name / domain / host / url / path），不填就是全删，这个口子不开', deleted: 0 }
    }
    const wanted = (cookie: JarCookie): boolean => {
      const host = stripDots(String(cookie.domain ?? '')).toLowerCase()
      if (filter.name && cookie.name !== filter.name) return false
      if (filter.path && (cookie.path || '/') !== filter.path) return false
      if (filter.domain && host !== stripDots(filter.domain).toLowerCase()) return false
      if (filter.host) {
        const base = stripDots(filter.host).toLowerCase()
        if (host !== base && !host.endsWith('.' + base)) return false
      }
      if (filter.url) {
        let urlHost = ''
        try {
          urlHost = new URL(filter.url).hostname.toLowerCase()
        } catch {
          return false
        }
        if (host !== urlHost && !urlHost.endsWith('.' + host)) return false
      }
      if (filter.extraKeys && filter.extraKeys.length > 0) {
        const key = host + '|' + (cookie.path || '/') + '|' + cookie.name + '|' + String(cookie.partitionKey ?? '')
        if (!filter.extraKeys.includes(key)) return false
      }
      return true
    }

    const session = await this.pageSession()
    let deleted = 0
    const failures: string[] = []
    for (const cookie of await this.listCookies()) {
      if (!wanted(cookie)) continue
      try {
        await this.deleteOne(cookie, session)
        deleted += 1
      } catch (error) {
        failures.push(cookie.name + ': ' + message(error))
      }
    }
    if (deleted === 0 && failures.length > 0) {
      return { ok: false, error: failures.slice(0, 3).join('; '), deleted: 0 }
    }
    return { ok: true, ...(failures.length > 0 ? { error: failures.slice(0, 3).join('; ') } : {}), deleted }
  }

  private async deleteOne(cookie: JarCookie, session: string | null): Promise<void> {
    const params: Record<string, unknown> = {
      name: cookie.name,
      domain: stripDots(String(cookie.domain ?? '')),
      path: cookie.path || '/'
    }
    if (cookie.partitionKey) params.partitionKey = cookie.partitionKey
    if (session) await this.cdp.send('Network.deleteCookies', params, session)
    else await this.cdp.send('Network.deleteCookies', params)
  }

  /** 全清（用来做「一键清干净」和验收里的对照） */
  async clearAllCookies(): Promise<void> {
    await this.cdp.send('Storage.clearCookies')
  }

  /* ----------------------------------------------------------- 站点存储扫描 */

  /**
   * 扫一个域。每一块单独兜错：站点资源的现实是「有些域天生没有 IndexedDB」，
   * 一块读不到不该让整份报告变成空的 —— 但要如实记进 warnings。
   */
  async scanOrigin(origin: string): Promise<OriginScan> {
    const warnings: string[] = []
    const out: OriginScan = {
      origin,
      localStorage: [],
      sessionStorage: [],
      idb: [],
      caches: [],
      serviceWorkers: [],
      usageBytes: null,
      quotaBytes: null,
      usageBreakdown: [],
      warnings
    }
    const session = await this.pageSession()
    if (!session) {
      warnings.push('还没有 page 会话，站点存储扫不了（cookie 罐是浏览器级的，仍然能扫）')
      return out
    }
    void this.trackOrigin(origin)
    const [local, sessionStore, idb, caches, registrations, usage] = await Promise.all([
      this.readStorage(origin, true, session, warnings),
      this.readStorage(origin, false, session, warnings),
      this.readIdb(origin, session, warnings),
      this.readCaches(origin, session, warnings),
      Promise.resolve(this.registrationsFor(origin)),
      this.readUsage(origin, session, warnings)
    ])
    out.localStorage = local
    out.sessionStorage = sessionStore
    out.idb = idb
    out.caches = caches
    out.serviceWorkers = registrations
    out.usageBytes = usage.usageBytes
    out.quotaBytes = usage.quotaBytes
    out.usageBreakdown = usage.usageBreakdown
    return out
  }

  private async readStorage(
    origin: string,
    isLocal: boolean,
    session: string,
    warnings: string[]
  ): Promise<SiteStorageEntry[]> {
    try {
      const result = (await this.cdp.send(
        'DOMStorage.getDOMStorageItems',
        { storageId: { securityOrigin: origin, isLocalStorage: isLocal } },
        session
      )) as { entries?: Array<[string, string]> }
      const entries = result.entries ?? []
      const out: SiteStorageEntry[] = []
      for (const [key, value] of entries.slice(0, STORAGE_KEYS_MAX)) {
        const text = String(value ?? '')
        out.push({
          key,
          value: text.length > STORAGE_VALUE_MAX ? text.slice(0, STORAGE_VALUE_MAX) : text,
          bytes: Buffer.byteLength(text, 'utf8'),
          ...(text.length > STORAGE_VALUE_MAX ? { truncated: true } : {})
        })
      }
      return out
    } catch (error) {
      warnings.push((isLocal ? 'localStorage' : 'sessionStorage') + ' 读失败：' + message(error))
      return []
    }
  }

  private async readIdb(origin: string, session: string, warnings: string[]): Promise<SiteIdbDatabase[]> {
    const out: SiteIdbDatabase[] = []
    try {
      const names = (await this.cdp.send('IndexedDB.requestDatabaseNames', { securityOrigin: origin }, session)) as {
        databaseNames?: string[]
      }
      for (const name of (names.databaseNames ?? []).slice(0, IDB_DB_MAX)) {
        try {
          const detail = (await this.cdp.send(
            'IndexedDB.requestDatabase',
            { securityOrigin: origin, databaseName: name },
            session
          )) as {
            databaseWithObjectStores?: {
              name: string
              version: number
              objectStores?: Array<{
                name: string
                keyPath?: { type?: string; string?: string; number?: number }
                autoIncrement?: boolean
                indexes?: Array<{ name: string }>
              }>
            }
          }
          const db = detail.databaseWithObjectStores
          if (!db) continue
          out.push({
            name: db.name,
            version: db.version,
            objectStores: (db.objectStores ?? []).map((store) => ({
              name: store.name,
              ...(store.keyPath?.type === 'string' && store.keyPath.string ? { keyPath: store.keyPath.string } : {}),
              ...(store.autoIncrement ? { autoIncrement: true } : {}),
              indexes: (store.indexes ?? []).map((index) => index.name)
            }))
          })
        } catch (error) {
          warnings.push('IndexedDB ' + name + ' 结构读失败：' + message(error))
        }
      }
    } catch (error) {
      warnings.push('IndexedDB 清单读失败：' + message(error))
    }
    return out
  }

  private async readCaches(origin: string, session: string, warnings: string[]): Promise<SiteCache[]> {
    const out: SiteCache[] = []
    try {
      const names = (await this.cdp.send('CacheStorage.requestCacheNames', { securityOrigin: origin }, session)) as {
        caches?: Array<{ cacheId: string; cacheName: string }>
      }
      for (const cache of (names.caches ?? []).slice(0, CACHE_MAX)) {
        try {
          const entries = (await this.cdp.send(
            'CacheStorage.requestEntries',
            { cacheId: cache.cacheId, pageSize: CACHE_ENTRIES_MAX },
            session
          )) as {
            cacheDataEntries?: Array<{ requestURL?: string; responseStatus?: number }>
            returnCount?: number
          }
          const rows = entries.cacheDataEntries ?? []
          out.push({
            name: cache.cacheName,
            count: entries.returnCount ?? rows.length,
            entries: rows.map((row) => ({
              url: row.requestURL ?? '',
              size: null,
              ...(row.responseStatus === undefined ? {} : { status: row.responseStatus })
            }))
          })
        } catch (error) {
          warnings.push('缓存 ' + cache.cacheName + ' 读失败：' + message(error))
        }
      }
    } catch (error) {
      warnings.push('CacheStorage 清单读失败：' + message(error))
    }
    return out
  }

  private async readUsage(
    origin: string,
    session: string,
    warnings: string[]
  ): Promise<{ usageBytes: number | null; quotaBytes: number | null; usageBreakdown: Array<{ storageType: string; usage: number }> }> {
    try {
      const result = (await this.cdp.send('Storage.getUsageAndQuota', { origin }, session)) as {
        usage?: number
        quota?: number
        usageBreakdown?: Array<{ storageType: string; usage: number }>
      }
      return {
        usageBytes: result.usage ?? null,
        quotaBytes: result.quota ?? null,
        usageBreakdown: result.usageBreakdown ?? []
      }
    } catch (error) {
      warnings.push('用量读失败：' + message(error))
      return { usageBytes: null, quotaBytes: null, usageBreakdown: [] }
    }
  }

  private registrationsFor(origin: string): SiteServiceWorker[] {
    const host = hostOf(origin)
    return this.registrations.filter((item) => {
      const scope = originOf(item.scopeURL ?? '')
      if (!scope) return false
      const scopeHost = hostOf(scope)
      return scopeHost === host || scopeHost.endsWith('.' + host) || host.endsWith('.' + scopeHost)
    })
  }

  getRegistrations(): SiteServiceWorker[] {
    return this.registrations
  }

  /* ------------------------------------------------------------ 存储的写操作 */

  private storageId(origin: string, area: 'local' | 'session'): Record<string, unknown> {
    return { securityOrigin: origin, isLocalStorage: area === 'local' }
  }

  async editStorage(input: {
    origin: string
    area: 'local' | 'session'
    action: 'set' | 'remove' | 'clear'
    key?: string
    value?: string
  }): Promise<{ ok: boolean; error?: string }> {
    const session = await this.pageSession()
    if (!session) return { ok: false, error: '还没有 page 会话，改不了存储' }
    const storageId = this.storageId(input.origin, input.area)
    try {
      if (input.action === 'clear') {
        await this.cdp.send('DOMStorage.clear', { storageId }, session)
        return { ok: true }
      }
      if (!input.key) return { ok: false, error: 'action=' + input.action + ' 需要 key' }
      if (input.action === 'remove') {
        await this.cdp.send('DOMStorage.removeDOMStorageItem', { storageId, key: input.key }, session)
        return { ok: true }
      }
      await this.cdp.send('DOMStorage.setDOMStorageItem', { storageId, key: input.key, value: input.value ?? '' }, session)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: message(error) }
    }
  }

  async deleteIdbDatabase(origin: string, name: string): Promise<{ ok: boolean; error?: string }> {
    const session = await this.pageSession()
    if (!session) return { ok: false, error: '还没有 page 会话' }
    try {
      await this.cdp.send('IndexedDB.deleteDatabase', { securityOrigin: origin, databaseName: name }, session)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: message(error) }
    }
  }

  /** 删一整个缓存，或只删缓存里的某条 URL（url 给了就是删条目） */
  async deleteCache(origin: string, name: string, url?: string): Promise<{ ok: boolean; error?: string }> {
    const session = await this.pageSession()
    if (!session) return { ok: false, error: '还没有 page 会话' }
    try {
      if (url) {
        const ids = await this.cacheIdOf(origin, name, session)
        if (!ids) return { ok: false, error: '没有这个缓存：' + name }
        await this.cdp.send('CacheStorage.deleteEntry', { cacheId: ids, request: url }, session)
        return { ok: true }
      }
      const cacheId = await this.cacheIdOf(origin, name, session)
      if (!cacheId) return { ok: false, error: '没有这个缓存：' + name }
      await this.cdp.send('CacheStorage.deleteCache', { cacheId }, session)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: message(error) }
    }
  }

  private async cacheIdOf(origin: string, name: string, session: string): Promise<string | null> {
    const names = (await this.cdp.send('CacheStorage.requestCacheNames', { securityOrigin: origin }, session)) as {
      caches?: Array<{ cacheId: string; cacheName: string }>
    }
    return (names.caches ?? []).find((item) => item.cacheName === name)?.cacheId ?? null
  }

  async unregisterServiceWorker(scopeURL: string): Promise<{ ok: boolean; error?: string }> {
    const session = await this.pageSession()
    if (!session) return { ok: false, error: '还没有 page 会话' }
    try {
      await this.cdp.send('ServiceWorker.unregister', { scopeURL }, session)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: message(error) }
    }
  }

  /**
   * 清一个域的站点数据。sessionStorage 不在 clearDataForOrigin 的类型表里，
   * 得单独走 DOMStorage.clear —— 少这一步就会留下一个「清过了但还在」的表。
   */
  async clearOrigin(origin: string, types: string[]): Promise<{ ok: boolean; error?: string; types: string[] }> {
    const session = await this.pageSession()
    if (!session) return { ok: false, error: '还没有 page 会话', types: [] }
    const wanted = new Set(types)
    const cdpTypes = [...wanted].filter((type) => type !== 'session_storage')
    const done: string[] = []
    try {
      if (wanted.has('all')) {
        await this.cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' }, session)
        done.push('all')
      } else if (cdpTypes.length > 0) {
        await this.cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: cdpTypes.join(',') }, session)
        done.push(...cdpTypes)
      }
      if (wanted.has('session_storage') || wanted.has('all')) {
        await this.cdp.send('DOMStorage.clear', { storageId: this.storageId(origin, 'session') }, session)
        done.push('session_storage')
      }
      if (wanted.has('all')) {
        for (const registration of this.registrationsFor(origin)) {
          await this.cdp
            .send('ServiceWorker.unregister', { scopeURL: registration.scopeURL }, session)
            .catch(() => undefined)
        }
      }
      return { ok: true, types: done }
    } catch (error) {
      return { ok: false, error: message(error), types: done }
    }
  }

  /* ------------------------------------------------------------------ 事件 */

  private async onEvent(event: CdpEvent): Promise<void> {
    switch (event.method) {
      case 'DOMStorage.domStorageItemAdded':
      case 'DOMStorage.domStorageItemUpdated':
      case 'DOMStorage.domStorageItemRemoved':
      case 'DOMStorage.domStorageItemsCleared': {
        const change = this.toStorageChange(event)
        if (change) this.onStorageChange(change)
        return
      }
      case 'ServiceWorker.workerRegistrationUpdated': {
        const p = event.params as { registrations?: SiteServiceWorker[] }
        this.registrations = p.registrations ?? []
        for (const origin of new Set(this.registrations.map((item) => originOf(item.scopeURL ?? '')).filter(Boolean))) {
          const scope = origin as string
          this.onStorageChange({ area: 'serviceworker', action: 'list', origin: scope, name: String(this.registrationsFor(scope).length) })
        }
        return
      }
      case 'Storage.cacheStorageListUpdated': {
        const p = event.params as { origin?: string }
        if (p.origin) this.onStorageChange({ area: 'cache', action: 'list', origin: p.origin })
        return
      }
      case 'Storage.cacheStorageContentUpdated': {
        const p = event.params as { origin?: string; cacheName?: string }
        if (p.origin) this.onStorageChange({ area: 'cache', action: 'content', origin: p.origin, name: p.cacheName })
        return
      }
      case 'Storage.indexedDBListUpdated': {
        const p = event.params as { origin?: string }
        if (p.origin) this.onStorageChange({ area: 'indexeddb', action: 'list', origin: p.origin })
        return
      }
      case 'Storage.indexedDBContentUpdated': {
        const p = event.params as { origin?: string; databaseName?: string; objectStoreName?: string }
        if (p.origin) {
          this.onStorageChange({
            area: 'indexeddb',
            action: 'content',
            origin: p.origin,
            name: p.databaseName,
            objectStore: p.objectStoreName
          })
        }
        return
      }
      default:
        return
    }
  }

  private toStorageChange(event: CdpEvent): StorageChangeDetail | null {
    const p = event.params as {
      storageId?: { securityOrigin?: string; storageKey?: string; isLocalStorage?: boolean }
      key?: string
      newValue?: string
      oldValue?: string
    }
    const origin = p.storageId?.securityOrigin ?? p.storageId?.storageKey ?? ''
    if (!origin) return null
    const area: 'local' | 'session' = p.storageId?.isLocalStorage === false ? 'session' : 'local'
    const clip = (text: string | undefined): string | undefined =>
      text === undefined ? undefined : text.length > STORAGE_VALUE_MAX ? text.slice(0, STORAGE_VALUE_MAX) : text
    if (event.method === 'DOMStorage.domStorageItemsCleared') {
      return { action: 'clear', area, origin }
    }
    if (event.method === 'DOMStorage.domStorageItemRemoved') {
      return { action: 'remove', area, origin, key: p.key }
    }
    if (event.method === 'DOMStorage.domStorageItemAdded') {
      return { action: 'set', area, origin, key: p.key, value: clip(p.newValue) }
    }
    return { action: 'set', area, origin, key: p.key, value: clip(p.newValue), oldValue: clip(p.oldValue) }
  }
}