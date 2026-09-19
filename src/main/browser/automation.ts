import type { CdpClient } from './cdp'
import type { InputAction, InputReport } from '../../shared/types'

/**
 * 拟人化输入（设计文档 §6.4）。
 *
 * CDP 的 Input.dispatchMouseEvent 是「瞬间跳到目标点」—— 一次 mouseMoved 就落点。
 * 真人是贝塞尔曲线 + 变速 + 停顿 + 微抖动，高级风控专门看这个，所以轨迹得自己造。
 *
 * 三条纪律：
 *   1. 一次动作是一串 mouseMoved，不是一跳。人类 8ms 内挪不了三十几像素。
 *   2. 速度不是常数：慢-快-慢，每步还带噪声；途中偶发停顿。
 *   3. 终点必须精确落点 —— 抖动包络在两端收敛到 0，否则点不到元素。
 *
 * 随机数用 seed 播种（mulberry32）：行为验收要能重放同一条轨迹。
 */

interface Point {
  x: number
  y: number
}

/** mulberry32：小、快、可复现。同一个 seed 必须给出同一条轨迹 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

const KEYMAP: Record<string, { code: string; vk: number; shift: boolean }> = (() => {
  const map: Record<string, { code: string; vk: number; shift: boolean }> = {}
  for (let i = 0; i < 26; i += 1) {
    const lower = String.fromCharCode(97 + i)
    const upper = String.fromCharCode(65 + i)
    map[lower] = { code: 'Key' + upper, vk: 65 + i, shift: false }
    map[upper] = { code: 'Key' + upper, vk: 65 + i, shift: true }
  }
  for (let i = 0; i < 10; i += 1) {
    map[String(i)] = { code: 'Digit' + i, vk: 48 + i, shift: false }
  }
  const punct: Array<[string, string, number]> = [
    [' ', 'Space', 32],
    ['.', 'Period', 190],
    [',', 'Comma', 188],
    ['/', 'Slash', 191],
    ['-', 'Minus', 189],
    ['=', 'Equal', 187],
    [';', 'Semicolon', 186],
    ["'", 'Quote', 222],
    ['[', 'BracketLeft', 219],
    [']', 'BracketRight', 221],
    ['\\', 'Backslash', 220],
    ['`', 'Backquote', 192],
    ['\n', 'Enter', 13]
  ]
  for (const [ch, code, vk] of punct) map[ch] = { code, vk, shift: false }
  return map
})()

/** 键盘邻居表：要打错字就得按到旁边那个键，随机字符一眼假 */
const NEIGHBORS: Record<string, string> = {
  a: 's', b: 'v', c: 'x', d: 'f', e: 'r', f: 'g', g: 'h', h: 'j', i: 'o',
  j: 'k', k: 'l', l: 'k', m: 'n', n: 'm', o: 'p', p: 'o', q: 'w', r: 't',
  s: 'd', t: 'y', u: 'i', v: 'b', w: 'e', x: 'c', y: 'u', z: 'x'
}

const DEFAULT_JITTER = 1.2
const DEFAULT_SPEED = 1

interface Trajectory {
  points: Point[]
  /** 与 points 对齐：到达该点之后等多久再走下一步 */
  delays: number[]
  pauses: number
  straight: number
  pathLength: number
  maxStep: number
  minStep: number
  maxStepMs: number
  minStepMs: number
}

function bezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

export function buildTrajectory(
  from: Point,
  to: Point,
  rng: () => number,
  jitter: number,
  overshoot: boolean,
  speedMul: number,
  /** 视口尺寸；给了就把控制点夹在窗口内，整条弧线不出界 */
  bounds?: { w: number; h: number }
): Trajectory {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const straight = Math.hypot(dx, dy)
  const steps = Math.max(6, Math.min(170, Math.round(straight / 9)))

  const ux = straight > 0.001 ? dx / straight : 0
  const uy = straight > 0.001 ? dy / straight : 0
  const nx = -uy
  const ny = ux

  // 控制点带垂直偏移 → 轨迹是弧线而不是直线。两侧各偏一点更像手抖
  const bend1 = (rng() * 0.34 + 0.1) * (rng() < 0.5 ? -1 : 1)
  const bend2 = (rng() * 0.34 + 0.1) * (rng() < 0.5 ? -1 : 1)
  // 控制点夹进视口：三次贝塞尔整条落在四个控制点的凸包里，控制点在窗口内曲线就在窗口内。
  // 反过来，弧线一旦拐出窗口，那一段坐标页面收不到 mousemove，录下来就是个几百像素的跳步。
  const fit = (point: Point): Point => {
    if (!bounds) return point
    const inset = 2
    return {
      x: Math.min(Math.max(point.x, inset), Math.max(inset, bounds.w - inset)),
      y: Math.min(Math.max(point.y, inset), Math.max(inset, bounds.h - inset))
    }
  }
  const p1 = fit({
    x: from.x + dx * 0.32 + nx * straight * bend1,
    y: from.y + dy * 0.32 + ny * straight * bend1
  })
  const p2 = fit({
    x: from.x + dx * 0.68 + nx * straight * bend2,
    y: from.y + dy * 0.68 + ny * straight * bend2
  })

  // 速度曲线：两头慢中间快。dt 按速度放大 → 空间步长大 = 走得快
  const speed = (t: number): number => 0.16 + 1.9 * Math.sin(Math.PI * Math.pow(t, 0.82))

  const points: Point[] = [{ ...from }]
  let t = 0
  let guard = 0
  while (t < 1 && guard < 600) {
    guard += 1
    const dt = Math.min(1 - t, (1 / steps) * speed(t) * (0.7 + rng() * 0.7))
    t += dt
    const clamped = Math.min(1, t)
    const base = bezier(from, p1, p2, to, clamped)
    // 抖动包络：两端收敛到 0 —— 起点接得上上一次的位置，终点精确落点
    const env = Math.sin(Math.PI * clamped)
    const noise = (rng() - 0.5) * 2 * jitter * env
    points.push({ x: base.x + nx * noise, y: base.y + ny * noise })
  }

  // 过冲-回拉：真人点到目标附近常会多走一点再收回来
  if (overshoot && straight > 40 && rng() < 0.3) {
    const over = 3 + rng() * 9
    points.push(fit({ x: to.x + ux * over + nx * 1.5, y: to.y + uy * over + ny * 1.5 }))
  }
  points.push({ ...to })

  const baseDelay = 8.5 / Math.max(0.25, speedMul)
  const delays: number[] = []
  let pauses = 0
  for (let i = 0; i < points.length; i += 1) {
    let delay = baseDelay * (0.5 + rng() * 1.2)
    if (i > 0 && rng() < 0.05) {
      delay += 15 + rng() * 95
      pauses += 1
    }
    delays.push(delay)
  }

  let pathLength = 0
  let maxStep = 0
  let minStep = Number.POSITIVE_INFINITY
  for (let i = 1; i < points.length; i += 1) {
    const step = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
    pathLength += step
    if (step > maxStep) maxStep = step
    if (step < minStep) minStep = step
  }
  let maxStepMs = 0
  let minStepMs = Number.POSITIVE_INFINITY
  for (const delay of delays) {
    if (delay > maxStepMs) maxStepMs = delay
    if (delay < minStepMs) minStepMs = delay
  }

  return {
    points,
    delays,
    pauses,
    straight,
    pathLength,
    maxStep,
    minStep: Number.isFinite(minStep) ? minStep : 0,
    maxStepMs,
    minStepMs: Number.isFinite(minStepMs) ? minStepMs : 0
  }
}

function reportOf(
  kind: InputReport['kind'],
  trajectory: Trajectory,
  startedAt: number,
  landed: Point
): InputReport {
  return {
    kind,
    ok: true,
    points: trajectory.points.length,
    durationMs: Date.now() - startedAt,
    straight: round(trajectory.straight),
    pathLength: round(trajectory.pathLength),
    maxStep: round(trajectory.maxStep),
    minStep: round(trajectory.minStep),
    maxStepMs: round(trajectory.maxStepMs),
    minStepMs: round(trajectory.minStepMs),
    pauses: trajectory.pauses,
    landed: { x: round(landed.x), y: round(landed.y) }
  }
}

export class InputAutomation {
  /**
   * 光标位置要跨动作保持：鼠标不会瞬移回原点，连续两次点击的起点不一样。
   * 首次动作前是 null —— 真鼠标不可能正好停在窗口左上角 (0,0)：从角落起手既不像人，
   * 弧线也容易拐出窗口，而窗口外的坐标页面收不到事件，录下来的轨迹就会凭空多一个跳步。
   */
  private cursor: Point | null = null

  constructor(private readonly cdp: CdpClient) {}

  get position(): Point | null {
    return this.cursor ? { ...this.cursor } : null
  }

  /** 视口尺寸（CSS 像素）：坐标要约束在窗口内，页面才收得到事件 */
  private async viewport(sessionId: string | undefined): Promise<{ w: number; h: number }> {
    try {
      const metrics = (await this.cdp.send('Page.getLayoutMetrics', {}, sessionId)) as {
        cssLayoutViewport?: { clientWidth?: number; clientHeight?: number }
      }
      const vp = metrics?.cssLayoutViewport
      if (vp?.clientWidth && vp?.clientHeight) return { w: vp.clientWidth, h: vp.clientHeight }
    } catch {
      /* 拿不到就退到保守默认值 */
    }
    return { w: 1280, h: 720 }
  }

  /** 起手位置：不知道真实光标在哪，就当作停在窗口正中间 */
  private async origin(sessionId: string | undefined): Promise<Point> {
    if (this.cursor) return this.cursor
    const vp = await this.viewport(sessionId)
    return { x: Math.round(vp.w / 2), y: Math.round(vp.h / 2) }
  }

  async run(sessionId: string | undefined, action: InputAction): Promise<InputReport> {
    const started = Date.now()
    try {
      switch (action.kind) {
        case 'move':
          return await this.moveTo(sessionId, { x: action.x ?? 0, y: action.y ?? 0 }, action)
        case 'click':
          return await this.click(sessionId, { x: action.x ?? 0, y: action.y ?? 0 }, action)
        case 'type':
          return await this.typeText(sessionId, action.text ?? '', action)
        case 'scroll':
          return await this.scroll(sessionId, action.x, action.y, action.deltaY ?? 420, action)
        default:
          throw new Error('未知输入动作: ' + String((action as { kind?: unknown }).kind))
      }
    } catch (error) {
      return {
        kind: action.kind,
        ok: false,
        points: 0,
        durationMs: Date.now() - started,
        straight: 0,
        pathLength: 0,
        maxStep: 0,
        minStep: 0,
        maxStepMs: 0,
        minStepMs: 0,
        pauses: 0,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private async moveTo(
    sessionId: string | undefined,
    to: Point,
    action: InputAction
  ): Promise<InputReport> {
    const rng = makeRng(action.seed ?? (Date.now() ^ 0x9e3779b9) >>> 0)
    const from = await this.origin(sessionId)
    const trajectory = buildTrajectory(
      from,
      to,
      rng,
      action.jitter ?? DEFAULT_JITTER,
      action.overshoot !== false,
      action.speed ?? DEFAULT_SPEED,
      await this.viewport(sessionId)
    )
    const started = Date.now()
    let landed = from
    for (let i = 0; i < trajectory.points.length; i += 1) {
      const point = trajectory.points[i]
      await this.cdp.send(
        'Input.dispatchMouseEvent',
        {
          type: 'mouseMoved',
          x: point.x,
          y: point.y,
          button: 'none',
          buttons: 0,
          modifiers: 0,
          pointerType: 'mouse'
        },
        sessionId
      )
      this.cursor = point
      landed = point
      await sleep(trajectory.delays[i] ?? 0)
    }
    return reportOf('move', trajectory, started, landed)
  }

  private async click(
    sessionId: string | undefined,
    to: Point,
    action: InputAction
  ): Promise<InputReport> {
    const moves = await this.moveTo(sessionId, to, action)
    if (!moves.ok) return { ...moves, kind: 'click' }
    const rng = makeRng((action.seed ?? 1) ^ 0x5bf03635)
    const started = Date.now()
    // 移到位不是立刻按：人手有个几十毫秒的确认
    await sleep(35 + rng() * 110)
    await this.cdp.send(
      'Input.dispatchMouseEvent',
      {
        type: 'mousePressed',
        x: to.x,
        y: to.y,
        button: 'left',
        buttons: 1,
        clickCount: 1,
        pointerType: 'mouse'
      },
      sessionId
    )
    await sleep(28 + rng() * 70)
    await this.cdp.send(
      'Input.dispatchMouseEvent',
      {
        type: 'mouseReleased',
        x: to.x,
        y: to.y,
        button: 'left',
        buttons: 0,
        clickCount: 1,
        pointerType: 'mouse'
      },
      sessionId
    )
    this.cursor = { ...to }
    return { ...moves, kind: 'click', durationMs: moves.durationMs + (Date.now() - started) }
  }

  private async typeText(
    sessionId: string | undefined,
    text: string,
    action: InputAction
  ): Promise<InputReport> {
    const rng = makeRng(action.seed ?? 0x2f6e2b1)
    const speedMul = Math.max(0.25, action.speed ?? DEFAULT_SPEED)
    const started = Date.now()
    let keys = 0

    for (const ch of text) {
      // 词边界停一下，像人在想下一个词
      if (ch === ' ') await sleep((45 + rng() * 160) / speedMul)
      const info = KEYMAP[ch]
      if (info) {
        const modifiers = info.shift ? 8 : 0
        const common = {
          key: ch,
          code: info.code,
          windowsVirtualKeyCode: info.vk,
          nativeVirtualKeyCode: info.vk,
          modifiers
        }
        await this.cdp.send(
          'Input.dispatchKeyEvent',
          { type: 'keyDown', ...common, text: ch, unmodifiedText: ch },
          sessionId
        )
        await sleep(12 + rng() * 40)
        await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common }, sessionId)
      } else {
        await this.cdp.send(
          'Input.dispatchKeyEvent',
          { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch },
          sessionId
        )
        await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }, sessionId)
      }
      keys += 1
      await sleep((45 + rng() * 135) / speedMul)
      // 偶尔停一下再接着打：人在想下一个词、抬头看屏幕。等间距的节奏一眼假
      if (rng() < 0.07) await sleep((90 + rng() * 260) / speedMul)

      // 打错一个字再退格：低级但有效的「像人」信号
      const neighbour = NEIGHBORS[ch.toLowerCase()]
      if (neighbour && rng() < 0.025) {
        const vk = neighbour.toUpperCase().charCodeAt(0)
        const code = 'Key' + neighbour.toUpperCase()
        await this.cdp.send(
          'Input.dispatchKeyEvent',
          {
            type: 'keyDown',
            key: neighbour,
            code,
            text: neighbour,
            unmodifiedText: neighbour,
            windowsVirtualKeyCode: vk,
            nativeVirtualKeyCode: vk
          },
          sessionId
        )
        await this.cdp.send(
          'Input.dispatchKeyEvent',
          { type: 'keyUp', key: neighbour, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk },
          sessionId
        )
        await sleep(70 + rng() * 120)
        await this.backspace(sessionId)
        await sleep(60 + rng() * 90)
      }
    }

    return {
      kind: 'type',
      ok: true,
      points: 0,
      durationMs: Date.now() - started,
      straight: 0,
      pathLength: 0,
      maxStep: 0,
      minStep: 0,
      maxStepMs: 0,
      minStepMs: 0,
      pauses: 0,
      text,
      keys
    }
  }

  private async backspace(sessionId: string | undefined): Promise<void> {
    const params = {
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8
    }
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...params }, sessionId)
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params }, sessionId)
  }

  private async scroll(
    sessionId: string | undefined,
    x: number | undefined,
    y: number | undefined,
    deltaY: number,
    action: InputAction
  ): Promise<InputReport> {
    const rng = makeRng(action.seed ?? 0x7a1c0de)
    // 先移到落点：滚轮事件带坐标，落点不对可能滚错容器。
    // 没给坐标就滚在光标当前所在处；光标还没动过就是窗口正中
    const at = await this.origin(sessionId)
    const spot = { x: x ?? at.x, y: y ?? at.y }
    const moved = await this.moveTo(sessionId, spot, { ...action, overshoot: false })
    if (!moved.ok) return { ...moved, kind: 'scroll' }
    const started = Date.now()
    const speedMul = Math.max(0.25, action.speed ?? DEFAULT_SPEED)
    let ticks = 0
    let remaining = deltaY
    while (Math.abs(remaining) > 1 && ticks < 80) {
      const chunk = Math.sign(remaining) * Math.min(Math.abs(remaining), 40 + rng() * 90)
      remaining -= chunk
      await this.cdp.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseWheel', x: spot.x, y: spot.y, deltaX: 0, deltaY: chunk, pointerType: 'mouse' },
        sessionId
      )
      ticks += 1
      await sleep((16 + rng() * 85) / speedMul)
      if (rng() < 0.12) await sleep(60 + rng() * 180)
    }
    return {
      ...moved,
      kind: 'scroll',
      durationMs: moved.durationMs + (Date.now() - started),
      scrollTicks: ticks
    }
  }
}