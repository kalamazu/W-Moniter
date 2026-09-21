const fs = require('fs')
const s = fs.readFileSync('F:/code/chrome/scripts/test-smoke.mjs', 'utf8')
const head = s.slice(0, s.indexOf('MCP：42 个工具逐个真调用'))
const calls = [...head.matchAll(/api\(\s*'([A-Z]+)'\s*,\s*(`[^`]*`|'[^']*')/g)].map((m) => m[1] + ' ' + m[2].replace(/[`']/g, ''))
const raw = [...head.matchAll(/fetch\(base \+ '([^']+)'/g)].map((m) => 'GET ' + m[1])
const paths = [...new Set([...calls, ...raw].map((x) => x.replace(/\?.*$/, '')))]
console.log('HTTP 段覆盖：' + paths.length)
paths.forEach((p) => console.log('  ' + p))