import { readFileSync } from 'node:fs'
const routes = readFileSync('work/frag-control-routes.mjs', 'utf8')

export default [
  {
    file: 'control/server.mjs',
    label: 'import readFileSync',
    old: "import { mkdirSync, writeFileSync, rmSync } from 'node:fs'\nimport { join } from 'node:path'",
    new: "import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'\nimport { join } from 'node:path'"
  },
  {
    file: 'control/server.mjs',
    label: '新增路由与 SSE',
    old: '/* ------------------------------------------------------------- 匹配与分发 */',
    new: routes + '\n/* ------------------------------------------------------------- 匹配与分发 */'
  },
  {
    file: 'control/server.mjs',
    label: 'SSE 与导出下载的特殊处理',
    old: "  if (!authorized(req)) return send(res, 401, { ok: false, error: '缺少或错误的 token（Bearer）' })\n",
    new: [
      "  if (!authorized(req)) return send(res, 401, { ok: false, error: '缺少或错误的 token（Bearer）' })",
      '',
      "  // SSE 与文件下载要先于路由匹配：它们自己写响应头，不走 send() 那套 JSON 包装",
      "  if (pathname === '/events/stream' && req.method === 'GET') return streamEvents(req, res, url)",
      "  if (pathname === '/exports/download' && req.method === 'GET') {",
      "    // 导出目录里的纯文件名。这个口是给 agent 取 HAR / 资源包的，",
      "    // 不能因为图省事变成任意文件读取 —— 分隔符与 .. 一律拒绝",
      "    const name = url.searchParams.get('name') ?? ''",
      "    const base = join(DATA_DIR, 'exports')",
      "    const file = join(base, name)",
      "    if (!name || name.includes('/') || name.includes('\\\\') || name.includes('..') || !file.startsWith(base)) {",
      "      return send(res, 400, { ok: false, error: 'name 只能是导出目录下的文件名' })",
      '    }',
      '    try {',
      '      const data = readFileSync(file)',
      '      res.writeHead(200, {',
      "        'content-type': name.endsWith('.har') ? 'application/json; charset=utf-8' : 'application/octet-stream',",
      "        'content-length': data.length,",
      "        'cache-control': 'no-store'",
      '      })',
      '      return res.end(data)',
      '    } catch {',
      "      return send(res, 404, { ok: false, error: '没有这个导出文件：' + name })",
      '    }',
      '  }',
      ''
    ].join('\n')
  }
]