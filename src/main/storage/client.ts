import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { locateNode } from './locate-node'
import { resolveRuntimeFile } from '../paths'
import type { MonitoredEvent, RequestRecord, ScriptRecord, StorageHealth, WsFrameRecord } from '../../shared/types'

/**
 * 存储进程客户端。
 *
 * 三条纪律（对应设计文档 §5.2）：
 *   1) 采集回调只往内存队列里 push，落盘交给独立的 flush 定时器；
 *   2) 队列有上限，超了丢最旧的 body、再丢最旧的元数据，绝不阻塞采集；
 *   3) 同一份 body 在一个会话内只过一次管道，靠 hash 在主进程侧去重。
 */

const FLUSH_INTERVAL_MS = 200
const REQUEST_BATCH = 2000
const BODY_BATCH = 24
const SCRIPT_BATCH = 200

/** 元数据队列上限。超了丢最旧的，并计数上报 —— 丢了多少必须看得见。 */
const MAX_PENDING_REQUESTS = 100_000
/** body 队列上限。body 是可以牺牲的，元数据不是。 */
const MAX_PENDING_BODIES = 256
const MAX_PENDING_UPDATES = 8192
/**
 * 脚本队列上限。页面能加载几千个脚本（每个都用 eval 造一个），
 * 队列必须有界；超了丢最旧的，并计数上报。
 */
const MAX_PENDING_SCRIPTS = 4096
/**
 * 事件流队列容量。事件比脚本轻得多（一条几百字节），但一个报错死循环
 * 能瞬间造出成百上千条，所以仍然要有界：超了丢最旧的并计数。
 */
const MAX_PENDING_EVENTS = 8192
/** WS 帧队列容量。帧可能很大（单条封 4KB），这里刻意比事件小一个量级 */
const MAX_PENDING_WS = 2048
const EVENT_BATCH = 500
const WS_BATCH = 500
/** 主进程侧 hash 去重表的容量 */
const SEEN_HASH_LIMIT = 20_000
const CALL_TIMEOUT_MS = 20_000

export interface StorageConfig {
  dbPath: string
  contentDir?: string
  storeBodies: boolean
  bodyMaxBytes: number
  bodyStoreMaxBytes: number
  bodyStoreMaxCount: number
}

interface PendingBody {
  seq: number
  bytes: Uint8Array
  trunc: boolean
}
interface PendingContentRef { seq: number; hash: string; size: number; trunc: boolean }

interface PendingUpdate {
  seq: number
  state: string
  size: number
  hash: string
  trunc: boolean
  /** body 可能先于请求行到，允许重试若干轮再放弃 */
  attempts?: number
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: NodeJS.Timeout
}

/**
 * storage/server.mjs 的位置随运行方式而变：
 *   - electron-vite dev / 直接跑 out/main：__dirname 是 out/main，项目根在上两级
 *   - 打包后：放进 extraResources，落在 process.resourcesPath
 * 挨个试，第一个存在的胜出。打包场景下不能留在 asar 里 —— 子进程读不了 asar。
 */
/**
 * RequestRecord(camelCase) → requests 表列名(snake_case)。
 *
 * 这层映射不能省：之前直接把采集对象丢给服务端，request_id 这类 NOT NULL
 * 列全成了 null，INSERT OR IGNORE 把每一行都悄悄吞了 —— 界面看着正常，
 * 库里一条都没有。
 */
function toRow(record: RequestRecord): Record<string, unknown> {
  let host: string | null = null
  let scheme: string | null = null
  let path: string | null = null
  let query: string | null = null

  try {
    const parsed = new URL(record.url)
    host = parsed.host || null
    scheme = parsed.protocol.replace(':', '') || null
    path = parsed.pathname || null
    query = parsed.search ? parsed.search.slice(1) : null
  } catch {
    // data: / blob: / about: 这类没有 host，留空即可
  }

  return {
    seq: record.seq,
    key: record.key,
    request_id: record.requestId,
    session_id: record.sessionId,
    target_id: record.targetId,
    target_type: record.targetType,
    frame_url: record.frameUrl,
    url: record.url,
    host,
    scheme,
    path,
    query,
    method: record.method,
    resource_type: record.resourceType,
    initiator_type: record.initiatorType ?? record.initiator?.type ?? null,
    // 发起链是结构化数据，整条序列化成 JSON 存一列（列表查询不带它，只有详情 SELECT * 才给）
    initiator_stack: record.initiator ? JSON.stringify(record.initiator) : null,
    priority: null,
    status: record.status ?? null,
    status_text: record.statusText ?? null,
    mime_type: record.mimeType ?? null,
    protocol: null,
    remote_ip: null,
    remote_port: null,
    // 头是结构化数据，和 initiator_stack 一样序列化成 JSON 存一列
    req_headers: record.reqHeaders ? JSON.stringify(record.reqHeaders) : null,
    resp_headers: record.respHeaders ? JSON.stringify(record.respHeaders) : null,
    req_body: record.reqBody ?? null,
    encoded_len: record.encodedDataLength ?? null,
    decoded_len: null,
    from_cache: record.fromCache ? 1 : 0,
    from_sw: record.fromServiceWorker ? 1 : 0,
    // TTFB 用代理量到的那个：CDP 的回调里拿不到「首字节」这个时刻，
    // 代理的 ttfb 是「上游连接就绪 → 首字节」的实测值（§5.1）。
    // 来源是不是代理，看 merge_state / proxy_flow_id 就知道。
    ttfb_ms: record.timings?.ttfb ?? null,
    duration_ms: record.durationMs ?? null,
    start_ts: record.startTs,
    end_ts: record.endTs ?? null,
    failed: record.failed ?? null,
    canceled: record.canceled ? 1 : 0,

    // ---- P5：代理侧（三源关联的结果与代理独有的时序）
    merge_state: record.mergeState ?? null,
    proxy_flow_id: record.proxyFlowId ?? null,
    net_dns_ms: record.timings?.dns ?? null,
    net_connect_ms: record.timings?.connect ?? null,
    net_tls_ms: record.timings?.tls ?? null,
    net_download_ms: record.timings?.download ?? null,
    upstream_ip: record.upstreamIp ?? null,
    tls_version: record.tlsVersion ?? null,
    tls_cipher: record.tlsCipher ?? null,
    upstream_alpn: record.upstreamAlpn ?? null,
    proxy_delta_ms: record.proxyDeltaMs ?? null,
    merge_ambiguous: record.mergeAmbiguous ? 1 : 0,
    proxy_open: record.proxyOpen ? 1 : 0
  }
}

function resolveServerPath(): string | null {
  const override = process.env['MONITOR_STORAGE_SERVER']
  if (override) return existsSync(override) ? override : null
  return resolveRuntimeFile('storage', 'server.mjs')
}

export interface InstanceInfo {
  url: string
  profile: string
  kernel: string
  kernelVersion: string
  userAgent: string
  args: string[]
}

export class StorageClient extends EventEmitter {
  private child: ChildProcess | null = null
  private nextId = 1
  private readonly pending = new Map<number, PendingCall>()
  private carry = ''
  private inst = 0
  private flushing = false
  private timer: NodeJS.Timeout | null = null
  private closed = false
  private shutdownPromise: Promise<void> | null = null

  private readonly requestQueue: RequestRecord[] = []
  private readonly bodyQueue: PendingBody[] = []
  private readonly contentRefQueue: PendingContentRef[] = []
  private readonly updateQueue: PendingUpdate[] = []
  private readonly scriptQueue: ScriptRecord[] = []
  private readonly eventQueue: MonitoredEvent[] = []
  private readonly wsQueue: WsFrameRecord[] = []
  /**
   * 重试超限的 body 关联先寄存在这儿，等收尾时再试一次。
   *
   * 为什么不能直接丢：Fetch 在 Response 阶段拦，body 会比请求行早到；
   * 而有些请求（响应头到了但收尾事件一直没来）的行要等到 flushInflight
   * 才写进库 —— 那可能是几十秒之后。在实时阶段重试多少次都不可能命中。
   */
  private readonly parkedUpdates: PendingUpdate[] = []
  private readonly seenHashes = new Map<string, number>()

  private health: StorageHealth

  constructor(private readonly config: StorageConfig) {
    super()
    this.health = {
      enabled: false,
      nodePath: null,
      nodeVersion: null,
      dbPath: config.dbPath,
      error: null,
      queueDepth: 0,
      rowsWritten: 0,
      rowsUpdated: 0,
      rowsIgnored: 0,
      droppedRequests: 0,
      droppedBodies: 0,
      bodiesStored: 0,
      bodiesReferenced: 0,
      bodiesSkipped: 0,
      bodiesDedupedLocal: 0,
      bodiesRetried: 0,
      bodiesParked: 0,
      bodiesResolvedAtShutdown: 0,
      bodiesUnmatched: 0,
      scriptsStored: 0,
      scriptsMetaOnly: 0,
      scriptsDropped: 0,
      scriptQueueDepth: 0,
      eventsStored: 0,
      eventsDropped: 0,
      eventQueueDepth: 0,
      wsFramesStored: 0,
      wsFramesDropped: 0,
      wsQueueDepth: 0,
      lastFlushMs: 0
    }
  }

  getHealth(): StorageHealth {
    return {
      ...this.health,
      queueDepth:
        this.requestQueue.length +
        this.bodyQueue.length +
        this.contentRefQueue.length +
        this.updateQueue.length +
        this.parkedUpdates.length
    }
  }

  isEnabled(): boolean {
    return this.health.enabled
  }

  /** 当前运行的实例 id；=0 表示还没建实例 */
  getInstId(): number {
    return this.inst
  }

  /** 「现捞 body」这类用户主动触发的动作需要立刻可见，不能等定时器 */
  async flushNow(): Promise<void> {
    await this.flush()
  }

  /* ---------------------------------------------------------------- 启动 */

  async start(instance: InstanceInfo): Promise<StorageHealth> {
    // 允许二次启动（§7.1 #9 会话管理的「切 Profile 重启」）：收工时置上的关闭标记
    // 必须清掉，否则 call() 一直走 closed 分支，新会话一条也写不进去。
    this.closed = false
    this.shutdownPromise = null
    const { candidate, tried } = await locateNode()
    if (!candidate) {
      this.patch({
        enabled: false,
        error:
          '没有找到可用的 Node（需要 >= 22.5，且内置 node:sqlite）。' +
          '设置 MONITOR_NODE_PATH 指向 node.exe。已尝试: ' +
          tried.slice(0, 6).join(', ')
      })
      return this.getHealth()
    }

    const serverPath = resolveServerPath()
    if (!serverPath) {
      this.patch({
        enabled: false,
        error: '找不到存储进程脚本 storage/server.mjs（可用 MONITOR_STORAGE_SERVER 指定）'
      })
      return this.getHealth()
    }

    const child = spawn(candidate.path, ['--no-warnings', serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.consume(chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      const text = chunk.trim()
      if (text) this.emit('log', text)
    })
    child.on('error', (err: Error) => this.patch({ error: err.message }))
    child.on('exit', (code, signal) => {
      this.failAll(new Error(`存储进程退出 code=${code ?? 'null'} signal=${signal ?? 'null'}`))
      this.patch({ enabled: false, error: `存储进程退出 (code=${code ?? 'null'})` })
      this.emit('health', this.getHealth())
    })

    try {
      await this.call('open', { dbPath: this.config.dbPath, config: this.config }, 15_000)
      const started = (await this.call('beginInstance', {
        url: instance.url,
        profile: instance.profile,
        kernel: instance.kernel,
        kernelVersion: instance.kernelVersion,
        userAgent: instance.userAgent,
        args: instance.args
      })) as { instId: number }

      this.inst = started.instId
      this.patch({ enabled: true, nodePath: candidate.path, nodeVersion: candidate.version, error: null })
      this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS)
    } catch (err) {
      this.patch({ enabled: false, error: err instanceof Error ? err.message : String(err) })
    }

    this.emit('health', this.getHealth())
    return this.getHealth()
  }

  /* ---------------------------------------------------------------- 写入 */

  /**
   * 采集回调的入口。这里**只做入队**，任何情况下都不 await、不写盘。
   */
  append(record: RequestRecord): void {
    if (!this.health.enabled) return
    this.requestQueue.push(record)
    if (this.requestQueue.length > MAX_PENDING_REQUESTS) {
      this.requestQueue.splice(0, this.requestQueue.length - MAX_PENDING_REQUESTS)
      this.health.droppedRequests += 1
    }
  }

  /**
   * body 入库。hash 在主进程算，命中本地去重表就不再把 payload 过管道。
   */
  appendBody(seq: number, bytes: Uint8Array, trunc: boolean): void {
    if (!this.health.enabled) return

    const hash = createHash('sha256').update(bytes).digest('hex')
    const size = bytes.byteLength
    const alreadySent = this.seenHashes.has(hash)

    if (!alreadySent) {
      this.rememberHash(hash)
      if (this.config.storeBodies && size <= this.config.bodyMaxBytes) {
        this.bodyQueue.push({ seq, bytes, trunc })
        if (this.bodyQueue.length > MAX_PENDING_BODIES) {
          this.bodyQueue.shift()
          this.health.droppedBodies += 1
        }
      }
    } else {
      this.health.bodiesDedupedLocal += 1
    }

    this.pushUpdate({
      seq,
      state: !this.config.storeBodies
        ? 'skipped'
        : size > this.config.bodyMaxBytes
          ? 'hash_only'
          : 'stored',
      size,
      hash,
      trunc
    })
  }

  /** ContentStore 已提交后只把引用交给 SQLite，正文绝不再经 NDJSON/base64 复制。 */
  appendContentBody(seq: number, hash: string, size: number, trunc: boolean): void {
    if (!this.health.enabled) return
    this.contentRefQueue.push({ seq, hash, size, trunc })
    this.pushUpdate({ seq, state: 'stored', size, hash, trunc })
  }

  /**
   * 脚本入库。和请求一样只入队 —— 采集回调路径上不做任何 IO。
   * 源码可能很大，所以队列有上限，超了丢最旧的并计数。
   */
  appendScript(record: ScriptRecord): void {
    if (!this.health.enabled) return
    this.scriptQueue.push(record)
    if (this.scriptQueue.length > MAX_PENDING_SCRIPTS) {
      this.scriptQueue.splice(0, this.scriptQueue.length - MAX_PENDING_SCRIPTS)
      this.health.scriptsDropped += 1
    }
    this.health.scriptQueueDepth = this.scriptQueue.length
  }

  /**
   * 事件流入库。和请求一样只入队 —— 采集回调路径上不做任何 IO。
   * 真正的落盘在 flush() 里，队列满了丢最旧的并计数上报。
   */
  appendEvent(item: MonitoredEvent): void {
    if (!this.health.enabled) return
    this.eventQueue.push(item)
    if (this.eventQueue.length > MAX_PENDING_EVENTS) {
      this.eventQueue.splice(0, this.eventQueue.length - MAX_PENDING_EVENTS)
      this.health.eventsDropped += 1
    }
    this.health.eventQueueDepth = this.eventQueue.length
  }

  /** WebSocket 帧入库。帧是页面能自己造量的东西，队列与单条大小都有上限 */
  appendWsFrame(frame: WsFrameRecord): void {
    if (!this.health.enabled) return
    this.wsQueue.push(frame)
    if (this.wsQueue.length > MAX_PENDING_WS) {
      this.wsQueue.splice(0, this.wsQueue.length - MAX_PENDING_WS)
      this.health.wsFramesDropped += 1
    }
    this.health.wsQueueDepth = this.wsQueue.length
  }

  /** 采集到但拿不到 body 的情况也要留痕，否则「没有 body」和「没采」分不清 */
  markBody(seq: number, state: string, size = 0, hash = '', trunc = false): void {
    if (!this.health.enabled) return
    this.pushUpdate({ seq, state, size, hash, trunc })
  }

  private pushUpdate(update: PendingUpdate): void {
    this.updateQueue.push(update)
    if (this.updateQueue.length > MAX_PENDING_UPDATES) {
      this.updateQueue.splice(0, this.updateQueue.length - MAX_PENDING_UPDATES)
    }
  }

  private rememberHash(hash: string): void {
    this.seenHashes.set(hash, 1)
    if (this.seenHashes.size > SEEN_HASH_LIMIT) {
      // Map 保持插入序，删掉最老的一批即可。被删掉的 hash 万一再来，
      // 最坏情况是重传一次 payload，服务端 upsert 不会覆盖已有 blob。
      let toDrop = this.seenHashes.size - SEEN_HASH_LIMIT
      for (const key of this.seenHashes.keys()) {
        if (toDrop <= 0) break
        this.seenHashes.delete(key)
        toDrop -= 1
      }
    }
  }

  /** 收尾专用：把寄存的 body 关联一次性喂进去，对不上的才算真丢 */
  private async resolveParked(): Promise<void> {
    if (this.parkedUpdates.length === 0 || !this.health.enabled || this.closed) return
    const items = this.parkedUpdates.splice(0, this.parkedUpdates.length)
    try {
      const result = (await this.call('setRequestBodies', { inst: this.inst, items })) as {
        updated: number
        missing: number[]
      }
      this.health.bodiesUnmatched += result.missing.length
      this.health.bodiesResolvedAtShutdown += result.updated
    } catch {
      this.health.bodiesUnmatched += items.length
    }
  }

  private async flush(): Promise<void> {
    if (!this.health.enabled || this.flushing || this.closed) return
    if (
      this.requestQueue.length === 0 &&
      this.bodyQueue.length === 0 &&
      this.contentRefQueue.length === 0 &&
      this.scriptQueue.length === 0 &&
      this.eventQueue.length === 0 &&
      this.wsQueue.length === 0 &&
      this.updateQueue.length === 0
    ) {
      return
    }

    this.flushing = true
    const t0 = Date.now()
    try {
      // 顺序有语义：先元数据 → 再 body → 最后回填 body 关联。
      //
      // 三处都是「先 peek，调用成功才真出队」。之前是先 splice 再调用，
      // 一旦调用失败（比如收尾时进程已经关了）这批数据就凭空消失，
      // 而且计数也看不出少了 —— 元数据绝不能有这种路径。
      while (this.requestQueue.length > 0) {
        const batch = this.requestQueue.slice(0, REQUEST_BATCH)
        const result = (await this.call('appendRequests', {
          inst: this.inst,
          rows: batch.map(toRow)
        })) as { inserted: number; updated: number; ignored: number }

        this.requestQueue.splice(0, batch.length)
        this.health.rowsWritten += result.inserted
        this.health.rowsUpdated += result.updated
        if (result.ignored > 0) {
          // 被约束挡下的行说明映射或 schema 出问题了，不能装看不见
          this.health.rowsIgnored += result.ignored
          this.patch({ error: `有 ${result.ignored} 行请求被数据库约束丢弃，检查字段映射` })
        }
      }

      while (this.scriptQueue.length > 0) {
        const batch = this.scriptQueue.slice(0, SCRIPT_BATCH)
        // 先 peek 再出队：调用失败时这批脚本留在队列里，下一轮重试。
        // 源码可能几十 KB 一条，绝不能出现「出队了但没写进库」。
        const result = (await this.call('appendScripts', {
          inst: this.inst,
          items: batch
        })) as { withSource: number; metaOnly: number; inserted: number }

        this.scriptQueue.splice(0, batch.length)
        this.health.scriptsStored += result.withSource
        this.health.scriptsMetaOnly += result.metaOnly
      }
      this.health.scriptQueueDepth = this.scriptQueue.length

      while (this.eventQueue.length > 0) {
        const batch = this.eventQueue.slice(0, EVENT_BATCH)
        const result = (await this.call('appendEvents', {
          inst: this.inst,
          items: batch
        })) as { inserted: number }

        this.eventQueue.splice(0, batch.length)
        this.health.eventsStored += result.inserted
      }
      this.health.eventQueueDepth = this.eventQueue.length

      while (this.wsQueue.length > 0) {
        const batch = this.wsQueue.slice(0, WS_BATCH)
        const result = (await this.call('appendWsFrames', {
          inst: this.inst,
          items: batch
        })) as { inserted: number }

        this.wsQueue.splice(0, batch.length)
        this.health.wsFramesStored += result.inserted
      }
      this.health.wsQueueDepth = this.wsQueue.length

      while (this.bodyQueue.length > 0) {
        const batch = this.bodyQueue.slice(0, BODY_BATCH)
        const items = batch.map((item) => ({
          seq: item.seq,
          hash: createHash('sha256').update(item.bytes).digest('hex'),
          size: item.bytes.byteLength,
          trunc: item.trunc,
          b64: Buffer.from(item.bytes).toString('base64')
        }))
        const result = (await this.call('appendBodies', { inst: this.inst, items })) as {
          stored: number
          referenced: number
          skipped: number
        }

        this.bodyQueue.splice(0, batch.length)
        this.health.bodiesStored += result.stored
        this.health.bodiesReferenced += result.referenced
        this.health.bodiesSkipped += result.skipped
      }

      while (this.contentRefQueue.length > 0) {
        const batch = this.contentRefQueue.slice(0, BODY_BATCH)
        await this.call('appendBodyRefs', { inst: this.inst, items: batch })
        this.contentRefQueue.splice(0, batch.length)
        this.health.bodiesReferenced += batch.length
      }

      // 注意：这里是 if 不是 while。用 while 会把重试塞回队列后
      // 立刻又取出来，20 次重试在同一轮里烧完 —— 等于没重试。
      // 每轮 flush 只处理一批，重试自然跨轮发生。
      if (this.updateQueue.length > 0) {
        const batch = this.updateQueue.slice(0, 4096)
        const items = batch
        const result = (await this.call('setRequestBodies', {
          inst: this.inst,
          items
        })) as { updated: number; missing: number[] }

        this.updateQueue.splice(0, batch.length)

        // body 比请求行先到是正常的（Fetch 在 Response 阶段拦），留着下轮再试
        if (result.missing.length > 0) {
          const bySeq = new Map(items.map((item) => [item.seq, item]))
          for (const seq of result.missing) {
            const item = bySeq.get(seq)
            if (!item) continue
            const attempts = (item.attempts ?? 0) + 1
            if (attempts > 20) {
              if (this.parkedUpdates.length < MAX_PENDING_UPDATES) {
                this.parkedUpdates.push(item)
                this.health.bodiesParked += 1
              } else {
                this.health.bodiesUnmatched += 1
              }
              continue
            }
            this.health.bodiesRetried += 1
            this.pushUpdate({ ...item, attempts })
          }
        }
      }

      this.health.lastFlushMs = Date.now() - t0
    } catch (err) {
      // 收尾期间调用失败是预期内的，别把它写成「出错」误导使用者
      if (!this.closed) {
        this.patch({ error: err instanceof Error ? err.message : String(err) })
      }
    } finally {
      this.flushing = false
      this.emit('health', this.getHealth())
    }
  }

  /* ---------------------------------------------------------------- 查询 */

  call(op: string, args: Record<string, unknown> = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    if (!this.child || this.closed) {
      return Promise.reject(new Error('存储进程不可用'))
    }
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`存储调用超时: ${op}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child?.stdin?.write(JSON.stringify({ id, op, args }) + '\n')
    })
  }

  /* ---------------------------------------------------------------- 收尾 */

  /** 幂等：before-quit 和 auto-quit 两条路径都会走到这儿 */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.shutdownPromise = this.doShutdown()
    return this.shutdownPromise
  }

  private async doShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null

    // 尽量把队列排空，但给一个硬上限，避免退出被拖住。
    // 三个队列都要看 —— 只看前两个会把 body 关联留在队列里烂掉。
    const deadline = Date.now() + 5000
    const pending = (): number =>
      this.requestQueue.length + this.bodyQueue.length + this.contentRefQueue.length + this.updateQueue.length
    while (Date.now() < deadline && pending() > 0) {
      await this.flush()
      if (pending() === 0) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    // 收尾时再试一次寄存的 body 关联 —— 此时 flushInflight 已经把
    // 「响应到了但没等到收尾事件」的行都补进库了，这些应该能对上
    await this.resolveParked()

    if (pending() > 0) {
      // 排不空的必须记账，不能让「队列残留」静默变成丢失
      this.patch({ droppedRequests: this.health.droppedRequests + pending() })
    }

    // 这两条必须在 closed 置位之前发：call() 在 closed 之后一律拒绝，
    // 先置位就会把它们静默吞掉 —— 结果是 instances.ended_at 永远是 NULL
    // （会话面板上每个实例都像还在跑），库也没被正常关闭。
    try {
      await this.call('endInstance', { inst: this.inst }, 2000)
      await this.call('close', {}, 2000)
    } catch (error) {
      // 收尾失败不影响退出，但不能一声不响
      this.emit('log', '存储收尾失败: ' + (error instanceof Error ? error.message : String(error)))
    }
    this.closed = true
    this.child?.stdin?.end()
    const child = this.child
    setTimeout(() => {
      try {
        if (child && !child.killed) child.kill()
      } catch {
        /* 已经退出了 */
      }
    }, 1500).unref?.()
    this.child = null
    this.failAll(new Error('存储进程已关闭'))
  }

  /* ---------------------------------------------------------------- 内部 */

  private consume(chunk: string): void {
    const text = this.carry + chunk
    let start = 0
    let index = text.indexOf('\n', start)
    while (index !== -1) {
      const line = text.slice(start, index)
      if (line.length > 0) this.dispatch(line)
      start = index + 1
      index = text.indexOf('\n', start)
    }
    this.carry = text.slice(start)
  }

  private dispatch(line: string): void {
    let msg: { id?: number | null; ok?: boolean; result?: unknown; error?: string }
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.id === undefined || msg.id === null) return
    const call = this.pending.get(msg.id)
    if (!call) return
    this.pending.delete(msg.id)
    clearTimeout(call.timer)
    if (msg.ok) call.resolve(msg.result)
    else call.reject(new Error(msg.error ?? '存储进程返回未知错误'))
  }

  private failAll(err: Error): void {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer)
      call.reject(err)
    }
    this.pending.clear()
  }

  private patch(patch: Partial<StorageHealth>): void {
    this.health = { ...this.health, ...patch }
  }
}
