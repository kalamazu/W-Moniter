#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2); const dataFlag = args.indexOf('--data-dir'); const dataDir = resolve(dataFlag >= 0 ? args.splice(dataFlag, 2)[1] : (process.env.MONITOR_DATA_DIR ?? '.userdata'))
const [action, workspaceId, inputText = '{}'] = args
if (!action || !workspaceId) { console.error('用法: node cli/monitor.mjs <action> <workspaceId> [input-json] [--data-dir <dir>]'); process.exit(2) }
try {
  const info = JSON.parse(await readFile(join(dataDir, 'control.json'), 'utf8')); const input = JSON.parse(inputText)
  const response = await fetch(`http://${info.host ?? '127.0.0.1'}:${info.port}/actions/execute`, { method: 'POST', headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action, input, target: { kind: 'workspace', workspaceId } }) })
  const result = await response.json(); process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  if (!response.ok || result?.task?.state === 'failed' || result?.task?.state === 'unknown') process.exitCode = 1
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }

