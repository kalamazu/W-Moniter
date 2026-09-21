export default [
  {
    file: 'src/main/storage/client.ts',
    label: 'import 类型',
    old: "import type { RequestRecord, ScriptRecord, StorageHealth } from '../../shared/types'",
    new: "import type { MonitoredEvent, RequestRecord, ScriptRecord, StorageHealth, WsFrameRecord } from '../../shared/types'"
  },
  {
    file: 'src/main/storage/client.ts',
    label: '队列容量常量与批量',
    old: 'const MAX_PENDING_SCRIPTS = 4096',
    new: 'const MAX_PENDING_SCRIPTS = 4096\n/**\n * 事件流队列容量。事件比脚本轻得多（一条几百字节），但一个报错死循环\n * 能瞬间造出成百上千条，所以仍然要有界：超了丢最旧的并计数。\n */\nconst MAX_PENDING_EVENTS = 8192\n/** WS 帧队列容量。帧可能很大（单条封 4KB），这里刻意比事件小一个量级 */\nconst MAX_PENDING_WS = 2048\nconst EVENT_BATCH = 500\nconst WS_BATCH = 500'
  },
  {
    file: 'src/main/storage/client.ts',
    label: '新增队列',
    old: '  private readonly scriptQueue: ScriptRecord[] = []',
    new: '  private readonly scriptQueue: ScriptRecord[] = []\n  private readonly eventQueue: MonitoredEvent[] = []\n  private readonly wsQueue: WsFrameRecord[] = []'
  },
  {
    file: 'src/main/storage/client.ts',
    label: 'health 初值',
    old: '      scriptsStored: 0,\n      scriptsMetaOnly: 0,\n      scriptsDropped: 0,\n      scriptQueueDepth: 0,\n      lastFlushMs: 0',
    new: '      scriptsStored: 0,\n      scriptsMetaOnly: 0,\n      scriptsDropped: 0,\n      scriptQueueDepth: 0,\n      eventsStored: 0,\n      eventsDropped: 0,\n      eventQueueDepth: 0,\n      wsFramesStored: 0,\n      wsFramesDropped: 0,\n      wsQueueDepth: 0,\n      lastFlushMs: 0'
  },
  {
    file: 'src/main/storage/client.ts',
    label: 'appendEvent / appendWsFrame',
    old: '  /** 采集到但拿不到 body 的情况也要留痕，否则「没有 body」和「没采」分不清 */\n  markBody(',
    new: '  /**\n   * 事件流入库。和请求一样只入队 —— 采集回调路径上不做任何 IO。\n   * 真正的落盘在 flush() 里，队列满了丢最旧的并计数上报。\n   */\n  appendEvent(item: MonitoredEvent): void {\n    if (!this.health.enabled) return\n    this.eventQueue.push(item)\n    if (this.eventQueue.length > MAX_PENDING_EVENTS) {\n      this.eventQueue.splice(0, this.eventQueue.length - MAX_PENDING_EVENTS)\n      this.health.eventsDropped += 1\n    }\n    this.health.eventQueueDepth = this.eventQueue.length\n  }\n\n  /** WebSocket 帧入库。帧是页面能自己造量的东西，队列与单条大小都有上限 */\n  appendWsFrame(frame: WsFrameRecord): void {\n    if (!this.health.enabled) return\n    this.wsQueue.push(frame)\n    if (this.wsQueue.length > MAX_PENDING_WS) {\n      this.wsQueue.splice(0, this.wsQueue.length - MAX_PENDING_WS)\n      this.health.wsFramesDropped += 1\n    }\n    this.health.wsQueueDepth = this.wsQueue.length\n  }\n\n  /** 采集到但拿不到 body 的情况也要留痕，否则「没有 body」和「没采」分不清 */\n  markBody('
  },
  {
    file: 'src/main/storage/client.ts',
    label: 'flush 早退条件',
    old: '      this.requestQueue.length === 0 &&\n      this.bodyQueue.length === 0 &&\n      this.scriptQueue.length === 0 &&\n      this.updateQueue.length === 0',
    new: '      this.requestQueue.length === 0 &&\n      this.bodyQueue.length === 0 &&\n      this.scriptQueue.length === 0 &&\n      this.eventQueue.length === 0 &&\n      this.wsQueue.length === 0 &&\n      this.updateQueue.length === 0'
  },
  {
    file: 'src/main/storage/client.ts',
    label: 'flush 落事件与 WS 帧',
    old: '      this.health.scriptQueueDepth = this.scriptQueue.length\n\n      while (this.bodyQueue.length > 0) {',
    new: '      this.health.scriptQueueDepth = this.scriptQueue.length\n\n      while (this.eventQueue.length > 0) {\n        const batch = this.eventQueue.slice(0, EVENT_BATCH)\n        const result = (await this.call(\'appendEvents\', {\n          inst: this.inst,\n          items: batch\n        })) as { inserted: number }\n\n        this.eventQueue.splice(0, batch.length)\n        this.health.eventsStored += result.inserted\n      }\n      this.health.eventQueueDepth = this.eventQueue.length\n\n      while (this.wsQueue.length > 0) {\n        const batch = this.wsQueue.slice(0, WS_BATCH)\n        const result = (await this.call(\'appendWsFrames\', {\n          inst: this.inst,\n          items: batch\n        })) as { inserted: number }\n\n        this.wsQueue.splice(0, batch.length)\n        this.health.wsFramesStored += result.inserted\n      }\n      this.health.wsQueueDepth = this.wsQueue.length\n\n      while (this.bodyQueue.length > 0) {'
  }
]