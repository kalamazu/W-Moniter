export default [
  {
    file: 'F:/code/chrome/package.json',
    label: 'package.json 加 test:analytics',
    old: '    "test:layout": "node scripts/test-layout.mjs",\n',
    new: '    "test:layout": "node scripts/test-layout.mjs",\n    "test:analytics": "node scripts/test-analytics.mjs",\n'
  },
  {
    file: 'F:/code/chrome/src/main/window/settings.ts',
    label: 'settings.ts PANEL_IDS 补 4 个',
    old: "  'dom',\n  'sessions'\n]",
    new: "  'dom',\n  'sessions',\n  'events',\n  'ws',\n  'endpoints',\n  'graph'\n]"
  },
  {
    file: 'F:/code/chrome/src/renderer/src/components/PaneGrid.tsx',
    label: 'PaneGrid PANELS 补 4 个',
    old: "  { id: 'sessions', label: '\u4f1a\u8bdd' }\n]",
    new: "  { id: 'sessions', label: '\u4f1a\u8bdd' },\n  { id: 'events', label: '\u4e8b\u4ef6\u6d41' },\n  { id: 'ws', label: 'WebSocket' },\n  { id: 'endpoints', label: '\u63a5\u53e3\u753b\u50cf' },\n  { id: 'graph', label: '\u8c03\u7528\u56fe' }\n]"
  }
]