/** 代码围栏配平自检：markdown 里 ``` 的条数必须是偶数，否则渲染出来就是烂的 */
import { readFileSync } from 'node:fs'
let bad = 0
for (const file of process.argv.slice(2)) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  let count = 0
  const opens = []
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      count++
      if (count % 2 === 1) opens.push(i + 1)
    }
  })
  const ok = count % 2 === 0
  if (!ok) bad++
  console.log(`  ${ok ? '✓' : '✗'} ${file}：${count} 个围栏${ok ? '' : '（奇数，未闭合的最后一段从第 ' + opens[opens.length - 1] + ' 行开始）'}`)
}
process.exit(bad === 0 ? 0 : 1)