import { readFileSync } from 'node:fs'
const methods = readFileSync('work/frag-controller.mjs', 'utf8')

const IMPORT_OLD = [
  'import type {',
  '  BodyPayload,',
  '  CapabilitySet,',
  '  ConsoleEntry,',
  '  ControllerStatus,',
  '  DomInspectResult,'
].join('\n')
const IMPORT_NEW = [
  'import type {',
  '  BodyPayload,',
  '  CapabilitySet,',
  '  ConsoleEntry,',
  '  ContractDiff,',
  '  ContractListRow,',
  '  ContractSummary,',
  '  ControllerStatus,',
  '  DomInspectResult,',
  '  EndpointDetail,',
  '  EndpointPage,',
  '  EventPage,',
  '  EventQuery,',
  '  EventStats,',
  '  ExportQuery,',
  '  HarExportReport,',
  '  JsonlExportReport,',
  '  MonitoredEvent,',
  '  RelationReport,',
  '  RequestGraph,',
  '  ResourceExportReport,',
  '  WsConnectionRow,',
  '  WsFramePage,',
  '  WsFrameQuery,',
  '  WsFrameRecord'
].join('\n')

export default [
  {
    file: 'src/main/controller.ts',
    label: 'import 分析层类型',
    old: IMPORT_OLD,
    new: IMPORT_NEW
  },
  {
    file: 'src/main/controller.ts',
    label: '计数字段',
    old: '  private requestCount = 0\n  private scriptCount = 0',
    new: '  private requestCount = 0\n  private scriptCount = 0\n  private eventCount = 0\n  private wsFrameCount = 0'
  },
  {
    file: 'src/main/controller.ts',
    label: '订阅事件流与 WS 帧',
    old: "      this.collector.on('console', (entry: ConsoleEntry) => this.emit('console', entry))",
    new: "      this.collector.on('console', (entry: ConsoleEntry) => this.emit('console', entry))\n      // 事件流与 WS 帧：只入存储队列，不推给 UI —— 分析面板按 since 轮询库，\n      // 同一条数据走两条路迟早会不一致，这里保持单一路径\n      this.collector.on('event', (item: MonitoredEvent) => this.onEvent(item))\n      this.collector.on('wsframe', (frame: WsFrameRecord) => this.onWsFrame(frame))"
  },
  {
    file: 'src/main/controller.ts',
    label: 'onEvent / onWsFrame',
    old: '  private onBody(body: CapturedBody): void {',
    new: '  private onEvent(item: MonitoredEvent): void {\n    this.eventCount += 1\n    this.storage.appendEvent(item)\n  }\n\n  private onWsFrame(frame: WsFrameRecord): void {\n    this.wsFrameCount += 1\n    this.storage.appendWsFrame(frame)\n  }\n\n  private onBody(body: CapturedBody): void {'
  },
  {
    file: 'src/main/controller.ts',
    label: '状态里带上计数',
    old: '  private flush(): void {\n    if (this.collector) this.patchStatus({ body: this.collector.getBodyStats() })',
    new: '  private flush(): void {\n    if (this.collector) this.patchStatus({ body: this.collector.getBodyStats() })\n    // 计数变了才推：这两个数字涨得很快，没必要每 150ms 都发一次同样的值\n    if (this.eventCount !== this.status.eventCount || this.wsFrameCount !== this.status.wsFrameCount) {\n      this.patchStatus({ eventCount: this.eventCount, wsFrameCount: this.wsFrameCount })\n    }'
  },
  {
    file: 'src/main/controller.ts',
    label: 'clear 重置计数',
    old: '    this.patchStatus({ requestCount: 0, scriptCount: 0 })',
    new: '    this.patchStatus({ requestCount: 0, scriptCount: 0, eventCount: 0, wsFrameCount: 0 })'
  },
  {
    file: 'src/main/controller.ts',
    label: '插入分析/导出/契约方法',
    old: '  async getTimeline(query: RequestQuery, limit: number): Promise<TimelineRow[]> {',
    new: methods + '  async getTimeline(query: RequestQuery, limit: number): Promise<TimelineRow[]> {'
  }
]