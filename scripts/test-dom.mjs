#!/usr/bin/env node
/**
 * §7.1 面板 #3「DOM 与元素检查」验收。
 *
 * 判据不是「调用没报错」，而是**页面侧的真值**：
 *   1) outerHTML / 盒模型 / 计算样式跟页面自己报的那一份对上；
 *   2) 命中样式的「谁盖了谁」用**计算结果的来源**反向验证 —— 真正生效的那条规则
 *      必须没被标 overridden，被盖的必须被标出来，优先级高的必须排在前面。
 *      方向写反了两边都会露馅；
 *   3) 行内样式最优先：element.style 必须排在最前且不被标覆盖；
 *   4) 事件监听器**不依赖 Runtime**（§3.4：Profile H 下 Runtime 是红线），
 *      所以同样的判据要在 Profile H 下再跑一遍；
 *   5) 按需启用是证据不是口号：enabledDomains 必须随用随开（DOM → CSS → Overlay）；
 *   6) 面板 UI 路径也走一遍：点箭头展开/收起、按选择器查元素出详情。
 *
 *   node scripts/test-dom.mjs
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startOrigin } from './test-origin.mjs'
import { launchApp, makeChecker, sleep } from './app-harness.mjs'

const CDP_PORT = Number(process.env['DOM_CDP_PORT'] ?? 9481)
const SHOT_DIR = process.env['DOM_SHOT_DIR'] ?? null

const { check, assert, report } = makeChecker()

const dataDir = mkdtempSync(join(tmpdir(), 'monitor-dom-'))
if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true })
const origin = await startOrigin(0)
const url = `http://127.0.0.1:${origin.port}/dom-probe.html`
console.log(`受控页面: ${url}`)
console.log(`数据目录: ${dataDir}\n`)

/** 在控制窗口里跑一段用得到 api 的异步代码 */
const runOn = (app, body) => app.evaluate(`(async () => { const api = window.monitor; ${body} })()`)

let app = null
try {
  app = await launchApp({ url, dataDir, port: CDP_PORT, tab: 'dom', shotDir: SHOT_DIR })
  await app.waitConnected(1)
  // 面板自己开局会取一次树；等一下让「第一次启用 DOM」这件事先落地，
  // 免得下面判 enabledDomains 的时候读到的是面板那一次
  await sleep(1200)
  await app.shot('dom-panel.png')

  /* ------------------------------------------------------------ 树 */

  console.log('== DOM 树 ==')
  const tree = await runOn(app, `return await api.domGetTree(undefined, 2)`)
  check('树：根与主干（#document / html / head / body）', () => {
    assert(tree.ok, '取树失败: ' + tree.error)
    const labels = tree.rows.map((row) => row.label)
    for (const need of ['#document', 'html', 'head', 'body']) {
      assert(labels.includes(need), `树里缺 ${need}：${labels.join(' / ')}`)
    }
    const root = tree.rows[0]
    assert(root.depth === 0 && root.nodeType === 9, '第一行不是 depth 0 的 #document')
    const html = tree.rows.find((row) => row.label === 'html')
    assert(html.depth === 1 && html.expandable, 'html 的层级或展开标记不对')
    for (let i = 1; i < tree.rows.length; i++) {
      assert(
        tree.rows[i].depth <= tree.rows[i - 1].depth + 1,
        `深度跳级：${tree.rows[i].label} depth=${tree.rows[i].depth}`
      )
    }
  })

  const bodyRow = tree.rows.find((row) => row.label === 'body')
  const kids = await runOn(app, `return await api.domGetTree(${bodyRow.nodeId}, 1)`)
  check('树：懒展开只取一层，被展开的节点排在子节点前面', () => {
    assert(kids.ok, '展开失败: ' + kids.error)
    assert(kids.rows[0].nodeId === bodyRow.nodeId, '第一行应当是被展开的那个节点自己')
    assert(kids.rows.length > 1, 'body 一个子节点都没取到')
    assert(
      kids.rows.slice(1).every((row) => row.depth === 1),
      '子节点深度不是 1'
    )
    assert(
      kids.rows.some((row) => row.label === 'script'),
      'body 的子节点里应当有 script'
    )
  })

  /* ------------------------------------------------------------ 选择器 */

  console.log('\n== 选择器与元素真值 ==')
  const style = await runOn(app, `return await api.domInspect({ selector: '#probe-style' })`)
  const truthHtml = await app.evaluate(
    `(async () => { const r = await window.monitor.evaluate("document.getElementById('probe-style').outerHTML"); return r.value })()`
  )
  const truthRect = await app.evaluate(
    `(async () => { const r = await window.monitor.evaluate("JSON.stringify(document.getElementById('probe-style').getBoundingClientRect())"); return JSON.parse(r.value) })()`
  )

  check('选择器：命中并给出标签、路径、属性', () => {
    assert(style.ok, '查元素失败: ' + style.error)
    assert(style.node.label === 'div#probe-style.box', 'label 不对: ' + style.node.label)
    assert(style.node.path.includes('body'), 'path 里没有 body: ' + style.node.path)
    const attrs = Object.fromEntries(style.node.attributes ?? [])
    assert(attrs.id === 'probe-style' && attrs.class === 'box', '属性表不对: ' + JSON.stringify(attrs))
  })

  check('outerHTML 与页面里的真值逐字一致', () => {
    assert(typeof truthHtml === 'string' && truthHtml.includes('probe-style'), '页面侧真值没取到')
    assert(style.outerHTML === truthHtml, `页面是 ${truthHtml}，面板给的是 ${style.outerHTML}`)
  })

  check('盒模型与页面 getBoundingClientRect 对得上', () => {
    assert(style.box, '没有盒模型')
    const width = Math.round(truthRect.width)
    const height = Math.round(truthRect.height)
    assert(Math.abs(style.box.width - width) <= 1, `宽对不上：面板 ${style.box.width} / 页面 ${width}`)
    assert(Math.abs(style.box.height - height) <= 1, `高对不上：面板 ${style.box.height} / 页面 ${height}`)
    assert(style.box.content.length === 8, 'content 四边形不是 8 个数')
  })

  const miss = await runOn(app, `return await api.domInspect({ selector: '#nope-nothing' })`)
  const bad = await runOn(app, `return await api.domInspect({ selector: '(((' })`)
  check('选择器：没命中和语法错都给出可读错误', () => {
    assert(!miss.ok && (miss.error ?? '').includes('#nope-nothing'), '没命中时错误不可读: ' + miss.error)
    assert(!bad.ok && (bad.error ?? '').length > 0, '语法错时没有错误信息')
  })

  /* ------------------------------------------------------------ 命中样式 */

  console.log('\n== 命中样式（覆盖判定的反向验证）==')
  check('覆盖判定：赢的那条没被标覆盖，被盖的标了，且赢的排在前面', () => {
    const matched = style.matched ?? []
    const computed = (style.computed ?? []).find(([name]) => name === 'color')
    assert(computed, '计算样式里没有 color')
    assert(computed[1] === 'rgb(0, 128, 0)', '计算色不是 #root .box 的绿：' + JSON.stringify(computed))

    const winner = matched.find((rule) => rule.selector === '#root .box')
    assert(winner, '没列出 #root .box：' + JSON.stringify(matched.map((r) => r.selector)))
    assert(
      !winner.overridden.includes('color'),
      '#root .box 的 color 被判成被覆盖了，而它才是生效的那条'
    )
    const losers = matched.filter((rule) => rule.selector === '.box')
    assert(losers.length === 2, `.box 应当有 2 条，实际 ${losers.length}`)
    assert(
      losers.every((rule) => rule.overridden.includes('color')),
      '被盖住的 .box 没被标出来'
    )
    assert(
      matched.indexOf(winner) < matched.indexOf(losers[0]),
      '优先级高的规则没排在前面'
    )
  })

  const inline = await runOn(app, `return await api.domInspect({ selector: '#probe-inline' })`)
  check('行内样式：element.style 排最前且不被标覆盖', () => {
    const matched = inline.matched ?? []
    const first = matched[0]
    assert(
      first && first.origin === 'inline' && first.selector === 'element.style',
      '第一条不是 element.style：' + JSON.stringify(matched.map((r) => [r.selector, r.origin]))
    )
    assert(!first.overridden.includes('color'), '行内 color 被标成被覆盖')
    const rule = matched.find((item) => item.selector === '#probe-inline')
    assert(rule, '没列出样式表里那条 #probe-inline')
    assert(rule.overridden.includes('color'), '样式表里那条 color 没被标覆盖')
    const computed = (inline.computed ?? []).find(([name]) => name === 'color')
    assert(computed[1] === 'rgb(170, 187, 204)', '计算色不是行内的 #aabbcc：' + JSON.stringify(computed))
  })

  /* ------------------------------------------------------------ 监听器 */

  console.log('\n== 事件监听器 ==')
  const btn = await runOn(app, `return await api.domInspect({ selector: '#probe-btn' })`)
  check('事件监听器：列出 click / pointerdown，passive 标记正确', () => {
    const list = btn.listeners ?? []
    const click = list.find((item) => item.type === 'click')
    const down = list.find((item) => item.type === 'pointerdown')
    assert(click, '没列出 click：' + JSON.stringify(list.map((i) => i.type)))
    assert(down, '没列出 pointerdown：' + JSON.stringify(list.map((i) => i.type)))
    assert(down.passive === true, 'pointerdown 的 passive 没报出来')
    assert(click.passive === false, 'click 的 passive 不该是 true')
    assert(
      list.some((item) => item.handler || item.location),
      '监听器既没有 handler 也没有 location'
    )
  })

  check('监听器不依赖 Runtime（enabledDomains 里没有 Runtime）', () => {
    assert((btn.listeners ?? []).length > 0, '没有监听器')
    assert(
      !(btn.enabledDomains ?? []).includes('Runtime'),
      '为了拿监听器开了 Runtime：' + JSON.stringify(btn.enabledDomains)
    )
  })

  /* ------------------------------------------------------------ 按需启用 */

  console.log('\n== 按需启用与高亮 ==')
  const hlOn = await runOn(app, `return await api.domHighlight(${style.node.nodeId}, true)`)
  check('按需启用：DOM → CSS → Overlay 随用随开且累计', () => {
    assert(
      tree.enabledDomains.join(',') === 'DOM',
      '第一次取树只该启 DOM：' + JSON.stringify(tree.enabledDomains)
    )
    assert(
      style.enabledDomains.includes('DOM') && style.enabledDomains.includes('CSS'),
      '查元素之后该是 DOM+CSS：' + JSON.stringify(style.enabledDomains)
    )
    assert(hlOn.ok, '高亮失败: ' + hlOn.error)
    assert(
      hlOn.enabledDomains.includes('Overlay'),
      '高亮之后该有 Overlay：' + JSON.stringify(hlOn.enabledDomains)
    )
  })

  const hlOff = await runOn(app, `return await api.domHighlight(${style.node.nodeId}, false)`)
  check('页面高亮：开与关都成功', () => {
    assert(hlOn.ok && hlOn.highlighted !== false, '没打开高亮: ' + JSON.stringify(hlOn))
    assert(hlOff.ok, '关高亮失败: ' + hlOff.error)
  })

  const stale = await runOn(app, `return await api.domInspect({ nodeId: 999999 })`)
  check('失效的 nodeId：给一句人话而不是 CDP 原文', () => {
    assert(!stale.ok, '不存在的节点居然查成功了')
    assert(/失效|找不到|Could not find/.test(stale.error ?? ''), '错误不可读: ' + stale.error)
  })

  /* ------------------------------------------------------------ UI 路径 */

  console.log('\n== 面板（UI 路径）==')
  const uiExpand = await app.evaluate(`(async () => {
    const frame = () => new Promise((r) => setTimeout(r, 50))
    const rows = () => Array.from(document.querySelectorAll('.dom-tree .dom-row'))
    for (let i = 0; i < 80 && rows().length === 0; i++) await frame()
    if (!rows().length) return { ok: false, reason: '树是空的' }
    const before = rows().length
    const find = () => rows().find((el) => el.querySelector('.dom-label') && el.querySelector('.dom-label').textContent === 'body')
    const first = find()
    if (!first) return { ok: false, reason: '树里没有 body 行' }
    const arrow = first.querySelector('.dom-arrow')
    if (!arrow || arrow.classList.contains('dom-arrow-none')) return { ok: false, reason: 'body 行没有展开箭头' }
    arrow.click()
    for (let i = 0; i < 60 && rows().length === before; i++) await frame()
    const expanded = rows().length
    const grown = Array.from(document.querySelectorAll('.dom-tree .dom-row')).map((el) => (el.querySelector('.dom-label') ? el.querySelector('.dom-label').textContent : ''))
    const second = find()
    if (!second) return { ok: false, reason: '展开后找不到 body 行' }
    second.querySelector('.dom-arrow').click()
    for (let i = 0; i < 60 && rows().length !== before; i++) await frame()
    return { ok: true, before, expanded, collapsed: rows().length, grown: grown.slice(0, 12) }
  })()`)
  check('面板：点箭头展开、再点收起（行数先增后复原）', () => {
    assert(uiExpand.ok, 'UI 展开失败: ' + JSON.stringify(uiExpand))
    assert(uiExpand.expanded > uiExpand.before, `展开后行数没增加：${uiExpand.before} → ${uiExpand.expanded}`)
    assert(uiExpand.collapsed === uiExpand.before, `收起后行数没复原：${uiExpand.collapsed} ≠ ${uiExpand.before}`)
    console.log('      展开后前几行：' + uiExpand.grown.join(' / '))
  })

  const uiInspect = await app.evaluate(`(async () => {
    const frame = () => new Promise((r) => setTimeout(r, 50))
    const input = document.querySelector('.dom-bar .search')
    if (!input) return { ok: false, reason: '没有选择器输入框' }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '#probe-style')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await frame()
    const button = Array.from(document.querySelectorAll('.dom-bar button')).find((b) => b.textContent.includes('检查元素'))
    if (!button) return { ok: false, reason: '没有「检查元素」按钮' }
    button.click()
    let text = ''
    for (let i = 0; i < 80; i++) {
      await frame()
      const detail = document.querySelector('.dom-detail')
      text = detail ? detail.innerText : ''
      if (text.includes('命中样式') && text.includes('元素内容')) break
    }
    const html = document.querySelector('.dom-detail .dom-html')
    return {
      ok: text.includes('命中样式'),
      text: text.replace(/\s+/g, ' ').slice(0, 300),
      html: html ? html.textContent : '',
      sections: ['属性', '盒模型', '命中样式', '事件监听器', '元素内容', '计算样式'].filter((k) => text.includes(k)),
      overridden: document.querySelectorAll('.dom-detail .dom-over').length
    }
  })()`)
  check('面板：选择器查出详情（属性/盒模型/命中样式/事件监听器/计算样式）', () => {
    assert(uiInspect.ok, 'UI 详情没出来: ' + JSON.stringify(uiInspect))
    for (const need of ['属性', '盒模型', '命中样式', '事件监听器', '计算样式']) {
      assert(uiInspect.sections.includes(need), `详情里没有「${need}」：${uiInspect.text}`)
    }
    assert(uiInspect.overridden > 0, '详情里没有被覆盖标记（.dom-over）')
  })

  check('面板：详情里的 outerHTML 与页面一致', () => {
    assert(uiInspect.html.trim() === truthHtml, `面板 ${uiInspect.html} / 页面 ${truthHtml}`)
  })

  await app.shot('dom-panel-detail.png')

  /* ------------------------------------------------------------ Profile H */

  console.log('\n== Profile H（按需启用的实证）==')
  await app.close()
  app = await launchApp({ url, dataDir, port: CDP_PORT + 1, profile: 'H', tab: 'dom', shotDir: SHOT_DIR })
  await app.waitConnected(1)
  await sleep(1200)

  const hTree = await runOn(app, `return await api.domGetTree(undefined, 2)`)
  const hStyle = await runOn(app, `return await api.domInspect({ selector: '#probe-btn' })`)
  check('H：DOM 与 CSS 按需开后照常可用', () => {
    assert(hTree.ok, 'H 下取树失败: ' + hTree.error)
    assert(hTree.enabledDomains.join(',') === 'DOM', 'H 下第一次取树只该启 DOM：' + JSON.stringify(hTree.enabledDomains))
    assert(hStyle.ok, 'H 下查元素失败: ' + hStyle.error)
    assert((hStyle.matched ?? []).length > 0, 'H 下没有命中样式')
    assert((hStyle.computed ?? []).length > 50, 'H 下没有计算样式')
  })

  check('H：事件监听器可用且没碰 Runtime', () => {
    assert((hStyle.listeners ?? []).length > 0, 'H 下没有监听器')
    assert(
      !(hStyle.enabledDomains ?? []).includes('Runtime'),
      'H 下开了 Runtime：' + JSON.stringify(hStyle.enabledDomains)
    )
  })

  const hHl = await runOn(app, `return await api.domHighlight(${hStyle.node.nodeId}, true)`)
  const hHlOff = await runOn(app, `return await api.domHighlight(${hStyle.node.nodeId}, false)`)
  check('H：页面高亮可用（Overlay 按需）', () => {
    assert(hHl.ok, 'H 下高亮失败: ' + hHl.error)
    assert(hHl.enabledDomains.includes('Overlay'), 'H 下没启用 Overlay：' + JSON.stringify(hHl.enabledDomains))
    assert(hHlOff.ok, 'H 下关高亮失败: ' + hHlOff.error)
  })

  await app.shot('dom-panel-h.png')
} catch (err) {
  console.log(`  \u2717 跑挂了: ${err.message}`)
} finally {
  if (app) await app.close()
  try {
    await origin.close()
  } catch {
    /* 已经关了 */
  }
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* Windows 偶尔删不掉 */
  }
}

const ok = report()
process.exit(ok ? 0 : 1)