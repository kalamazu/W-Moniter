/**
 * 定点改：spec 里每条给出 { file, label, old, new }，old 必须在文件里恰好命中一次。
 * 线尾按 LF 归一并原样写回（仓库里 src 是 CRLF，spec 里写 LF 就行）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const specPath = process.argv[2]
if (!specPath) {
  console.error('用法: node work/edit-apply.mjs <spec.mjs>')
  process.exit(2)
}
const edits = (await import(pathToFileURL(specPath).href)).default
if (!Array.isArray(edits) || edits.length === 0) {
  console.error('spec 里没有改动')
  process.exit(2)
}

let failed = 0
/** 同一个文件可能有多条改动：先攒在内存里，最后一起写 */
const files = new Map()
const load = (file) => {
  if (!files.has(file)) {
    const raw = readFileSync(file, 'utf8')
    const eol = raw.includes('\r\n') ? '\r\n' : '\n'
    files.set(file, { eol, text: raw.replace(/\r\n/g, '\n') })
  }
  return files.get(file)
}

for (const edit of edits) {
  const { file, old, new: next, label } = edit
  const slot = load(file)
  const hits = slot.text.split(old).length - 1
  if (hits !== 1) {
    console.log(`  ✗ ${label ?? ''} ${file}: old 命中 ${hits} 次（要恰好 1 次）`)
    failed++
    continue
  }
  slot.text = slot.text.replace(old, next)
  console.log(`  ✓ ${label ?? ''} ${file}`)
}

if (failed === 0) {
  for (const [file, slot] of files) {
    writeFileSync(file, slot.eol === '\r\n' ? slot.text.replace(/\n/g, '\r\n') : slot.text, 'utf8')
  }
  console.log(`  已写入 ${files.size} 个文件`)
}
process.exit(failed === 0 ? 0 : 1)