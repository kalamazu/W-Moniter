import { readFileSync } from 'node:fs'
const ipc = readFileSync('work/frag-ipc.mjs', 'utf8')

export default [
  {
    file: 'src/main/index.ts',
    label: 'IPC handler',
    old: "  ipcMain.handle('monitor:stats', async () => (await controller?.getStats()) ?? null)\n",
    new: "  ipcMain.handle('monitor:stats', async () => (await controller?.getStats()) ?? null)\n" + ipc
  },
  {
    file: 'src/main/index.ts',
    label: 'import 分析层类型',
    old: 'import type {\n  ConsoleEntry,\n  ControllerStatus,',
    new: 'import type {\n  ConsoleEntry,\n  ControllerStatus,\n  EventQuery,\n  ExportQuery,'
  },
  {
    file: 'src/main/index.ts',
    label: 'import WsFrameQuery',
    old: '  ScriptOrder,\n  ScriptQuery,\n  UiSettings\n} from \'../shared/types\'',
    new: '  ScriptOrder,\n  ScriptQuery,\n  UiSettings,\n  WsFrameQuery\n} from \'../shared/types\''
  }
]