/**
 * 极简 JS 美化器。
 *
 * 为什么自己写而不是引第三方：看板的目标是「读得懂采集到的东西」，
 * 不是做 IDE。压缩后的 bundle 只要在 `;` 和 `{}` 处断行缩进就能读，
 * 而主流 beautifier（prettier / js-beautify）动辄几百 KB，
 * 塞进渲染进程只为了看几行源码不划算。
 *
 * 能力边界（诚实说明）：
 *   - 会正确跳过字符串（含模板串）、注释、正则字面量，不会把它们内部的内容当语法；
 *   - 不做 AST 级重排，不改变任何 token 的顺序，只插入换行和缩进；
 *   - `for(...)` 里的分号不会断行（靠括号深度判断）。
 */

type ScanState = 'code' | 'single' | 'double' | 'template' | 'line-comment' | 'block-comment' | 'regex'

/** 正则字面量判定：`/` 前一个有意义字符落在这些里面时，它是正则而不是除号 */
const REGEX_PRECEDERS = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>', '\n', ''
])

export function prettyPrint(source: string, indentSize = 2): string {
  const out: string[] = []
  let line = ''
  let depth = 0
  let parenDepth = 0
  let state: ScanState = 'code'
  let prevSignificant = ''

  const push = (text: string): void => {
    line += text
  }

  const newline = (delta = 0): void => {
    const trimmed = line.replace(/\s+$/, '')
    if (trimmed.length > 0) out.push(' '.repeat(Math.max(depth + delta, 0) * indentSize) + trimmed.trimStart())
    line = ''
  }

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    const next = source[i + 1]

    if (state === 'single' || state === 'double' || state === 'template') {
      push(ch)
      if (ch === '\\') {
        push(next ?? '')
        i += 1
        continue
      }
      if (
        (state === 'single' && ch === "'") ||
        (state === 'double' && ch === '"') ||
        (state === 'template' && ch === '`')
      ) {
        state = 'code'
        prevSignificant = ch
      }
      continue
    }

    if (state === 'line-comment') {
      if (ch === '\n') {
        state = 'code'
        newline()
      } else {
        push(ch)
      }
      continue
    }

    if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        push('*/')
        i += 1
        state = 'code'
        // 块注释后面通常紧跟代码，不断行反而更好读
        prevSignificant = '/'
      } else {
        push(ch)
        if (ch === '\n') newline()
      }
      continue
    }

    if (state === 'regex') {
      push(ch)
      if (ch === '\\') {
        push(next ?? '')
        i += 1
        continue
      }
      if (ch === '/') state = 'code'
      continue
    }

    // ---- code ----
    if (ch === '/' && next === '/') {
      push('//')
      i += 1
      state = 'line-comment'
      continue
    }
    if (ch === '/' && next === '*') {
      push('/*')
      i += 1
      state = 'block-comment'
      continue
    }
    if (ch === '/' && REGEX_PRECEDERS.has(prevSignificant)) {
      push('/')
      state = 'regex'
      continue
    }
    if (ch === "'" ) {
      push(ch)
      state = 'single'
      continue
    }
    if (ch === '"') {
      push(ch)
      state = 'double'
      continue
    }
    if (ch === '`') {
      push(ch)
      state = 'template'
      continue
    }

    if (ch === '\n') {
      newline()
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      // 折叠连续空白：压缩代码里可能有大量无意义空白
      if (line.length > 0 && !line.endsWith(' ')) push(' ')
      continue
    }

    if (ch === '(' || ch === '[') {
      parenDepth += 1
      push(ch)
      prevSignificant = ch
      continue
    }
    if (ch === ')' || ch === ']') {
      parenDepth = Math.max(0, parenDepth - 1)
      push(ch)
      prevSignificant = ch
      continue
    }

    if (ch === '{') {
      push('{')
      depth += 1
      newline()
      prevSignificant = ch
      continue
    }
    if (ch === '}') {
      newline()
      depth = Math.max(0, depth - 1)
      push('}')
      prevSignificant = ch
      continue
    }
    if (ch === ';' ) {
      push(';')
      if (parenDepth === 0) newline()
      prevSignificant = ch
      continue
    }

    push(ch)
    prevSignificant = ch
  }

  newline()
  return out.join('\n')
}

/** 压缩判定：平均行长超阈值就当它是压缩过的，默认自动美化的依据 */
export function looksMinified(source: string): boolean {
  const lines = source.split('\n')
  if (lines.length <= 1) return source.length > 200
  return source.length / lines.length > 200
}