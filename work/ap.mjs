#!/usr/bin/env node
/**
 * 引导脚本：把补丁文件喂给 codex 的 apply_patch。
 *
 * 为什么不用 PowerShell 直接调：PS 5.1 往原生进程传「长 + 多行 + 大量引号」的
 * 参数时会在中途截断，apply_patch 会报 "The last line must be '*** End Patch'"。
 * Node 的 CreateProcess 参数转义是可靠的。
 *
 *   node work/ap.mjs <补丁文件>
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const CODEX = 'C:\\Users\\22478\\AppData\\Local\\OpenAI\\Codex\\bin\\12219cbfbcbddde7\\codex.exe'
const file = process.argv[2]
if (!file) {
  console.error('用法: node work/ap.mjs <补丁文件>')
  process.exit(2)
}

const patch = readFileSync(file, 'utf8')
if (!patch.trimEnd().endsWith('*** End Patch')) {
  console.error('补丁文件最后一行不是 *** End Patch，先修文件')
  process.exit(2)
}

try {
  const out = execFileSync(CODEX, ['--codex-run-as-apply-patch', patch], { encoding: 'utf8' })
  process.stdout.write(out)
} catch (err) {
  process.stdout.write(String(err.stdout ?? ''))
  process.stderr.write(String(err.stderr ?? ''))
  process.exit(err.status ?? 1)
}