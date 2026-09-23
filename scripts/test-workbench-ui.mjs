#!/usr/bin/env node
/** T-015 UI 验收：结构、键盘命令、视图导航与窄宽度下的窗口三键。 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, makeChecker, sleep } from './app-harness.mjs'
import { startOrigin } from './test-origin.mjs'

const { check, assert, report } = makeChecker()
const dataDir = mkdtempSync(join(tmpdir(), 'workbench-ui-'))
const origin = await startOrigin(0)
const app = await launchApp({ url: `http://127.0.0.1:${origin.port}/`, dataDir, port: 9795, tab: 'list' })

try {
  await app.waitConnected(1)
  const initial = await app.evaluate(`(() => {
    const bar = document.querySelector('.tb-win')?.getBoundingClientRect()
    const buttons = Array.from(document.querySelectorAll('.tb-win-btn')).map((item) => item.getBoundingClientRect())
    return { hasTargetsRow: !!document.querySelector('.targets'), activity: document.querySelectorAll('.activity-item').length,
      sidebar: document.querySelector('.view-sidebar')?.classList.contains('is-open'), controls: buttons.map((item) => ({ x:item.x, w:item.width, right:item.right })), bar: { right: bar?.right } }
  })()`)
  check('U1 target 不再作为会折行的常驻标签行', () => assert(!initial.hasTargetsRow, '仍有 .targets 标签行'))
  check('U2 有活动栏和默认展开的视图侧栏', () => { assert(initial.activity >= 6, '活动栏入口不足'); assert(initial.sidebar, '侧栏默认未展开') })
  check('U3 三个窗口按钮在独立固定区且尺寸完整', () => {
    assert(initial.controls.length === 3, `窗口按钮数 ${initial.controls.length}`)
    assert(initial.controls.every((item) => item.w >= 40), '窗口按钮宽度被挤压')
    assert(initial.controls[0].x < initial.controls[1].x && initial.controls[1].x < initial.controls[2].x, '窗口按钮顺序异常')
    assert(Math.abs(initial.controls[2].right - initial.bar.right) < 2, `关闭按钮没有贴住窗口右边：close=${initial.controls[2].right} bar=${initial.bar.right}`)
  })

  // Electron 暴露的是 page target，没有 Browser 域；用同一 CDP 页面会话的设备指标
  // 覆盖来触发真实 CSS media query，不靠修改 DOM 宽度伪造。
  await app.cdp.send('Emulation.setDeviceMetricsOverride', { width: 620, height: 700, deviceScaleFactor: 1, mobile: false })
  await sleep(180)
  const narrow = await app.evaluate(`(() => { const title = document.querySelector('.titlebar')?.getBoundingClientRect(); const buttons = Array.from(document.querySelectorAll('.tb-win-btn')).map((item) => item.getBoundingClientRect()); return { titleRight: title?.right, buttons: buttons.map((item) => ({right:item.right,width:item.width})) } })()`)
  check('U4 窄窗口下最小化、最大化、关闭仍完整且贴右', () => {
    assert(narrow.buttons.length === 3 && narrow.buttons.every((item) => item.width >= 40), `窄窗口按钮被隐藏/压缩：${JSON.stringify(narrow.buttons)}`)
    assert(Math.abs(narrow.buttons[2].right - narrow.titleRight) < 2, `关闭按钮未贴右：${JSON.stringify(narrow)}`)
  })
  await app.cdp.send('Emulation.clearDeviceMetricsOverride')

  await app.evaluate(`document.querySelector('button[aria-label="分析"]')?.click()`)
  await sleep(100)
  const analysis = await app.evaluate(`document.querySelector('.view-sidebar-head strong')?.textContent`)
  check('U5 活动栏可切换能力域', () => assert(analysis === '分析', `当前侧栏为 ${analysis}`))
  await app.evaluate(`Array.from(document.querySelectorAll('.view-item')).find((item) => item.textContent.includes('接口画像'))?.click()`)
  await sleep(200)
  const endpoint = await app.evaluate(`document.querySelector('.pane-pick')?.value`)
  check('U6 侧栏视图会替换当前活动窗格', () => assert(endpoint === 'endpoints', `当前窗格为 ${endpoint}`))

  await app.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', ctrlKey: true, shiftKey: true, bubbles: true }))`)
  await sleep(100)
  const palette = await app.evaluate(`!!document.querySelector('.command-palette') && document.activeElement?.getAttribute('aria-label')`)
  check('U7 Ctrl+Shift+P 打开并聚焦命令面板', () => assert(palette === '搜索命令', `命令面板/焦点不正确：${palette}`))
  await app.evaluate(`Array.from(document.querySelectorAll('.command-item')).find((item) => item.textContent.includes('打开：设置'))?.click()`)
  await sleep(100)
  const drawer = await app.evaluate(`document.querySelector('.context-drawer [aria-label="关闭"]') !== null && document.querySelector('.drawer-head strong')?.textContent`)
  check('U8 设置是明确的独立区域', () => assert(drawer === '设置', `设置抽屉未打开：${drawer}`))
} finally {
  await app.close()
  await origin.close?.()
}

process.exit(report() ? 0 : 1)
