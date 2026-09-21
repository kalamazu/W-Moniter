#!/usr/bin/env node
/**
 * 单独验 win/dock-helper.ps1 的协议与能力 —— 不经过 Electron，
 * 这样出问题时能分清是「助手不行」还是「接线不对」。
 */

import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, sleep, makeChecker, ROOT } from '../scripts/app-harness.mjs'
import { startOrigin } from '../scripts/test-origin.mjs'

const { check, assert, report } = makeChecker()
const dataDir = mkdtempSync(join(tmpdir(), 'dockh-'))
const profileDir = join(dataDir, 'browser-profile')

class Helper {
  constructor() {
    this.child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'win', 'dock-helper.ps1')],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    )
    this.pending = new Map()
    this.nextId = 1
    this.stderr = ''
    const rl = createInterface({ input: this.child.stdout })
    rl.on('line', (line) => {
      const text = line.trim()
      if (!text) return
      const sp = text.split(' ')
      const slot = this.pending.get(sp[0])
      if (!slot) return
      this.pending.delete(sp[0])
      if (sp[1] === 'ok') slot.resolve(sp.slice(2))
      else slot.reject(new Error(sp.slice(2).join(' ')))
    })
    this.child.stderr.on('data', (d) => (this.stderr += d.toString()))
  }
  send(cmd, timeoutMs = 15000) {
    const id = String(this.nextId++)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('助手超时: ' + cmd + ' / stderr=' + this.stderr.slice(0, 200)))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) }
      })
      this.child.stdin.write(id + ' ' + cmd + '\n')
    })
  }
  async stop() {
    try { this.child.stdin.write('0 quit\n') } catch { /* 已经退了 */ }
    await new Promise((r) => setTimeout(r, 800))
    if (this.child.exitCode === null) { try { this.child.kill() } catch { /* ignore */ } }
  }
}

const origin = await startOrigin(0)
const app = await launchApp({ url: 'http://127.0.0.1:' + origin.port + '/', dataDir, port: 9715, tab: 'list' })

const t0 = Date.now()
const helper = new Helper()
let hwnd = 0

try {
  await app.waitConnected(1)

  // 协议健壮性
  const unknown = await helper.send('nope').then(() => null, (e) => e.message)
  check('未知命令回 err 而不是断连接', () => assert(unknown === 'unknown_verb', String(unknown)))

  const gone = await helper.send('rect 999999999').then(() => null, (e) => e.message)
  check('无效句柄回 err gone', () => assert(gone === 'gone', String(gone)))

  const bogus = await helper.send('find ' + Buffer.from('C:\\nope\\nope').toString('base64'))
  check('找不到进程时回 ok 0 0（不是报错）', () => assert(bogus[0] === '0' && bogus[1] === '0', JSON.stringify(bogus)))

  // 真窗口
  const found = await helper.send('find ' + Buffer.from(profileDir).toString('base64'), 30000)
  hwnd = Number(found[0])
  const bpid = Number(found[1])
  console.log('  首次 find 耗时 ' + (Date.now() - t0) + 'ms（含 Add-Type 编译 + 一次 WMI 查询）  hwnd=' + hwnd + ' pid=' + bpid)
  check('按 profile 找到浏览器窗口', () => {
    assert(hwnd > 0, JSON.stringify(found))
    assert(bpid > 0, JSON.stringify(found))
  })

  const t1 = Date.now()
  const rect = (await helper.send('rect ' + hwnd)).join(',').split(',').map(Number)
  check('rect 返回四元组且尺寸合理', () => {
    assert(rect.length === 4, JSON.stringify(rect))
    assert(rect[2] - rect[0] > 400 && rect[3] - rect[1] > 300, JSON.stringify(rect))
  })

  const t2 = Date.now()
  await helper.send('move ' + hwnd + ' 300 200 1400 1000')
  const after = (await helper.send('rect ' + hwnd)).join(',').split(',').map(Number)
  const moveMs = Date.now() - t2
  check('move 挪到指定 (x,y,w,h)', () => {
    assert(Math.abs(after[0] - 300) <= 2, 'x=' + after[0])
    assert(Math.abs(after[1] - 200) <= 2, 'y=' + after[1])
    assert(Math.abs(after[2] - after[0] - 1400) <= 2, 'w=' + (after[2] - after[0]))
    assert(Math.abs(after[3] - after[1] - 1000) <= 2, 'h=' + (after[3] - after[1]))
  })
  console.log('  rect+move+rect 往返 ' + moveMs + 'ms（每条命令都走一次进程间往返）')

  // 连发 30 条，量吞吐 —— 拖拽时要跟得住
  const t3 = Date.now()
  for (let i = 0; i < 30; i++) await helper.send('move ' + hwnd + ' ' + (300 + i) + ' 200 1400 1000')
  const per = (Date.now() - t3) / 30
  console.log('  连续 move 30 次：平均 ' + per.toFixed(1) + 'ms/次')
  check('单条 move 往返 < 30ms（拖拽跟得上）', () => assert(per < 30, per.toFixed(1) + 'ms'))

  const before = await helper.send('iconic ' + hwnd)
  check('未最小化时 iconic=0', () => assert(before[0] === '0', JSON.stringify(before)))

  await helper.send('min ' + hwnd)
  await sleep(600)
  const min = await helper.send('iconic ' + hwnd)
  check('min 之后 iconic=1', () => assert(min[0] === '1', JSON.stringify(min)))

  await helper.send('unmin ' + hwnd)
  await sleep(600)
  const unmin = await helper.send('iconic ' + hwnd)
  check('unmin 之后 iconic=0', () => assert(unmin[0] === '0', JSON.stringify(unmin)))
} catch (err) {
  console.error('\n  中断: ' + err.message)
} finally {
  await helper.stop()
  check('quit 之后助手进程真的退了', () => assert(helper.child.exitCode !== null, 'exitCode=' + helper.child.exitCode))
  try { app.cdp.close() } catch { /* ignore */ }
  try { app.app.kill() } catch { /* ignore */ }
  spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "*Chromium*" } | Stop-Process -Force'], { encoding: 'utf8' })
  await origin.close()
  await sleep(400)
  const ok = report()
  process.exit(ok ? 0 : 1)
}