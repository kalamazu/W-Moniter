/**
 * 单独验证 --remote-debugging-pipe 是否可用。
 *
 * 这是整个项目的关键假设：Chromium 从 fd 3 读、往 fd 4 写，
 * 父进程必须往 fd 3 写、从 fd 4 读。方向错了就完全不通。
 *
 * 用法: node scripts/probe-pipe.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const CANDIDATES =
  process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
      ]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium']

const executablePath = process.env.CHROME_PATH ?? CANDIDATES.find((p) => existsSync(p))
if (!executablePath) {
  console.error('找不到 Chromium 内核')
  process.exit(1)
}

const userDataDir = join(tmpdir(), 'cdp-pipe-probe')
mkdirSync(userDataDir, { recursive: true })

const NUL = 0x00
const args = [
  `--user-data-dir=${userDataDir}`,
  '--remote-debugging-pipe',
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1000,700',
  'about:blank'
]

console.log(`内核: ${executablePath}`)
const child = spawn(executablePath, args, {
  stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
  windowsHide: false
})

const toBrowser = child.stdio[3]
const fromBrowser = child.stdio[4]

child.stderr.on('data', (chunk) => {
  const text = chunk.toString().trim()
  if (text) console.log(`[chrome stderr] ${text}`)
})

let buffer = Buffer.alloc(0)
let nextId = 1
const pending = new Map()
const receivedMethods = new Map()

function send(method, params = {}, sessionId) {
  const id = nextId++
  const payload = Buffer.from(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  toBrowser.write(Buffer.concat([payload, Buffer.from([NUL])]))
  return new Promise((resolve) => pending.set(id, resolve))
}

fromBrowser.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  let index = buffer.indexOf(NUL)
  while (index !== -1) {
    const frame = buffer.subarray(0, index)
    buffer = buffer.subarray(index + 1)
    index = buffer.indexOf(NUL)
    if (frame.length === 0) continue
    let message
    try {
      message = JSON.parse(frame.toString('utf8'))
    } catch {
      continue
    }
    if (message.id !== undefined) {
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    } else if (message.method) {
      receivedMethods.set(message.method, (receivedMethods.get(message.method) ?? 0) + 1)
    }
  }
})

fromBrowser.on('error', (err) => console.error('读流错误:', err.message))

const timeout = setTimeout(() => {
  console.error('超时：没有收到任何响应，fd 方向可能不对')
  child.kill()
  process.exit(2)
}, 20_000)

try {
  const version = await send('Browser.getVersion')
  if (!version.result) {
    console.error('Browser.getVersion 失败:', JSON.stringify(version))
    process.exit(3)
  }
  console.log(`✓ pipe 通了`)
  console.log(`  product : ${version.result.product}`)
  console.log(`  jsVersion: ${version.result.jsVersion}`)

  const targets = await send('Target.getTargets')
  console.log(`✓ 拿到 ${targets.result.targetInfos.length} 个 target`)
  for (const info of targets.result.targetInfos) {
    console.log(`  [${info.type}] ${info.url.slice(0, 70)}`)
  }

  // 验证事件流：开 Network 后应该能收到事件
  const attach = await send('Target.attachToTarget', {
    targetId: targets.result.targetInfos.find((t) => t.type === 'page').targetId,
    flatten: true
  })
  const sessionId = attach.result.sessionId
  await send('Network.enable', {}, sessionId)
  await send('Page.navigate', { url: 'https://example.com' }, sessionId)
  await new Promise((resolve) => setTimeout(resolve, 4000))

  const networkEvents = [...receivedMethods.entries()].filter(([m]) => m.startsWith('Network.'))
  console.log(`✓ 收到 ${networkEvents.length} 种 Network 事件`)
  for (const [method, count] of networkEvents.slice(0, 8)) {
    console.log(`  ${method} × ${count}`)
  }

  if (receivedMethods.has('Network.requestWillBeSent')) {
    console.log('\n结论: pipe 传输 + 多 target 采集链路可用')
  } else {
    console.log('\n警告: 没有收到 requestWillBeSent，采集链路有问题')
  }
} finally {
  clearTimeout(timeout)
  child.kill()
}
