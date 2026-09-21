import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DockSide, PanelId, PanelLayout, UiSettings } from '../../shared/types'

/**
 * 界面偏好（窗口吸附 + 工作区布局）。和 rules.json 一个套路：坏文件不能让应用起不来。
 * 单独一个文件而不是塞进 rules.json —— 规则文件是面板与验收脚本共用的接口，
 * 往里加 UI 偏好会把两件事的演化节奏绑死。
 */

const PANEL_IDS: ReadonlyArray<PanelId> = [
  'list',
  'waterfall',
  'detail',
  'scripts',
  'stats',
  'rules',
  'console',
  'env',
  'dom',
  'sessions',
  'events',
  'ws',
  'endpoints',
  'graph'
]

/** 窗格上限。再多就不叫「自由」了，叫没地方显示 */
export const MAX_PANES = 4

/** 默认布局 = 以前那个固定分栏的样子：左边请求列表，右边详情 */
const DEFAULT_LAYOUT: PanelLayout = { panes: ['list', 'detail'], sizes: [0.62, 0.38], dir: 'row' }

export function asPanelId(value: unknown): PanelId | null {
  return typeof value === 'string' && (PANEL_IDS as ReadonlyArray<string>).includes(value)
    ? (value as PanelId)
    : null
}

/**
 * 布局是用户一栏一栏摆出来的，坏一个字段就把整份丢掉太粗暴 —— 逐项修：
 * 不认识的面板剔掉、重复的去掉、占比归一化、栏数夹在 1..MAX_PANES。
 */
export function asLayout(value: unknown): PanelLayout {
  const raw = (value ?? {}) as Partial<PanelLayout>
  const panes: PanelId[] = []
  for (const item of Array.isArray(raw.panes) ? raw.panes : []) {
    const id = asPanelId(item)
    if (id && !panes.includes(id)) panes.push(id)
    if (panes.length >= MAX_PANES) break
  }
  if (panes.length === 0) {
    return { panes: [...DEFAULT_LAYOUT.panes], sizes: [...DEFAULT_LAYOUT.sizes], dir: 'row' }
  }

  const rawSizes = Array.isArray(raw.sizes) ? raw.sizes : []
  const weights = panes.map((_id, index) => {
    const size = Number(rawSizes[index])
    return Number.isFinite(size) && size > 0 ? size : 1
  })
  const total = weights.reduce((sum, size) => sum + size, 0)
  const sizes = weights.map((size) => Number((size / total).toFixed(4)))
  // 最后一位吸收四舍五入的零头，保证和正好是 1（渲染层不用再归一化一次）
  const head = sizes.slice(0, -1).reduce((sum, size) => sum + size, 0)
  sizes[sizes.length - 1] = Number((1 - head).toFixed(4))

  return { panes, sizes, dir: raw.dir === 'column' ? 'column' : 'row' }
}

export function defaultUiSettings(): UiSettings {
  return { dock: { enabled: false, side: 'right' }, layout: asLayout(null) }
}

export function readUiSettings(path: string, log: (line: string) => void = console.log): UiSettings {
  const fallback = defaultUiSettings()
  if (!existsSync(path)) return fallback
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<UiSettings>
    const dock = (parsed.dock ?? {}) as Partial<UiSettings['dock']>
    return {
      dock: {
        enabled: dock.enabled === true,
        side: dock.side === 'left' ? 'left' : 'right'
      },
      layout: asLayout(parsed.layout)
    }
  } catch (error) {
    log(`[ui] ${path} 解析失败，用默认界面设置：${(error as Error).message}`)
    return fallback
  }
}

export function writeUiSettings(path: string, settings: UiSettings): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(settings, null, 2), 'utf8')
}

export function asSide(value: unknown): DockSide {
  return value === 'left' ? 'left' : 'right'
}