import { app } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 运行期资源（control / mcp / storage / proxy）的位置随运行方式而变：
 *   - 开发 / 直接跑 out/main：__dirname 是 out/main，项目根在上两级
 *   - 打包后：这几个目录走 extraResources 落在 process.resourcesPath 下
 *     —— **必须在 asar 之外**，子进程 spawn 不了 asar 里的文件
 * 挨个试，第一个真实存在的胜出。
 *
 * 为什么不用 app.getAppPath() 直接拼：打包后它返回 .../resources/app.asar，
 * 而 Electron 的 asar 补丁会让 existsSync('app.asar/...') 对**打进 asar 的文件**也返回 true，
 * 于是「存在」但 spawn 必然失败 —— 这种情况只能靠「不打进 asar」来避免。
 */
export function resolveRuntimeDir(name: string): string | null {
  const candidates = [join(__dirname, '..', '..', name), join(app.getAppPath(), name)]
  if (process.resourcesPath) candidates.push(join(process.resourcesPath, name))
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

/** 取运行期资源里的一个具体文件，不存在返回 null（调用方据此给明确报错） */
export function resolveRuntimeFile(dir: string, file: string): string | null {
  const base = resolveRuntimeDir(dir)
  if (!base) return null
  const full = join(base, file)
  return existsSync(full) ? full : null
}

/**
 * 装着这几个子进程目录的「根」。开发态是项目根，打包态是 resources。
 * 给 ControlBridge 这类「以根为基准拼子目录」的调用方用。
 */
export function resolveRuntimeRoot(): string {
  const probe = resolveRuntimeDir('control') ?? resolveRuntimeDir('storage')
  return probe ? dirname(probe) : join(__dirname, '..', '..')
}