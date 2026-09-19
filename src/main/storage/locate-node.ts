import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * 存储进程需要系统 Node，且 **必须 >= 22.5**（node:sqlite 从 22.5 开始才有）。
 *
 * 为什么不用 Electron 自带的 Node：
 *   Electron 33 内置 Node 20.18，没有 node:sqlite；
 *   而 better-sqlite3 v13 的 prebuild 在 Electron 33 里加载即硬崩（实测 exit -36861），
 *   N-API 也救不了。详见 docs/技术方案.md §5.3。
 */

const MIN_MAJOR = 22
const MIN_MINOR = 5

export interface NodeCandidate {
  path: string
  version: string
}

const WINDOWS_CANDIDATES = [
  'C:\\Program Files\\nodejs\\node.exe',
  'C:\\Program Files (x86)\\nodejs\\node.exe',
  'C:\\ProgramData\\chocolatey\\bin\\node.exe',
  'C:\\Program Files\\nodejs\\node64.exe'
]

function versionCandidates(root: string): string[] {
  return [join(root, 'nodejs', 'node.exe'), join(root, 'node', 'node.exe')]
}

/** PATH 里逐个找，Windows 上还要补 .exe 后缀 */
function fromPath(): string[] {
  const raw = process.env['PATH'] ?? process.env['Path'] ?? ''
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  const found: string[] = []
  for (const dir of raw.split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, 'node' + ext)
      if (existsSync(candidate)) found.push(candidate)
    }
  }
  return found
}

function parseVersion(text: string): { major: number; minor: number } | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]) }
}

/**
 * 探测一个 node 是否可用：版本够 + node:sqlite 真的能加载。
 * 只报版本号是不够的 —— 有些发行版把 sqlite 编掉了。
 */
export function probeNode(nodePath: string, timeoutMs = 8000): Promise<NodeCandidate | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: NodeCandidate | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }

    let child
    try {
      child = spawn(
        nodePath,
        [
          '--no-warnings',
          '-e',
          "require('node:sqlite');process.stdout.write(process.versions.node)"
        ],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
      )
    } catch {
      done(null)
      return
    }

    let out = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退出了 */
      }
      done(null)
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
    })
    child.on('error', () => {
      clearTimeout(timer)
      done(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        done(null)
        return
      }
      const parsed = parseVersion(out)
      if (!parsed) {
        done(null)
        return
      }
      if (parsed.major < MIN_MAJOR || (parsed.major === MIN_MAJOR && parsed.minor < MIN_MINOR)) {
        done(null)
        return
      }
      done({ path: nodePath, version: out.trim() })
    })
  })
}

export interface LocateNodeResult {
  candidate: NodeCandidate | null
  tried: string[]
}

/**
 * 按「显式指定 → PATH → 常见安装路径」的顺序找，第一个能跑 node:sqlite 的胜出。
 */
export async function locateNode(): Promise<LocateNodeResult> {
  const ordered: string[] = []
  const push = (value: string | undefined | null): void => {
    if (value && !ordered.includes(value)) ordered.push(value)
  }

  push(process.env['MONITOR_NODE_PATH'])

  // 打包版自带一份 Node（见 docs/多会话监视器设计.md §4.1）：存储/代理/控制服务
  // 都是 node 子进程且要 node:sqlite，不能指望用户机器上装了 Node 22。
  // 开发态 process.resourcesPath 指向 electron/dist/resources，那里没有，等于跳过。
  if (process.resourcesPath) {
    for (const path of versionCandidates(process.resourcesPath)) push(path)
  }

  const programFiles = process.env['ProgramFiles']
  const programFilesX86 = process.env['ProgramFiles(x86)']
  const programData = process.env['ProgramData']
  const appData = process.env['APPDATA']
  const localAppData = process.env['LOCALAPPDATA']

  for (const path of fromPath()) push(path)
  for (const path of WINDOWS_CANDIDATES) push(path)

  if (programData) push(join(programData, 'chocolatey', 'bin', 'node.exe'))
  if (appData) push(join(appData, 'npm', 'node.exe'))
  if (localAppData) {
    for (const path of versionCandidates(join(localAppData, 'Programs'))) push(path)
    if (process.env['NVM_SYMLINK']) push(join(process.env['NVM_SYMLINK'], 'node.exe'))
    push(join(localAppData, 'fnm_multishells', 'node.exe'))
    push(join(localAppData, 'Volta', 'bin', 'node.exe'))
  }
  if (programFiles) for (const path of versionCandidates(programFiles)) push(path)
  if (programFilesX86) for (const path of versionCandidates(programFilesX86)) push(path)
  push('/usr/local/bin/node')
  push('/usr/bin/node')

  for (const candidate of ordered) {
    if (!existsSync(candidate)) continue
    const probed = await probeNode(candidate)
    if (probed) return { candidate: probed, tried: ordered }
  }

  return { candidate: null, tried: ordered }
}
