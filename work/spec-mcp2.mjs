import { readFileSync } from 'node:fs'
const tools = readFileSync('work/frag-mcp-tools.mjs', 'utf8')

export default [
  {
    file: 'mcp/server.mjs',
    label: '追加工具',
    old: "  {\n    name: 'monitor_clear',\n    description: '清空本次会话的采集缓冲（不动已落盘的历史）。',\n    inputSchema: { type: 'object', properties: {}, additionalProperties: false },\n    run: () => request('POST', '/clear')\n  }\n]",
    new: "  {\n    name: 'monitor_clear',\n    description: '清空本次会话的采集缓冲（不动已落盘的历史）。',\n    inputSchema: { type: 'object', properties: {}, additionalProperties: false },\n    run: () => request('POST', '/clear')\n  },\n" + tools
  }
]