import { EventEmitter } from 'node:events'
import type { CdpClient } from './cdp'
import type { ProbeCheck, ProbeReport } from '../../shared/types'

/**
 * 检测探针（设计文档 §3.6 / §7.1 #8 / §12「隐蔽性」）。
 *
 * 探针是一段**纯页面侧**代码：只依赖 navigator / canvas / OfflineAudioContext，
 * 不依赖任何 CDP 注入物 —— 否则它测的就不是「目标站点能看到什么」了。
 *
 * 两条回传通道，覆盖两个 Profile：
 *   1. Profile L：Runtime.evaluate 直接把报告拿回来（快，但 Runtime 本身就是痕迹）。
 *   2. Profile H：Page.addScriptToEvaluateOnNewDocument 注入 + 信标回传。
 *      信标是 `new Image().src = http://probe.monitor.local/p?...`，
 *      由 Fetch 域在 Request 阶段拦下并 fulfill 204 —— 全程只用 Page/Network/Fetch，
 *      都在 §3.4 的白名单里。这正是 §3.5「Hook + 回传」的雏形。
 *
 * 报告 > 1200 字符会分片，靠 r（runId）/i（片号）/n（片数）重组。
 */

export const PROBE_HOST = 'probe.monitor.local'
export const PROBE_ORIGIN = 'http://' + PROBE_HOST
export const PROBE_ENDPOINT = PROBE_ORIGIN + '/p'

/** Fetch 拦截与请求过滤都用它：探针信道不能被当成真实流量 */
export function isProbeUrl(url: string): boolean {
  return url.startsWith(PROBE_ENDPOINT)
}

const CHUNK_CHARS = 1200

export const PROBE_SOURCE = `(async function () {
  // 注入是「每个新文档」都跑，子框架也会执行一遍。子框架里 outerWidth/Height 恒为 0、
  // 视口是 iframe 自己的尺寸，那份报告报上来只会污染结论 —— 实测就是它让 Profile H
  // 的报告时不时读成 outerWidth=0x0，而同一时刻主框架明明报的是 1280x900。
  // 探针要答的是「站点看到的这台机器」，那就只有顶层文档说了算。
  if (window.top !== window) return

  var started = Date.now()
  var run = Math.random().toString(16).slice(2, 10)
  var checks = []
  var fp = {}

  function push(id, group, label, status, value, detail) {
    checks.push({
      id: id, group: group, label: label, status: status,
      value: value === undefined ? null : value, detail: detail || ''
    })
  }
  function pass(id, g, l, v, d) { push(id, g, l, 'pass', v, d) }
  function fail(id, g, l, v, d) { push(id, g, l, 'fail', v, d) }
  function warn(id, g, l, v, d) { push(id, g, l, 'warn', v, d) }
  function note(id, g, l, v, d) { push(id, g, l, 'info', v, d) }
  function safe(fn, fallback) {
    try {
      var value = fn()
      return value === undefined || value === null ? fallback : value
    } catch (e) { return fallback }
  }
  function hash32(str) {
    var h = 0x811c9dc5
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i)
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
    }
    return ('00000000' + h.toString(16)).slice(-8)
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

  var G_CDP = 'CDP 痕迹'
  var G_AUTO = '自动化标记'
  var G_FP = '指纹一致性'
  var G_ENV = '运行环境'

  /* ---------------------------------------------------- CDP 痕迹 */

  var webdriver = 'webdriver' in navigator ? navigator.webdriver : undefined
  if (webdriver === true) {
    fail('webdriver', G_CDP, 'navigator.webdriver', 'true', '自动化标记还在，--disable-blink-features=AutomationControlled 没生效')
  } else {
    pass('webdriver', G_CDP, 'navigator.webdriver', String(webdriver), '未暴露自动化标记')
  }

  var wdDesc = safe(function () {
    return Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver')
  }, null)
  // 注意：webdriver 是**标准 IDL 属性**，真实 Chrome 的原型上一直有这个访问器。
  // 判据是它的**值**（上面那条），不是描述符本身 —— 拿描述符当痕迹会误报。
  note('webdriver_desc', G_CDP, 'Navigator.prototype.webdriver', wdDesc ? '标准访问器存在' : '不存在',
    'webdriver 是标准属性，真实浏览器同样存在；有意义的判据是它的取值')

  // Runtime.enable 之后 console 参数会被序列化，序列化会读访问器属性。
  // 这是「有调试器连着」最直接的信号之一（rebrowser runtimeEnableLeak 那一类）。
  var getterTouched = false
  try {
    var baked = {}
    Object.defineProperty(baked, 'stack', {
      get: function () { getterTouched = true; return 'x' },
      configurable: true
    })
    var bakedErr = new Error('monitor-probe')
    Object.defineProperty(bakedErr, 'stack', {
      get: function () { getterTouched = true; return 'x' },
      configurable: true
    })
    console.debug(baked, bakedErr)
    await wait(30)
  } catch (e) { /* 探针自己的失败不算发现 */ }
  if (getterTouched) {
    fail('runtime_getter_leak', G_CDP, 'console 参数访问器泄漏', 'getter 被调用',
      'console.debug 的参数被序列化了 —— Runtime.enable 打开时才会走这条路')
  } else {
    pass('runtime_getter_leak', G_CDP, 'console 参数访问器泄漏', 'getter 未被调用', '')
  }

  // console 调用的耗时：Runtime.enable 会把 console 调用换到「序列化 + 推事件」那条路。
  //
  // 判据用**每调用微秒数**，不用和基线循环的比值：基线循环会被 JIT 消掉（实测 0.05µs/次），
  // 除出来是个假数字。绝对值配合「三轮取最小」更稳 —— 噪声只会让单轮变慢，
  // 所以最小值是快速路径最干净的估计量。
  //
  // 本机标定（Chrome 153，Windows 11，n=9）：无 Runtime 4.25~5µs/次；
  // 有 Runtime 24.75 / 33 / 36.5 / 39.25 / 53.75µs/次。两簇之间是 5 → 25 的空档，
  // 判据取 15µs 落在空档中间 —— 贴着任何一端（原先的 25µs 就贴着有 Runtime 那一簇的下沿）
  // 都会让结论随一次调度抖动翻面。
  var timing = null
  try {
    var probeObj = { a: 1, b: 'x', c: [1, 2, 3], d: { e: 1 } }
    var N = 400
    var bestBase = Infinity
    var bestConsole = Infinity
    for (var round = 0; round < 3; round++) {
      var sink = 0
      var t0 = performance.now()
      for (var i = 0; i < N; i++) sink = (sink + probeObj.a + probeObj.c.length + probeObj.d.e) & 0xffff
      // 写进 window，否则整个循环会被当成死代码消掉
      window.__monitorProbeSink = sink
      var baseMs = performance.now() - t0
      var t1 = performance.now()
      for (var j = 0; j < N; j++) console.debug(probeObj)
      var consoleMs = performance.now() - t1
      if (baseMs < bestBase) bestBase = baseMs
      if (consoleMs < bestConsole) bestConsole = consoleMs
    }
    timing = {
      perCallUs: Math.round((bestConsole * 1000 / N) * 100) / 100,
      basePerCallUs: Math.round((bestBase * 1000 / N) * 100) / 100
    }
  } catch (e) { timing = null }
  if (timing) {
    if (timing.perCallUs >= 15) {
      fail('runtime_console_timing', G_CDP, 'console 调用耗时', timing,
        '每次 console.debug 要 ' + timing.perCallUs + 'µs（无调试器约 5µs）—— Runtime.enable 打开了')
    } else if (timing.perCallUs >= 8) {
      warn('runtime_console_timing', G_CDP, 'console 调用耗时', timing, '每调用 ' + timing.perCallUs + 'µs 偏高，建议复测')
    } else {
      pass('runtime_console_timing', G_CDP, 'console 调用耗时', timing, '每调用 ' + timing.perCallUs + 'µs')
    }
  }

  var stack = safe(function () { return new Error('x').stack || '' }, '')
  var stackHits = []
  if (stack.indexOf('pptr:') >= 0) stackHits.push('pptr:')
  if (stack.indexOf('puppeteer') >= 0) stackHits.push('puppeteer')
  if (stack.indexOf('playwright') >= 0) stackHits.push('playwright')
  if (stack.indexOf('__playwright') >= 0) stackHits.push('__playwright')
  if (stack.indexOf('devtools://devtools') >= 0) stackHits.push('devtools://')
  if (stackHits.length) {
    fail('error_stack', G_CDP, '错误栈特征', stackHits.join(','), '栈里出现了自动化库/DevTools 的痕迹')
  } else {
    pass('error_stack', G_CDP, '错误栈特征', '干净', '')
  }

  var nativeTargets = [
    ['permissions.query', safe(function () { return navigator.permissions.query.toString() }, '')],
    ['Function.toString', safe(function () { return Function.prototype.toString.toString() }, '')],
    ['querySelectorAll', safe(function () { return Element.prototype.querySelectorAll.toString() }, '')],
    ['addEventListener', safe(function () { return EventTarget.prototype.addEventListener.toString() }, '')]
  ]
  var patched = []
  for (var n = 0; n < nativeTargets.length; n++) {
    if (nativeTargets[n][1].indexOf('[native code]') < 0) patched.push(nativeTargets[n][0])
  }
  if (patched.length) {
    fail('native_intact', G_CDP, '原生物完整性', patched.join(','), '这些函数不是 native —— 页面里的 JS 补丁会被 toString 一眼看穿')
  } else {
    pass('native_intact', G_CDP, '原生物完整性', nativeTargets.length + ' 项', '')
  }

  var cdcKeys = []
  var scan = [window, document]
  for (var s = 0; s < scan.length; s++) {
    var keys = safe(function () { return Object.getOwnPropertyNames(scan[s]) }, [])
    for (var k = 0; k < keys.length; k++) {
      if (keys[k].indexOf('$cdc_') === 0) cdcKeys.push(keys[k])
    }
  }
  if (cdcKeys.length) {
    fail('cdc_keys', G_CDP, 'ChromeDriver 痕迹', cdcKeys.join(','), 'window/document 上有 $cdc_ 属性')
  } else {
    pass('cdc_keys', G_CDP, 'ChromeDriver 痕迹', '无', '')
  }
  // ---- 二进制层 CDP 泄漏（rebrowser-patches 那一类检测点）----
  // 上面几条针对的是「Runtime/Debugger 域被打开」；这一段针对的是**连上 CDP 就会改变、
  // 且不依赖任何 domain 的**页面侧信号：world 名注解、DevTools 工具脚本、Stack 构造器。
  // 这几条正是「自编译 + 二进制补丁」（P4）要消除的东西，所以必须能测出来。

  var worldNative = [
    ['console.log', safe(function () { return console.log.toString() }, '')],
    ['console.debug', safe(function () { return console.debug.toString() }, '')],
    ['console.info', safe(function () { return console.info.toString() }, '')],
    ['EventTarget.addEventListener', safe(function () { return EventTarget.prototype.addEventListener.toString() }, '')],
    ['Element.querySelectorAll', safe(function () { return Element.prototype.querySelectorAll.toString() }, '')],
    ['Function.prototype.toString', safe(function () { return Function.prototype.toString.toString() }, '')]
  ]
  var worldHits = []
  for (var wn = 0; wn < worldNative.length; wn++) {
    var wsrc = worldNative[wn][1]
    var wat = wsrc.indexOf('[native code]')
    if (wat < 0) continue
    var wtail = wsrc.slice(wat + 13).trim()
    // 探针自己就是从一个 IIFE 里取 toString 的，尾部可能是那个匿名函数的收尾括号
    // （实测：官方 Chrome 取到的尾部就是那个匿名函数的收尾括号）。只有出现标识符类字符
    // 才算 world 名注解，否则会把探针自己的花括号当痕迹。
    var wann = ''
    for (var wai = 0; wai < wtail.length; wai++) {
      var wch = wtail.charAt(wai)
      if (wch === '\\n' || wch === '\\r' || wch === ' ' || wch === '\\t' || wch === ')' || wch === '}') continue
      wann = wtail.slice(wai)
      break
    }
    if (wann && /[A-Za-z0-9_$]/.test(wann)) {
      worldHits.push(worldNative[wn][0] + ' → "' + wann + '"')
    }
  }
  if (worldHits.length) {
    fail('world_name_leak', G_CDP, '隔离世界名注解', worldHits.join('; '),
      'toString 的 native 尾部带了 world 名/标签 —— 这是 CDP 注入独立世界后的产物，二进制补丁就是补它')
  } else {
    pass('world_name_leak', G_CDP, '隔离世界名注解', '无', '')
  }

  var utilityHits = []
  var tmark = safe(function () { return Function.prototype.toString }, null)
  for (var ti = 0; ti < scan.length; ti++) {
    var vals = safe(function () { return Object.getOwnPropertyNames(scan[ti]) }, [])
    for (var vi = 0; vi < vals.length; vi++) {
      var vv = null
      try { vv = scan[ti][vals[vi]] } catch (e) { vv = null }
      if (!vv) continue
      var fn = null
      if (typeof vv === 'function') fn = vv
      else if (typeof vv === 'object') {
        fn = safe(function () { return vv.addEventListener }, null)
      }
      if (typeof fn !== 'function') continue
      var s = safe(function () { return tmark.call(fn) }, '')
      if (s.indexOf('utility') >= 0 || s.indexOf('VM') >= 0) utilityHits.push(vals[vi])
    }
  }
  if (utilityHits.length) {
    fail('utility_script_leak', G_CDP, 'DevTools 工具脚本残留', utilityHits.slice(0, 8).join(','),
      '页面对象上挂着 utility/VM 标签的函数，站点可以据此判定在调试')
  } else {
    pass('utility_script_leak', G_CDP, 'DevTools 工具脚本残留', '无', '')
  }

  var stackCtorHit = false
  try {
    var prevPrep = Error.prepareStackTrace
    Error.prepareStackTrace = function () { stackCtorHit = true; return 'probe' }
    console.debug(new Error('stack-probe'))
    await wait(50)
    Error.prepareStackTrace = prevPrep
  } catch (e) { /* 测不出不算发现 */ }
  if (stackCtorHit) {
    warn('stack_ctor_leak', G_CDP, 'Error.prepareStackTrace 回调', '被调用',
      '连了 CDP 的内核会给 console 调附加 Stack 构造器，从而触发这个回调（§12 表里测到过同一现象）')
  } else {
    pass('stack_ctor_leak', G_CDP, 'Error.prepareStackTrace 回调', '未被调用', '')
  }
  /* ---------------------------------------------------- 自动化标记 */

  var ua = safe(function () { return navigator.userAgent }, '')
  if (/Headless/i.test(ua)) {
    fail('ua_headless', G_AUTO, 'UA 里的 Headless', ua, 'headless 内核一读就露')
  } else {
    pass('ua_headless', G_AUTO, 'UA 里的 Headless', '无', '')
  }
  fp.userAgent = ua

  var outerW = window.outerWidth
  var outerH = window.outerHeight
  if (!outerW || !outerH) {
    fail('outer_size', G_AUTO, 'window.outerWidth/Height', outerW + 'x' + outerH, 'headless 下外窗尺寸为 0')
  } else {
    pass('outer_size', G_AUTO, 'window.outerWidth/Height', outerW + 'x' + outerH, '')
  }

  var notifPermission = safe(function () { return Notification.permission }, 'unknown')
  if (notifPermission === 'denied') {
    warn('notif_permission', G_AUTO, 'Notification.permission', notifPermission, 'headless 常见 denied，有头浏览器默认 default')
  } else {
    pass('notif_permission', G_AUTO, 'Notification.permission', notifPermission, '')
  }

  var pluginCount = safe(function () { return navigator.plugins.length }, -1)
  var pluginNames = safe(function () {
    var names = []
    for (var i = 0; i < navigator.plugins.length; i++) names.push(navigator.plugins[i].name)
    return names
  }, [])
  fp.plugins = pluginNames
  if (pluginCount <= 0) {
    fail('plugins', G_AUTO, 'navigator.plugins', pluginCount, '插件列表为空是 headless 的强特征')
  } else {
    pass('plugins', G_AUTO, 'navigator.plugins', pluginCount + ' 个', pluginNames.join(' / '))
  }

  var mimeCount = safe(function () { return navigator.mimeTypes.length }, -1)
  if (mimeCount <= 0) {
    warn('mime_types', G_AUTO, 'navigator.mimeTypes', mimeCount, '与 plugins 同步为空')
  } else {
    pass('mime_types', G_AUTO, 'navigator.mimeTypes', mimeCount + ' 个', '')
  }

  var languages = safe(function () { return navigator.languages.slice() }, [])
  if (languages.length === 0) {
    fail('languages', G_AUTO, 'navigator.languages', '[]', '空语言列表是自动化环境特征')
  } else {
    pass('languages', G_AUTO, 'navigator.languages', languages.join(','), '')
  }
  fp.languages = languages

  var cores = safe(function () { return navigator.hardwareConcurrency }, 0)
  if (!cores) {
    fail('hardware_concurrency', G_AUTO, 'navigator.hardwareConcurrency', cores, '为 0 说明没有被真实硬件信息填充')
  } else {
    pass('hardware_concurrency', G_AUTO, 'navigator.hardwareConcurrency', cores, '')
  }
  fp.hardwareConcurrency = cores

  /* ---------------------------------------------------- 指纹一致性（只记录，不判死） */

  var gl = null
  var glVendor = null
  var glRenderer = null
  try {
    var canvas = document.createElement('canvas')
    gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl')
    if (gl) {
      var dbg = gl.getExtension('WEBGL_debug_renderer_info')
      if (dbg) {
        glVendor = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL))
        glRenderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
      } else {
        glVendor = String(gl.getParameter(gl.VENDOR))
        glRenderer = String(gl.getParameter(gl.RENDERER))
      }
    }
  } catch (e) { /* 没有 WebGL 的环境也要能出报告 */ }
  fp.webgl = { vendor: glVendor, renderer: glRenderer }
  if (glRenderer && /SwiftShader|swiftshader|Software|llvmpipe/i.test(glRenderer)) {
    fail('webgl_swiftshader', G_AUTO, 'WebGL 渲染器', glRenderer, '软件光栅化是 headless 特征，说明 GPU 没接上')
  } else if (glRenderer) {
    pass('webgl_swiftshader', G_AUTO, 'WebGL 渲染器', glRenderer, '')
  } else {
    note('webgl_swiftshader', G_AUTO, 'WebGL 渲染器', null, '拿不到 WebGL 上下文（可能被隐私策略屏蔽）')
  }

  var canvasHash = null
  try {
    var cc = document.createElement('canvas')
    cc.width = 220
    cc.height = 40
    var cx = cc.getContext('2d')
    cx.textBaseline = 'top'
    cx.font = '14px Arial'
    cx.fillStyle = '#f60'
    cx.fillRect(0, 0, 220, 40)
    cx.fillStyle = '#069'
    cx.fillText('monitor-probe-指纹', 2, 8)
    cx.fillStyle = 'rgba(102, 204, 0, 0.7)'
    cx.fillText('monitor-probe-指纹', 4, 12)
    var gradient = cx.createLinearGradient(0, 0, 220, 0)
    gradient.addColorStop(0, '#abc')
    gradient.addColorStop(1, '#123')
    cx.fillStyle = gradient
    cx.fillRect(40, 20, 160, 16)
    var data = cx.getImageData(0, 0, 220, 40).data
    var acc = ''
    for (var p = 0; p < data.length; p += 397) acc += String(data[p])
    canvasHash = hash32(acc)
  } catch (e) { canvasHash = null }
  fp.canvasHash = canvasHash
  note('canvas_hash', G_FP, 'Canvas 指纹', canvasHash, canvasHash ? '同一台机器应当稳定复现' : 'Canvas 被屏蔽')

  var audioHash = null
  try {
    var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext
    if (OAC) {
      var renderAudio = function () {
        return new Promise(function (resolve) {
          var ctx = new OAC(1, 4410, 44100)
          var osc = ctx.createOscillator()
          osc.type = 'triangle'
          osc.frequency.value = 10000
          var comp = ctx.createDynamicsCompressor()
          osc.connect(comp)
          comp.connect(ctx.destination)
          osc.start(0)
          ctx.startRendering().then(function (buffer) {
            var channel = buffer.getChannelData(0)
            var sum = 0
            for (var i = 0; i < channel.length; i++) sum += Math.abs(channel[i])
            resolve(hash32(sum.toFixed(6)))
          }).catch(function () { resolve(null) })
        })
      }
      audioHash = await Promise.race([
        renderAudio(),
        new Promise(function (resolve) { setTimeout(function () { resolve(null) }, 1500) })
      ])
    }
  } catch (e) { audioHash = null }
  fp.audioHash = audioHash
  note('audio_hash', G_FP, 'Audio 指纹', audioHash, audioHash ? '' : '取不到（可能被屏蔽或超时）')

  var fontList = ['Arial', 'Courier New', 'Georgia', 'Times New Roman', 'Verdana', 'Tahoma',
    'Microsoft YaHei', 'SimSun', 'SimHei', 'KaiTi', 'Segoe UI', 'Consolas', 'Cambria', 'Impact']
  var present = []
  try {
    var measure = document.createElement('canvas').getContext('2d')
    for (var f = 0; f < fontList.length; f++) {
      measure.font = '16px monospace'
      var baseWidth = measure.measureText('mmmmmmmmmmlli').width
      measure.font = '16px "' + fontList[f] + '", monospace'
      var testWidth = measure.measureText('mmmmmmmmmmlli').width
      if (Math.abs(testWidth - baseWidth) > 0.5) present.push(fontList[f])
    }
  } catch (e) { /* 字体探测失败就不记录 */ }
  fp.fonts = present
  note('fonts', G_FP, '字体探测', present.length + '/' + fontList.length, present.join(' / '))

  fp.platform = safe(function () { return navigator.platform }, null)
  fp.vendor = safe(function () { return navigator.vendor }, null)
  fp.userAgentData = safe(function () {
    if (!navigator.userAgentData) return null
    return {
      brands: navigator.userAgentData.brands.map(function (b) { return b.brand + ' ' + b.version }),
      mobile: navigator.userAgentData.mobile,
      platform: navigator.userAgentData.platform
    }
  }, null)
  fp.timezone = safe(function () { return Intl.DateTimeFormat().resolvedOptions().timeZone }, null)
  fp.locale = safe(function () { return Intl.DateTimeFormat().resolvedOptions().locale }, null)
  fp.screen = safe(function () {
    return {
      width: screen.width, height: screen.height,
      availWidth: screen.availWidth, availHeight: screen.availHeight,
      colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth,
      devicePixelRatio: window.devicePixelRatio
    }
  }, null)
  fp.deviceMemory = safe(function () { return navigator.deviceMemory }, null)
  note('fingerprint_core', G_FP, '平台/时区/屏幕', [
    fp.platform, fp.timezone, fp.screen ? fp.screen.width + 'x' + fp.screen.height : null
  ].join(' · '), 'UA 一致性对照见表头')

  var mediaCount = -1
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      var devices = await navigator.mediaDevices.enumerateDevices()
      mediaCount = devices.length
    }
  } catch (e) { mediaCount = -1 }
  fp.mediaDevices = mediaCount
  if (mediaCount === 0) {
    warn('media_devices', G_AUTO, '媒体设备数', 0, '一个设备都没有，headless 容器里很常见')
  } else {
    note('media_devices', G_FP, '媒体设备数', mediaCount, '')
  }

  /* ---------------------------------------------------- 运行环境 */

  note('document_state', G_ENV, '文档状态', document.readyState + (document.hasFocus() ? ' · focused' : '') ,
    'visibility=' + document.visibilityState)
  if (document.visibilityState !== 'visible') {
    warn('page_visibility', G_ENV, 'Page.visibilityState', document.visibilityState,
      '被监控窗口不在前台/被遮挡：rAF 会被节流、页面行为也会变形，真实用户场景对不上')
  } else {
    pass('page_visibility', G_ENV, 'Page.visibilityState', 'visible', '')
  }
  fp.chromeObject = safe(function () {
    if (!window.chrome) return null
    return { keys: Object.keys(window.chrome), hasRuntime: Boolean(window.chrome.runtime) }
  }, null)
  if (!window.chrome) {
    warn('chrome_object', G_AUTO, 'window.chrome', '缺失', '真实 Chromium 上应当存在；缺失通常意味着被裁剪或伪装')
  } else {
    pass('chrome_object', G_AUTO, 'window.chrome', '存在', '')
  }
  note('connection', G_ENV, '网络类型', safe(function () {
    var c = navigator.connection
    return c ? (c.effectiveType + ' · ' + (c.downlink || 0) + 'Mbps · rtt ' + (c.rtt || 0)) : null
  }, null), '')

  /* ---------------------------------------------------- 汇总 */

  var summary = { pass: 0, warn: 0, fail: 0, info: 0 }
  for (var q = 0; q < checks.length; q++) {
    var st = checks[q].status
    if (summary[st] !== undefined) summary[st] += 1
  }
  var hardFails = []
  for (var r2 = 0; r2 < checks.length; r2++) {
    if (checks[r2].status === 'fail' && (checks[r2].group === G_CDP || checks[r2].group === G_AUTO)) {
      hardFails.push(checks[r2].id)
    }
  }
  var recommend = hardFails.length > 0 ? 'H' : 'L'
  var reason = hardFails.length > 0
    ? ('检出 ' + hardFails.length + ' 项硬痕迹（' + hardFails.join(', ') + '），目标站点有机会判定自动化，应当切 Profile H')
    : '未检出硬痕迹，Profile L 的完整能力可以直接用'

  var report = {
    version: 1,
    run: run,
    ts: Date.now(),
    durationMs: Date.now() - started,
    url: location.href,
    title: document.title || '',
    readyState: document.readyState,
    checks: checks,
    fingerprint: fp,
    summary: summary,
    recommend: recommend,
    reason: reason
  }

  // 信标回传：Profile H 下没有 Runtime，报告只能靠这条信道回去。
  // 请求会被 Fetch 域拦下并 fulfill 204，不会真的出网。
  try {
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      var json = JSON.stringify(report)
      var bytes = new TextEncoder().encode(json)
      var bin = ''
      for (var b = 0; b < bytes.length; b++) bin += String.fromCharCode(bytes[b])
      var b64 = btoa(bin).split('+').join('-').split('/').join('_')
      while (b64.length > 0 && b64.charAt(b64.length - 1) === '=') b64 = b64.slice(0, -1)
      var total = Math.max(1, Math.ceil(b64.length / ${CHUNK_CHARS}))
      for (var c2 = 0; c2 < total; c2++) {
        var part = b64.slice(c2 * ${CHUNK_CHARS}, (c2 + 1) * ${CHUNK_CHARS})
        var img = new Image()
        img.src = '${PROBE_ENDPOINT}?v=1&r=' + run + '&i=' + c2 + '&n=' + total + '&d=' + part
      }
    }
  } catch (e) { /* 回传失败不影响返回值 */ }

  return report
})()`
/* ------------------------------------------------------------------ 信道 */

interface ProbeRunBuffer {
  total: number
  parts: Map<number, string>
  at: number
}

/**
 * 探针信道的落地端。
 *
 * 上游有两个使用者：
 *   - BodyCapture 在 Fetch 的 Request 阶段认出信标请求，把 URL 交给 feed() 再 fulfill 204；
 *   - ProbeRunner 等 report 事件拿报告。
 * runId 由页面侧随机生成，所以并发跑两次探针不会串片。
 */
export class ProbeChannel extends EventEmitter {
  private readonly runs = new Map<string, ProbeRunBuffer>()
  private received = 0
  private broken = 0

  matches(url: string): boolean {
    return isProbeUrl(url)
  }

  getStats(): { received: number; broken: number; pending: number } {
    return { received: this.received, broken: this.broken, pending: this.runs.size }
  }

  /** 解析一条信标 URL。凑齐所有分片就 emit('report', report) */
  feed(url: string): void {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    const runId = parsed.searchParams.get('r') ?? 'anon'
    const index = Number(parsed.searchParams.get('i') ?? '0')
    const total = Math.max(1, Number(parsed.searchParams.get('n') ?? '1'))
    const data = parsed.searchParams.get('d') ?? ''
    if (!Number.isFinite(index) || !Number.isFinite(total)) return

    this.received += 1
    let buffer = this.runs.get(runId)
    if (!buffer) {
      buffer = { total, parts: new Map(), at: Date.now() }
      this.runs.set(runId, buffer)
      this.sweep()
    }
    buffer.parts.set(index, data)
    if (buffer.parts.size < buffer.total) return

    let joined = ''
    for (let i = 0; i < buffer.total; i += 1) {
      const part = buffer.parts.get(i)
      if (part === undefined) return
      joined += part
    }
    this.runs.delete(runId)

    try {
      const report = JSON.parse(Buffer.from(joined, 'base64url').toString('utf8')) as ProbeReport
      if (!report || !Array.isArray(report.checks)) throw new Error('报告结构不对')
      this.emit('report', report)
    } catch (error) {
      this.broken += 1
      this.emit('log', `[probe] 回传解析失败: ${(error as Error).message}`)
    }
  }

  /** 等下一份完整报告。超时抛错 —— 静默返回空报告会让「探针没跑起来」看起来像「全过」 */
  nextReport(timeoutMs: number): Promise<ProbeReport> {
    return new Promise<ProbeReport>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('report', onReport)
        reject(new Error(`探针回传超时（${timeoutMs}ms）：注入脚本没有把报告发回来`))
      }, timeoutMs)
      const onReport = (report: ProbeReport): void => {
        clearTimeout(timer)
        resolve(report)
      }
      this.once('report', onReport)
    })
  }

  /** 半截的分片不能永远留着，30 秒还没凑齐就丢 */
  private sweep(): void {
    const deadline = Date.now() - 30_000
    for (const [runId, buffer] of this.runs) {
      if (buffer.at < deadline) this.runs.delete(runId)
    }
  }
}

/* ------------------------------------------------------------------ 执行器 */

export interface ProbeRunOptions {
  timeoutMs?: number
  /** 强制走注入 + 回传那条路，用来验证 Profile H 的信道 */
  viaInject?: boolean
}

export class ProbeRunner {
  constructor(
    private readonly cdp: CdpClient,
    private readonly channel: ProbeChannel,
    private readonly profile: string,
    /** Profile H 下没有 Runtime，只能走注入 */
    private readonly runtimeAllowed: boolean
  ) {}

  get canEvaluate(): boolean {
    return this.runtimeAllowed
  }

  async run(sessionId: string, options: ProbeRunOptions = {}): Promise<ProbeReport> {
    const timeoutMs = options.timeoutMs ?? 12_000
    const report =
      options.viaInject || !this.runtimeAllowed
        ? await this.runByInject(sessionId, timeoutMs)
        : await this.runByEvaluate(sessionId, timeoutMs)
    return { ...report, profile: this.profile }
  }

  private async runByEvaluate(sessionId: string, timeoutMs: number): Promise<ProbeReport> {
    const result = (await this.cdp.send(
      'Runtime.evaluate',
      {
        expression: PROBE_SOURCE,
        awaitPromise: true,
        returnByValue: true,
        allowUnsafeEvalBlockedByCSP: true,
        timeout: timeoutMs
      },
      sessionId
    )) as {
      result?: { value?: ProbeReport; description?: string; subtype?: string }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }

    if (result.exceptionDetails) {
      throw new Error(
        '探针执行异常: ' +
          (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '未知')
      )
    }
    const value = result.result?.value
    if (!value || !Array.isArray(value.checks)) {
      throw new Error('探针没有返回报告: ' + (result.result?.description ?? result.result?.subtype ?? '空'))
    }
    return value
  }

  /**
   * 注入 + 回传。要点：脚本必须在**文档创建之前**注册，所以先 add 再 reload，
   * 跑完立刻 remove —— 探针绝不该长期驻留在被监控页面里（§8.2）。
   */
  private async runByInject(sessionId: string, timeoutMs: number): Promise<ProbeReport> {
    const { identifier } = (await this.cdp.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: PROBE_SOURCE },
      sessionId
    )) as { identifier: string }

    const wait = this.channel.nextReport(timeoutMs)
    try {
      await this.cdp.send('Page.reload', { ignoreCache: true }, sessionId)
      return await wait
    } finally {
      void this.cdp
        .send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, sessionId)
        .catch(() => undefined)
    }
  }
}

/** 面板里要显示探针能力，别让用户点了没反应 */
export function probeCapability(profile: string, runtimeAllowed: boolean): string {
  if (runtimeAllowed) return 'Runtime.evaluate（Profile ' + profile + '）'
  return '注入 + 信标回传（Profile ' + profile + '，无 Runtime）'
}
