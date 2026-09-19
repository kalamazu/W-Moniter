import { existsSync } from 'node:fs'

const WINDOWS_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Chromium\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
]

const DARWIN_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'
]

const LINUX_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
]

/**
 * 按 CHROME_PATH 环境变量 → 平台常见路径 的顺序查找内核。
 * 找不到返回 null，由调用方给出可读错误。
 */
export function locateBrowser(): string | null {
  const override = process.env['CHROME_PATH']
  if (override && existsSync(override)) return override

  const candidates =
    process.platform === 'win32'
      ? WINDOWS_CANDIDATES
      : process.platform === 'darwin'
        ? DARWIN_CANDIDATES
        : LINUX_CANDIDATES

  return candidates.find((candidate) => existsSync(candidate)) ?? null
}
