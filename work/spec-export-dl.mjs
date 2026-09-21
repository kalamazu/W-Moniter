const SM = 'F:/code/chrome/scripts/test-smoke.mjs'
const API = 'F:/code/chrome/docs/AI-控制面.md'
const MAN = 'F:/code/chrome/docs/使用手册.md'
export default [
  {
    file: SM,
    label: '导出下载用 name（纯文件名），并把两条手写路由记进覆盖集',
    old: `  const exportDownload = await fetch(base + '/exports/download?path=' + encodeURIComponent(harOut.body.path), { headers: auth })`,
    new: `  // 这个口只收「导出目录下的纯文件名」：带分隔符或 .. 一律 400（不是任意文件读取）
  const harName = harOut.body.path.split(/[\\\\/]/).pop()
  hitRoutes.add('GET /exports/download')
  const exportDownload = await fetch(base + '/exports/download?name=' + encodeURIComponent(harName), { headers: auth })`
  },
  {
    file: SM,
    label: 'SSE 也记进覆盖集',
    old: `      const res = await fetch(base + '/events/stream?interval=300&since=0', { headers: auth, signal: ctrl.signal })`,
    new: `      hitRoutes.add('GET /events/stream')
      const res = await fetch(base + '/events/stream?interval=300&since=0', { headers: auth, signal: ctrl.signal })`
  },
  {
    file: API,
    label: 'AI 控制面：下载口参数名与语义写对',
    old: `导出的文件可以用 \`GET /exports/download?path=<绝对路径>\` 取回（只允许 \`exports/\` 里的文件，
免得 \`path\` 变成一个任意文件读取的口子）。`,
    new: `导出的文件可以用 \`GET /exports/download?name=<文件名>\` 取回。**只收导出目录下的纯文件名**：
带路径分隔符、带 \`..\` 一律 400 —— 图省事收「路径」的话，这个口就变成任意文件读取了。`
  },
  {
    file: API,
    label: 'AI 控制面：路由表里的下载口描述',
    old: `| GET | \`/exports/download\` | 取回 \`exports/\` 下已经导出的文件（见 §3.3，只允许该目录里的文件） |`,
    new: `| GET | \`/exports/download?name=\` | 取回 \`exports/\` 下已经导出的文件；只收纯文件名（见 §3.3） |`
  },
  {
    file: MAN,
    label: '使用手册：下载口描述',
    old: `| \`/exports/download\` | 取回 \`exports/\` 下已导出的文件（\`?path=\`，只允许该目录内） |`,
    new: `| \`/exports/download\` | 取回 \`exports/\` 下已导出的文件（\`?name=<文件名>\`，只收纯文件名） |`
  }
]