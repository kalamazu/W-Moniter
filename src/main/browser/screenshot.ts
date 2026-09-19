import type { CdpClient } from './cdp'
import type { ScreenshotOptions } from '../../shared/types'

/**
 * 截图（§7.1 #3 的延伸）：把整页 / 视口 / 某个元素截成 PNG 或 JPEG。
 *
 * 只读操作：不发输入事件、不改页面状态（Overlay 那套会画东西，这里纯截）。
 * 页面侧看不到任何新东西 —— 走的还是 Page domain，采集本来就已经开了它。
 */

/** 全页截图在长页面上能到几万像素，超过这个高度就截断，并在结果里标 clamped */
const MAX_CAPTURE_HEIGHT = 16000

interface LayoutMetrics {
  pageX: number
  pageY: number
  viewportWidth: number
  viewportHeight: number
  contentWidth: number
  contentHeight: number
}

interface RawBoxModel {
  content?: number[]
  border?: number[]
  padding?: number[]
  margin?: number[]
}

interface RawLayoutMetrics {
  cssVisualViewport?: { pageX?: number; pageY?: number; clientWidth?: number; clientHeight?: number }
  cssContentSize?: { width?: number; height?: number }
  visualViewport?: { pageX?: number; pageY?: number; clientWidth?: number; clientHeight?: number }
  contentSize?: { width?: number; height?: number }
}

export interface CapturedImage {
  /** base64（不带 data: 前缀） */
  data: string
  /** 实际编码格式（决定落盘扩展名与 MIME） */
  format: 'png' | 'jpeg'
  width: number
  height: number
  /** 全页截图被 MAX_CAPTURE_HEIGHT 截断过 */
  clamped: boolean
}

/** 从字节里读真实像素尺寸。不用 CDP 报的尺寸 —— 那段是 CSS 像素，devicePixelRatio 会骗人 */
function pngSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null
  if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function jpegSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < buffer.length) {
    if (buffer[i] !== 0xff) {
      i++
      continue
    }
    const marker = buffer[i + 1] as number
    // SOF0..SOF15，但 C4/C8/CC 是 DHT/JPG/DAC，不是尺寸段
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) }
    }
    const length = buffer.readUInt16BE(i + 2)
    if (length < 2) return null
    i += 2 + length
  }
  return null
}

export function imageSize(
  buffer: Buffer,
  format: 'png' | 'jpeg'
): { width: number; height: number } | null {
  return format === 'jpeg' ? jpegSize(buffer) : pngSize(buffer)
}

export class Screenshotter {
  /** 这个会话已经 enable 过哪些 domain（Page / DOM），重复 enable 无害但没必要 */
  private readonly enabled = new Set<string>()

  constructor(private readonly cdp: CdpClient) {}

  clear(): void {
    this.enabled.clear()
  }

  private async ensure(sessionId: string, domains: string[]): Promise<void> {
    for (const domain of domains) {
      const key = sessionId + '\u0000' + domain
      if (this.enabled.has(key)) continue
      await this.cdp.send(domain + '.enable', {}, sessionId)
      this.enabled.add(key)
    }
  }

  private async metrics(sessionId: string): Promise<LayoutMetrics> {
    const raw = (await this.cdp.send('Page.getLayoutMetrics', {}, sessionId)) as RawLayoutMetrics
    const viewport = raw.cssVisualViewport ?? raw.visualViewport ?? {}
    const content = raw.cssContentSize ?? raw.contentSize ?? {}
    return {
      pageX: viewport.pageX ?? 0,
      pageY: viewport.pageY ?? 0,
      viewportWidth: Math.round(viewport.clientWidth ?? 0),
      viewportHeight: Math.round(viewport.clientHeight ?? 0),
      contentWidth: Math.ceil(content.width ?? viewport.clientWidth ?? 0),
      contentHeight: Math.ceil(content.height ?? viewport.clientHeight ?? 0)
    }
  }

  /**
   * 元素的几何：先 DOM.getContentQuads（inline 元素、被裁掉一部分的元素也只有它给得全），
   * 拿不到再退回 DOM.getBoxModel。两条都空就说明这个节点真没有布局（display:none 之类）。
   */
  private async elementQuad(sessionId: string, nodeId: number): Promise<number[]> {
    try {
      const raw = (await this.cdp.send('DOM.getContentQuads', { nodeId }, sessionId)) as {
        quads?: number[][]
      }
      const quad = raw.quads?.find((item) => Array.isArray(item) && item.length >= 8)
      if (quad) return quad
    } catch {
      /* 落到 getBoxModel */
    }
    const model = (await this.cdp.send('DOM.getBoxModel', { nodeId }, sessionId)) as RawBoxModel
    const quad = model.border ?? model.content ?? model.padding ?? model.margin
    if (!quad || quad.length < 8) {
      throw new Error(`节点 ${nodeId} 没有可截图的几何（display:none 或零尺寸）`)
    }
    return quad
  }
  async capture(sessionId: string, options: ScreenshotOptions = {}): Promise<CapturedImage> {
    const format: 'png' | 'jpeg' = options.format === 'jpeg' ? 'jpeg' : 'png'
    await this.ensure(sessionId, ['Page'])

    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined
    let clamped = false

    if (options.nodeId !== undefined) {
      await this.ensure(sessionId, ['DOM'])
      const layout = await this.metrics(sessionId)
      const quad = await this.elementQuad(sessionId, options.nodeId)
      const xs = [quad[0], quad[2], quad[4], quad[6]] as number[]
      const ys = [quad[1], quad[3], quad[5], quad[7]] as number[]
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      // getBoxModel 给的是视口坐标；截图 clip 要的是文档坐标，得把滚动量加回去
      clip = {
        x: x + layout.pageX,
        y: y + layout.pageY,
        width: Math.max(1, Math.max(...xs) - x),
        height: Math.max(1, Math.max(...ys) - y),
        scale: 1
      }
    } else if (options.fullPage) {
      const layout = await this.metrics(sessionId)
      const height = Math.max(1, Math.min(layout.contentHeight || layout.viewportHeight, MAX_CAPTURE_HEIGHT))
      clamped = layout.contentHeight > MAX_CAPTURE_HEIGHT
      clip = { x: 0, y: 0, width: Math.max(1, layout.contentWidth), height, scale: 1 }
    }

    const quality = Math.min(100, Math.max(1, Math.round(options.quality ?? 80)))
    const result = (await this.cdp.send(
      'Page.captureScreenshot',
      {
        format,
        ...(format === 'jpeg' ? { quality } : {}),
        // 只有全页 / 元素截图才给 clip；视口截图不给，拿到的就是屏幕上真实的这一屏
        ...(clip ? { clip, captureBeyondViewport: true } : {}),
        fromSurface: true
      },
      sessionId
    )) as { data?: string }

    const data = result?.data
    if (!data) throw new Error('截图没有返回数据')
    const buffer = Buffer.from(data, 'base64')
    const size = imageSize(buffer, format)
    return {
      data,
      format,
      width: size?.width ?? Math.round(clip?.width ?? 0),
      height: size?.height ?? Math.round(clip?.height ?? 0),
      clamped
    }
  }
}