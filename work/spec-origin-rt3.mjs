import { readFileSync } from 'node:fs'

const P = 'F:/code/chrome/scripts/test-origin.mjs'
const oldPage = readFileSync('F:/code/chrome/work/frag-rt-page.html', 'utf8')
const newPage = readFileSync('F:/code/chrome/work/frag-rt-page2.html', 'utf8')

const ROUTES = [
  '      if (parsed && parsed.extra) payload.bonus = { deep: true }',
  "      return send(200, 'application/json', JSON.stringify(payload))",
  '    }',
  '',
  '    // 与 json-echo 共用同一个 token：关联分析要看得见「同值参数跨端点」',
  "    if (path === '/api/json-echo-b') {",
  "      return send(200, 'application/json', JSON.stringify({ ok: true, name: 'json-echo-b' }))",
  '    }',
  '',
  '    // 固定正文：两个不同 URL 拿到同一份字节 —— 共享响应体（重复资源）的靶子',
  "    if (path === '/api/dup-body.json') {",
  "      return send(200, 'application/json', DUP_BODY)",
  '    }'
].join('\n')

export default [
  {
    file: P,
    label: 'origin 换掉实时页（3 次调用 / 第二端点 / 重复正文 / 跨域图 / 下载）',
    old: 'const RT_PAGE = `' + oldPage + '`',
    new: 'const RT_PAGE = `' + newPage + '`'
  },
  {
    file: P,
    label: 'origin 加 DUP_BODY 常量',
    old: "const DUP_JS = 'window.__dup = (window.__dup || 0) + 1\\n'",
    new: "const DUP_JS = 'window.__dup = (window.__dup || 0) + 1\\n'\n\n/** 固定正文：不管谁来取、取几次，字节完全一致 —— 用来验「共享响应体」 */\nconst DUP_BODY = JSON.stringify({ kind: 'dup-body', note: 'same bytes every time', pad: 'z'.repeat(120) })"
  },
  {
    file: P,
    label: 'origin 加 json-echo-b 与 dup-body 路由',
    old: [
      '      if (parsed && parsed.extra) payload.bonus = { deep: true }',
      "      return send(200, 'application/json', JSON.stringify(payload))",
      '    }'
    ].join('\n'),
    new: ROUTES
  }
]