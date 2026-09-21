#!/usr/bin/env node
/** 工作区 UI 出图：默认两栏 / 四栏 / 上下排 / 拖动之后，拿去肉眼看布局对不对 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, sleep, ROOT } from '../scripts/app-harness.mjs'
import { startOrigin } from '../scripts/test-origin.mjs'

const SHOT_DIR = join(ROOT, 'work', 'layout-shots')
mkdirSync(SHOT_DIR, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'layout-shot-'))
const origin = await startOrigin(0)
const app = await launchApp({
  url: 'http://127.0.0.1:' + origin.port + '/',
  dataDir,
  port: 9722,
  tab: 'list',
  shotDir: SHOT_DIR
})
await app.waitConnected(1)
await sleep(1200)
await app.shot('01-default.png')

const clickTab = (text) => `(() => {
  const b = Array.from(document.querySelectorAll('.targets .tabs .tab')).find((x) => x.textContent.indexOf(${JSON.stringify(text)}) >= 0)
  if (b && !b.disabled) b.click()
  return !!b
})()`

await app.evaluate(clickTab('分栏'))
await sleep(300)
await app.evaluate(clickTab('分栏'))
await sleep(300)
await app.evaluate(`(() => {
  const pane = Array.from(document.querySelector('.panes').children).filter((el) => el.classList.contains('pane'))[3]
  const sel = pane.querySelector('.pane-pick')
  sel.value = 'env'
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  return true
})()`)
await sleep(1500)
await app.shot('02-four-panes.png')

await app.evaluate(clickTab('左右'))
await sleep(400)
await app.shot('03-column.png')

await app.evaluate(clickTab('上下'))
await sleep(200)
await app.evaluate(clickTab('复位'))
await sleep(400)
await app.evaluate(`(() => {
  const box = document.querySelector('.panes')
  const split = box.querySelector('.pane-split')
  const r = split.getBoundingClientRect()
  const x = r.left + r.width / 2
  const y = r.top + r.height / 2
  const fire = (t, cx, cy, el) => (el || window).dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: cx, clientY: cy, buttons: 1 }))
  fire('mousedown', x, y, split)
  for (let i = 1; i <= 8; i++) fire('mousemove', x + 260 * i / 8, y)
  fire('mouseup', x + 260, y)
  return true
})()`)
await sleep(600)
await app.shot('04-dragged.png')

await app.cdp.close()
await app.close()
await origin.close?.()
console.log('截图在 ' + SHOT_DIR)