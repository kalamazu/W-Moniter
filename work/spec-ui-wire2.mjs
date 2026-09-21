export default [
  {
    file: 'F:/code/chrome/src/renderer/src/App.tsx',
    label: 'App 导入 4 个新面板',
    old: "import { EnvPanel } from './components/EnvPanel'\n",
    new: "import { EndpointsPanel } from './components/EndpointsPanel'\nimport { EnvPanel } from './components/EnvPanel'\nimport { EventsPanel } from './components/EventsPanel'\nimport { GraphPanel } from './components/GraphPanel'\n"
  },
  {
    file: 'F:/code/chrome/src/renderer/src/App.tsx',
    label: 'App renderPanel 补 4 个 case',
    old: "        case 'sessions':\n          return <SessionsPanel liveTick={liveTick} />\n",
    new: "        case 'sessions':\n          return <SessionsPanel liveTick={liveTick} />\n        case 'events':\n          return <EventsPanel liveTick={liveTick} />\n        case 'ws':\n          return <WsPanel />\n        case 'endpoints':\n          return <EndpointsPanel liveTick={liveTick} />\n        case 'graph':\n          return <GraphPanel liveTick={liveTick} />\n"
  },
  {
    file: 'F:/code/chrome/src/renderer/src/App.tsx',
    label: 'App 导入 WsPanel',
    old: "import { Waterfall } from './components/Waterfall'\n",
    new: "import { Waterfall } from './components/Waterfall'\nimport { WsPanel } from './components/WsPanel'\n"
  },
  {
    file: 'F:/code/chrome/src/renderer/src/components/EventsPanel.tsx',
    label: 'EventsPanel pausedRef 改到 effect 里同步',
    old: "  const listRef = useRef<HTMLDivElement | null>(null)\n  const pausedRef = useRef(false)\n\n  pausedRef.current = paused\n",
    new: "  const listRef = useRef<HTMLDivElement | null>(null)\n  const pausedRef = useRef(false)\n\n  // 轮询循环不该因为「暂停/继续」重建（重建会把已累积的行清掉），所以走 ref\n  useEffect(() => {\n    pausedRef.current = paused\n  }, [paused])\n"
  },
  {
    file: 'F:/code/chrome/src/renderer/src/components/EndpointsPanel.tsx',
    label: 'MiniCard tone 直通成 class',
    old: "      <b className={props.tone === 'err' ? 'err' : props.tone === 'warn' ? 'warn' : ''}>{props.value}</b>\n",
    new: "      <b className={props.tone ?? ''}>{props.value}</b>\n"
  }
]