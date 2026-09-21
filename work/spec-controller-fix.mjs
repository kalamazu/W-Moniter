const NEW_NAMES = [
  'ContractDiff',
  'ContractListRow',
  'ContractSummary',
  'EndpointDetail',
  'EndpointPage',
  'EventPage',
  'EventQuery',
  'EventStats',
  'ExportQuery',
  'HarExportReport',
  'JsonlExportReport',
  'MonitoredEvent',
  'RelationReport',
  'RequestGraph',
  'ResourceExportReport',
  'WsConnectionRow',
  'WsFramePage',
  'WsFrameQuery',
  'WsFrameRecord'
]

export default [
  {
    file: 'src/main/controller.ts',
    label: '把误插的名字收回来',
    old: [
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
      '  WsFrameRecord',
      '  DomTreeRow,'
    ].join('\n'),
    new: ['  ControllerStatus,', '  DomInspectResult,', '  DomTreeRow,'].join('\n')
  },
  {
    file: 'src/main/controller.ts',
    label: '按字母序追加到 import 尾部',
    old: "  TargetInfo,\n  TimelineRow\n} from '../shared/types'",
    new: '  TargetInfo,\n  TimelineRow,\n' + NEW_NAMES.map((name) => '  ' + name).join(',\n') + "\n} from '../shared/types'"
  }
]