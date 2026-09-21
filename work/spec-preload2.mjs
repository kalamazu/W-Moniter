import { readFileSync } from 'node:fs'
const block = readFileSync('work/frag-preload.mjs', 'utf8')

export default [
  {
    file: 'src/preload/index.ts',
    label: '暴露分析层方法',
    old: "  uiSettings: () => ipcRenderer.invoke('monitor:ui-settings') as Promise<UiSettings>,",
    new: block + "  uiSettings: () => ipcRenderer.invoke('monitor:ui-settings') as Promise<UiSettings>,"
  },
  {
    file: 'src/preload/index.ts',
    label: 'import 类型',
    old: '  DockSide,\n  DockState,',
    new: '  ContractDiff,\n  ContractListRow,\n  ContractSummary,\n  DockSide,\n  DockState,'
  },
  {
    file: 'src/preload/index.ts',
    label: 'import 类型 2',
    old: '  EvaluateResult,\n  InstanceRow,',
    new: '  EndpointDetail,\n  EndpointPage,\n  EvaluateResult,\n  EventPage,\n  EventQuery,\n  EventStats,\n  ExportQuery,\n  HarExportReport,\n  InstanceRow,'
  },
  {
    file: 'src/preload/index.ts',
    label: 'import 类型 3',
    old: '  TimelineRow,\n  UiSettings\n} from \'../shared/types\'',
    new: '  JsonlExportReport,\n  RelationReport,\n  RequestGraph,\n  ResourceExportReport,\n  TimelineRow,\n  UiSettings,\n  WsConnectionRow,\n  WsFramePage,\n  WsFrameQuery\n} from \'../shared/types\''
  }
]