#!/usr/bin/env node
/**
 * 自由工作区验收（§自由工作区：1–4 栏 / 每栏选面板 / 可拖分隔条 / 布局落盘）。
 *
 * 判据来自两头：渲染进程里真实的 DOM 几何（getBoundingClientRect）和落盘文件
 * （ui-settings.json）。不读组件内部 state —— 那是拿实现去判实现。
 *
 * 交互用合成鼠标事件（mousedown → mousemove… → mouseup）：分隔条上挂的是 React
 * 的委托监听、拖动过程挂在 window 上，合成事件走的就是用户手拖那一条路。
 *
 * 三起三落：
 *   第 1 次（?tab=list）—— 默认布局、拖动、双击均分、下限、关栏、加分栏、换面板、换方向、复位、落盘
 *   第 2 次（无 ?tab=）—— 重启后恢复上次摆的布局
 *   第 3 次（无 ?tab=）—— 旧版只有 dock 的 ui-settings.json 自动补默认布局，不崩
 *
 * 注意：真实窗口，跑的时候别去碰鼠标，否则合成事件和真鼠标会打架。
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, makeChecker, sleep } from './app-harness.mjs'
import { startOrigin } from './test-origin.mjs'

const PORT = 9721
/** PaneGrid.tsx 里的下限，两边必须一致 */
const MIN_PANE_PX = 160

const { check, assert, report } = makeChecker()
const dataDir = mkdtempSync(join(tmpdir(), 'layout-'))
const settingsPath = join(dataDir, 'ui-settings.json')
const quitFile = join(dataDir, 'quit.txt')
const quitFile2 = join(dataDir, 'quit2.txt')
const quitFile3 = join(dataDir, 'quit3.txt')
const origin = await startOrigin(0)
console.log('  数据目录 ' + dataDir)

const readSettings = () => {
  if (!existsSync(settingsPath)) return null
  try {
    return JSON.parse(readFileSync(settingsPath, 'utf8'))
  } catch {
    return null
  }
}

/* ------------------------------------------------ 渲染进程里的取数与交互 */

/** 一屏读全：栏数、方向、每栏选的面板、几何、flex-grow、顶栏按钮状态 */
const SNAP = `(() => {
  const box = document.querySelector('.panes')
  if (!box) return { ok: false, reason: 'no-panes' }
  const panes = Array.from(box.children).filter((el) => el.classList.contains('pane'))
  const rect = box.getBoundingClientRect()
  const topTabs = Array.from(document.querySelectorAll('[aria-label="布局操作"] .tab'))
  const addBtn = topTabs.find((b) => b.textContent.indexOf('分栏') >= 0)
  return {
    ok: true,
    dir: box.classList.contains('panes-column') ? 'column' : 'row',
    boxW: rect.width,
    boxH: rect.height,
    splitCount: box.querySelectorAll('.pane-split').length,
    addDisabled: addBtn ? addBtn.disabled : null,
    topTabs: topTabs.map((b) => b.textContent.trim()),
    panes: panes.map((el) => {
      const r = el.getBoundingClientRect()
      const pick = el.querySelector('.pane-pick')
      const body = el.querySelector('.pane-body')
      return {
        pick: pick ? pick.value : null,
        // 栏头下拉框里列出的面板名 —— 「瀑布图 / 统计那些去哪了」就靠它兜底
        options: pick ? Array.from(pick.options).map((o) => o.textContent.trim()) : [],
        w: r.width,
        h: r.height,
        left: r.left,
        top: r.top,
        grow: Number(el.style.flexGrow),
        closer: !!el.querySelector('.pane-act'),
        bodyClass: body && body.firstElementChild ? body.firstElementChild.className : ''
      }
    })
  }
})()`

/** 合成一次拖分隔条：mousedown → 12 步 mousemove → mouseup，返回拖动中/后的 body 类 */
const DRAG = (splitIndex, dx, dy) => `(async () => {
  const frame = () => new Promise((r) => setTimeout(r, 16))
  const box = document.querySelector('.panes')
  if (!box) return { ok: false, reason: 'no-panes' }
  const split = Array.from(box.querySelectorAll('.pane-split'))[${splitIndex}]
  if (!split) return { ok: false, reason: 'no-split' }
  const r = split.getBoundingClientRect()
  const x = r.left + r.width / 2
  const y = r.top + r.height / 2
  const fire = (type, cx, cy, target) =>
    (target || window).dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: cy, buttons: 1 })
    )
  fire('mousedown', x, y, split)
  await frame()
  const midClass = document.body.className
  for (let i = 1; i <= 12; i++) {
    fire('mousemove', x + ${dx} * i / 12, y + ${dy} * i / 12)
    await frame()
  }
  fire('mouseup', x + ${dx}, y + ${dy})
  await frame()
  await frame()
  return { ok: true, midClass, afterClass: document.body.className }
})()`

const findTab = (text) => `Array.from(document.querySelectorAll('[aria-label="布局操作"] .tab')).find((b) => b.textContent.indexOf(${JSON.stringify(text)}) >= 0)`

/** 顶栏按钮：＋ 分栏 / ⇔ 左右 / ⟲ 复位 */
const CLICK_TAB = (text) => `(() => {
  const btn = ${findTab(text)}
  if (!btn) return { ok: false, reason: 'no-tab' }
  const disabled = btn.disabled
  if (!disabled) btn.click()
  return { ok: true, disabled }
})()`

const DBLCLICK_SPLIT = (index) => `(() => {
  const box = document.querySelector('.panes')
  if (!box) return { ok: false, reason: 'no-panes' }
  const split = Array.from(box.querySelectorAll('.pane-split'))[${index}]
  if (!split) return { ok: false, reason: 'no-split' }
  split.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
  return { ok: true }
})()`

const PICK_PANEL = (index, value) => `(() => {
  const box = document.querySelector('.panes')
  if (!box) return { ok: false, reason: 'no-panes' }
  const pane = Array.from(box.children).filter((el) => el.classList.contains('pane'))[${index}]
  if (!pane) return { ok: false, reason: 'no-pane' }
  const sel = pane.querySelector('.pane-pick')
  if (!sel) return { ok: false, reason: 'no-pick' }
  sel.value = ${JSON.stringify(value)}
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true }
})()`

const CLOSE_PANE = (index) => `(() => {
  const box = document.querySelector('.panes')
  if (!box) return { ok: false, reason: 'no-panes' }
  const pane = Array.from(box.children).filter((el) => el.classList.contains('pane'))[${index}]
  if (!pane) return { ok: false, reason: 'no-pane' }
  const btn = pane.querySelector('.pane-act')
  if (!btn) return { ok: false, reason: 'no-closer' }
  btn.click()
  return { ok: true }
})()`

/* --------------------------------------------------------------- 驱动 */

const launch = (quit, tab) =>
  launchApp({
    url: 'http://127.0.0.1:' + origin.port + '/',
    dataDir,
    port: PORT,
    tab,
    extraEnv: { MONITOR_QUIT_FILE: quit }
  })

/** 体面退出：让主进程走完 shutdown，再重起 */
const restart = async (from, quit) => {
  writeFileSync(quit, '')
  await sleep(6000)
  from.cdp.close()
  await from.close()
  await sleep(1200)
}

let app = await launch(quitFile, 'list')
await app.waitConnected(1)

/** 等 .panes 挂上（React 首帧之前查一次就判死是最经典的假失败） */
const snap = async (label) => {
  for (let i = 0; i < 80; i++) {
    const state = await app.evaluate(SNAP)
    if (state && state.ok) return state
    await sleep(250)
  }
  throw new Error('等不到工作区渲染出来：' + label)
}

const picksOf = (state) => state.panes.map((pane) => pane.pick)
const ratioOf = (a, b) => a / (a + b)

/* ------------------------------------------------- A 默认布局 */

let s = await snap('默认布局')

check('A1 默认是「列表 + 详情」两栏、左右排、一条分隔条', () => {
  assert(s.dir === 'row', '方向应为 row，实际 ' + s.dir)
  assert(s.panes.length === 2, '应有 2 栏，实际 ' + s.panes.length)
  assert(s.splitCount === 1, '应有 1 条分隔条，实际 ' + s.splitCount)
  assert(picksOf(s).join(',') === 'list,detail', '面板应为 list,detail，实际 ' + picksOf(s).join(','))
})

check('A2 两栏宽度比就是默认的 0.62 / 0.38', () => {
  const ratio = ratioOf(s.panes[0].w, s.panes[1].w)
  assert(Math.abs(ratio - 0.62) < 0.02, `左栏占比 ${ratio.toFixed(4)}，期望 0.62`)
})

check('A3 顶栏是「＋ 分栏 / ⇔ 左右 / ⟲ 复位」三个按钮', () => {
  assert(s.topTabs.length === 3, '顶栏按钮数不对：' + s.topTabs.join(' | '))
  assert(s.topTabs[0].indexOf('分栏') >= 0, '第一个应是分栏：' + s.topTabs[0])
  assert(s.topTabs[1].indexOf('左右') >= 0, '第二个应是换方向：' + s.topTabs[1])
  assert(s.topTabs[2].indexOf('复位') >= 0, '第三个应是复位：' + s.topTabs[2])
})

check('A4 栏头下拉框列全了十五个面板（瀑布图 / 统计 / 会话 / 实时分析四个 / 站点资源都在这）', () => {
  const ALL = ['瀑布图', '统计', '会话', '环境', 'DOM', '脚本', '规则', '控制台', '请求列表', '请求详情', '事件流', 'WebSocket', '接口画像', '调用图', '站点资源']
  const options = s.panes[0].options
  assert(options.length === ALL.length, '选项数应为 ' + ALL.length + '，实际 ' + options.length + '：' + options.join('/'))
  for (const name of ALL) {
    assert(options.includes(name), '下拉框里少了「' + name + '」')
  }
  assert(s.panes[1].options.length === ALL.length, '每一栏的下拉框都该是同一份全量列表')
})

/* ------------------------------------------------- B 拖动分隔条 */

const boxW = s.boxW
const w0Before = s.panes[0].w
const w1Before = s.panes[1].w
const dragged = await app.evaluate(DRAG(0, 120, 0))
check('B0 分隔条收下了 mousedown 并进了拖动态', () => {
  assert(dragged.ok, '拖动没起来：' + String(dragged.reason))
  assert(dragged.midClass.indexOf('is-col-resize') >= 0,
    '拖动中 body 应有 is-col-resize，实际 "' + dragged.midClass + '"')
  assert(dragged.afterClass.indexOf('is-col-resize') < 0, '松手后没清掉 is-col-resize')
})

await sleep(200)
let after = await snap('拖动之后')

check('B1 往右拖 120px → 左栏宽了约 120px、右栏窄了约 120px（总宽不变）', () => {
  const dw0 = after.panes[0].w - w0Before
  const dw1 = after.panes[1].w - w1Before
  assert(Math.abs(dw0 - 120) <= 5, `左栏变化 ${dw0.toFixed(1)}px，期望 ≈120`)
  assert(Math.abs(dw1 + 120) <= 5, `右栏变化 ${dw1.toFixed(1)}px，期望 ≈-120`)
  assert(Math.abs(after.panes[0].w + after.panes[1].w + after.splitCount * 4 - boxW) <= 2,
    '两栏加分隔条没铺满容器')
})

check('B2 拖动只改了占比，栏数/面板没被带跑', () => {
  assert(after.panes.length === 2, '栏数变了：' + after.panes.length)
  assert(picksOf(after).join(',') === 'list,detail', '面板被改了：' + picksOf(after).join(','))
})

await sleep(900)
check('B3 拖完落的盘和界面一致', () => {
  const saved = readSettings()
  assert(saved && saved.layout, 'ui-settings.json 里没有 layout：' + JSON.stringify(saved))
  const sizes = saved.layout.sizes
  assert(sizes.length === 2, 'sizes 长度应为 2，实际 ' + JSON.stringify(sizes))
  const ratio = ratioOf(after.panes[0].w, after.panes[1].w)
  assert(Math.abs(sizes[0] - (after.panes[0].grow / (after.panes[0].grow + after.panes[1].grow))) < 0.02,
    `落盘 sizes=${JSON.stringify(sizes)} 与界面 flex-grow 对不上（界面占比 ${ratio.toFixed(4)}）`)
})

/* ------------------------------------------------- C 双击均分 */

await app.evaluate(DBLCLICK_SPLIT(0))
await sleep(200)
const even = await snap('双击均分')
check('C1 双击分隔条 → 两栏均分', () => {
  const ratio = ratioOf(even.panes[0].w, even.panes[1].w)
  assert(Math.abs(ratio - 0.5) < 0.02, `均分后左栏占比 ${ratio.toFixed(4)}，期望 0.5`)
  assert(Math.abs(even.panes[0].grow - 0.5) < 0.001, 'flex-grow 应为 0.5，实际 ' + even.panes[0].grow)
})

/* ------------------------------------------------- D 下限 */

const far = await app.evaluate(DRAG(0, -4000, 0))
await sleep(200)
const clamped = await snap('拖到极端')
check('D1 往左拖到极端 → 左栏顶在下限上，右栏没被挤没' + (far.ok ? '' : '（拖动没起来：' + far.reason + '）'), () => {
  assert(clamped.panes.length === 2, '栏数变了：' + clamped.panes.length)
  assert(clamped.panes[0].w >= MIN_PANE_PX - 8 && clamped.panes[0].w <= MIN_PANE_PX + 14,
    `左栏宽 ${clamped.panes[0].w.toFixed(1)}px，应贴住下限 ${MIN_PANE_PX}px`)
  assert(clamped.panes[1].w > 300, '右栏被挤没了：' + clamped.panes[1].w.toFixed(1) + 'px')
  const sum = clamped.panes[0].grow + clamped.panes[1].grow
  assert(Math.abs(sum - 1) < 0.01, `两侧占比之和应为 1，实际 ${sum}`)
})

/* ------------------------------------------------- E 关栏 */

await app.evaluate(CLOSE_PANE(1))
await sleep(200)
const single = await snap('关掉一栏')
check('E1 点右栏的 ✕ → 只剩一栏、铺满整宽、没有分隔条', () => {
  assert(single.panes.length === 1, '应剩 1 栏，实际 ' + single.panes.length)
  assert(single.panes[0].pick === 'list', '剩下的应是列表，实际 ' + single.panes[0].pick)
  assert(Math.abs(single.panes[0].w - single.boxW) <= 2, `栏宽 ${single.panes[0].w} 应等于容器宽 ${single.boxW}`)
  assert(single.splitCount === 0, '还有分隔条：' + single.splitCount)
})

check('E2 只剩一栏时不给「关掉这一栏」（否则工作区就空了）', () => {
  assert(single.panes[0].closer === false, '单栏还挂着 ✕')
})

/* ------------------------------------------------- F 加分栏 */

await app.evaluate(CLICK_TAB('分栏'))
await sleep(200)
const two = await snap('加分栏')
check('F1 ＋ 分栏 → 新栏放的是还没露面的面板（这里是瀑布图），且真的渲染出来了', () => {
  assert(two.panes.length === 2, '应 2 栏，实际 ' + two.panes.length)
  assert(picksOf(two).join(',') === 'list,waterfall', '期望 list,waterfall，实际 ' + picksOf(two).join(','))
  assert(two.panes[1].bodyClass.indexOf('waterfall') >= 0,
    '新栏里没有瀑布图，实际 body 里是 "' + two.panes[1].bodyClass + '"')
})

await app.evaluate(CLICK_TAB('分栏'))
await sleep(150)
await app.evaluate(CLICK_TAB('分栏'))
await sleep(250)
const four = await snap('加到四栏')
check('F2 加到 4 栏：面板不重复，且按钮变灰', () => {
  assert(four.panes.length === 4, '应 4 栏，实际 ' + four.panes.length)
  const picks = picksOf(four)
  assert(new Set(picks).size === picks.length, '有重复面板：' + picks.join(','))
  assert(four.addDisabled === true, '到 4 栏后「＋ 分栏」应 disabled')
})

const fifth = await app.evaluate(CLICK_TAB('分栏'))
await sleep(200)
const still = await snap('第五次点击')
check('F3 4 栏之后再点也不加（按钮已灰，点了也白点）', () => {
  assert(fifth.ok && fifth.disabled === true, '按钮应处于 disabled')
  assert(still.panes.length === 4, '栏数被加到了 ' + still.panes.length)
})

/* ------------------------------------------------- G 每栏自己选面板 */

await app.evaluate(PICK_PANEL(3, 'stats'))
await sleep(400)
const picked = await snap('换面板')
check('G1 第 4 栏换成「统计」→ 这一栏真的挂上了统计面板，其它栏没动', () => {
  assert(picked.panes[3].pick === 'stats', '第 4 栏选的是 ' + picked.panes[3].pick)
  assert(picked.panes[3].bodyClass.indexOf('stats') >= 0,
    '第 4 栏里没有统计面板，实际 body 里是 "' + picked.panes[3].bodyClass + '"')
  assert(picksOf(picked).slice(0, 3).join(',') === picksOf(four).slice(0, 3).join(','),
    '其它栏被带着改了：' + picksOf(picked).join(','))
})

/* ------------------------------------------------- H 换方向 */

const beforeFlip = picked
const flipped = await app.evaluate(CLICK_TAB('左右'))
await sleep(250)
const column = await snap('换成上下排')
check('H1 ⇔ 左右 → ⇕ 上下：四栏改成上下排，高度比沿用原来的宽度比', () => {
  assert(flipped.ok, '没点到换方向按钮：' + String(flipped.reason))
  assert(column.dir === 'column', '方向应为 column，实际 ' + column.dir)
  assert(column.panes.length === 4, '栏数变了：' + column.panes.length)
  const wRatio = beforeFlip.panes[0].w / (beforeFlip.panes[0].w + beforeFlip.panes[1].w)
  const hRatio = column.panes[0].h / (column.panes[0].h + column.panes[1].h)
  assert(Math.abs(wRatio - hRatio) < 0.03, `同一份占比换了轴应不变：横 ${wRatio.toFixed(3)} vs 竖 ${hRatio.toFixed(3)}`)
  assert(Math.abs(column.panes[0].left - column.panes[1].left) <= 2, '上下排应该左右对齐')
})

await app.evaluate(CLICK_TAB('上下'))
await sleep(250)
const backRow = await snap('换回左右')
check('H2 再点一次换回左右排', () => {
  assert(backRow.dir === 'row', '方向应为 row，实际 ' + backRow.dir)
  assert(backRow.panes[0].top === backRow.panes[1].top || Math.abs(backRow.panes[0].top - backRow.panes[1].top) <= 2,
    '左右排应该顶边对齐')
})

/* ------------------------------------------------- I 复位 */

await app.evaluate(CLICK_TAB('复位'))
await sleep(300)
const reset = await snap('复位')
check('I1 ⟲ 复位 → 回到「列表 + 详情」0.62 / 0.38', () => {
  assert(picksOf(reset).join(',') === 'list,detail', '面板应为 list,detail，实际 ' + picksOf(reset).join(','))
  assert(Math.abs(ratioOf(reset.panes[0].w, reset.panes[1].w) - 0.62) < 0.02, '占比没回到 0.62')
})

/* ------------------------------- J 落盘 → K 重启恢复 → L 旧文件兼容 */

await app.evaluate(CLICK_TAB('分栏'))
await sleep(200)
await app.evaluate(PICK_PANEL(2, 'sessions'))
await sleep(900)
const custom = await snap('自定义布局')
check('J1 三栏（列表 / 详情 / 会话）落了盘，面板与占比都对得上', () => {
  const saved = readSettings()
  assert(saved && saved.layout, '没有 layout：' + JSON.stringify(saved))
  assert(saved.layout.panes.join(',') === 'list,detail,sessions',
    '落盘面板 ' + saved.layout.panes.join(',') + '，界面 ' + picksOf(custom).join(','))
  assert(Math.abs(saved.layout.sizes[0] - custom.panes[0].grow) < 0.02, '落盘占比与界面不符')
  assert(saved.layout.dir === 'row', '落盘方向应为 row')
})

// 顺手把「关窗口前那次没落盘的改动」也验了：改完立刻退出，重启后应当还是新的
await app.evaluate(PICK_PANEL(0, 'console'))
await sleep(120)
await restart(app, quitFile)
app = await launch(quitFile2, '')
await app.waitConnected(1)
const restored = await snap('重启恢复')

check('K1 重启后恢复上次摆的布局（含退出前最后一刻的改动）', () => {
  assert(picksOf(restored).join(',') === 'console,detail,sessions',
    '恢复出来的面板是 ' + picksOf(restored).join(','))
  assert(restored.panes.length === 3, '栏数应为 3，实际 ' + restored.panes.length)
})

await restart(app, quitFile2)

// 旧版文件：只有 dock、没有 layout
writeFileSync(settingsPath, JSON.stringify({ dock: { enabled: false, side: 'right' } }, null, 2))
app = await launch(quitFile3, '')
await app.waitConnected(1)
const legacy = await snap('旧版设置文件')
await sleep(1200)

check('L1 旧版 ui-settings.json（只有 dock）→ 用默认布局起来，不崩', () => {
  assert(picksOf(legacy).join(',') === 'list,detail', '应为默认 list,detail，实际 ' + picksOf(legacy).join(','))
  assert(Math.abs(ratioOf(legacy.panes[0].w, legacy.panes[1].w) - 0.62) < 0.02, '占比不是默认的 0.62')
})

check('L2 旧版文件被补上了 layout 字段（下次启动就不用再猜）', () => {
  const saved = readSettings()
  assert(saved, '文件没了')
  assert(saved.layout && saved.layout.panes.join(',') === 'list,detail',
    '没补上默认布局：' + JSON.stringify(saved))
  assert(saved.dock && saved.dock.side === 'right', '原有的 dock 设置被抹了：' + JSON.stringify(saved.dock))
})

/* --------------------------------------------------------------- 收尾 */

await restart(app, quitFile3)
await origin.close?.()

const ok = report()
process.exit(ok ? 0 : 1)
