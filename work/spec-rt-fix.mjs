export default [
  {
    file: 'F:/code/chrome/storage/server.mjs',
    label: 'schemaToPaths：父层的 optional 要往下传',
    old: "      // seen 少于样本数 = 不是每个样本里都有。契约里「必现」和「可选」是两回事\n      schemaToPaths(child, path, out, (child.seen ?? 0) < (schema.count ?? 1))",
    new: "      // seen 少于样本数 = 不是每个样本里都有。契约里「必现」和「可选」是两回事。\n      // 父层已经判成可选时得并上（or）—— 不然 bonus.deep 这种「整个 bonus 只在一半样本里」\n      // 的字段会被子层自己的 seen==count 抹成必现，契约回归就漏报\n      schemaToPaths(child, path, out, optional || (child.seen ?? 0) < (schema.count ?? 1))"
  },
  {
    file: 'F:/code/chrome/src/shared/types.ts',
    label: 'RequestRecord 加 reqBody',
    old: "  /** 响应头，来自 Network.responseReceivedExtraInfo。缓存/SW 命中时可能没有 */\n  respHeaders?: HeaderMap",
    new: "  /** 响应头，来自 Network.responseReceivedExtraInfo。缓存/SW 命中时可能没有 */\n  respHeaders?: HeaderMap\n  /**\n   * 请求体原文。来自 requestWillBeSent 的 request.postData（CDP 只在这一处给）。\n   * 画像里的「请求体字段分布」与契约回归的「新字段」全靠它。\n   */\n  reqBody?: string"
  },
  {
    file: 'F:/code/chrome/src/main/storage/client.ts',
    label: 'client 落 req_body',
    old: "    req_body: null,",
    new: "    req_body: record.reqBody ?? null,"
  },
  {
    file: 'F:/code/chrome/src/main/browser/collector.ts',
    label: 'CDP 请求结构补 postData',
    old: "  request: {\n    url: string\n    method: string\n  }",
    new: "  request: {\n    url: string\n    method: string\n    /** 请求体原文。CDP 只在 requestWillBeSent 这一处给（见 reqBody） */\n    postData?: string\n    hasPostData?: boolean\n  }"
  },
  {
    file: 'F:/code/chrome/src/main/browser/collector.ts',
    label: '采集请求体',
    old: "    if (p.initiator) {\n      record.initiatorType = p.initiator.type ?? 'other'\n      record.initiator = toInitiator(p.initiator)\n    }",
    new: "    if (p.initiator) {\n      record.initiatorType = p.initiator.type ?? 'other'\n      record.initiator = toInitiator(p.initiator)\n    }\n    // 请求体：CDP 只在 requestWillBeSent 里给一次，错过就没了。\n    // 大 body 会被剪（Chrome 自己也会剪），剪了就不保证还能当 JSON 解析 ——\n    // 但「有请求体」和「前 64KB 长什么样」本身就是要留下的信息\n    if (typeof p.request.postData === 'string' && p.request.postData.length > 0) {\n      record.reqBody =\n        p.request.postData.length > REQ_BODY_MAX\n          ? p.request.postData.slice(0, REQ_BODY_MAX)\n          : p.request.postData\n    }"
  },
  {
    file: 'F:/code/chrome/src/main/browser/collector.ts',
    label: 'REQ_BODY_MAX 常量',
    old: "/** extraInfo 旁路缓冲的上限：它只是「先到先存」，不能涨成内存泄漏 */\nconst MAX_EXTRA_INFO = 1024",
    new: "/** extraInfo 旁路缓冲的上限：它只是「先到先存」，不能涨成内存泄漏 */\nconst MAX_EXTRA_INFO = 1024\n\n/** 请求体保留上限。比响应体的 256KB 小：请求体常在内存里跟着 record 走 */\nconst REQ_BODY_MAX = 64 * 1024"
  },
  {
    file: 'F:/code/chrome/src/main/browser/collector.ts',
    label: 'Collector 收下 downloadDir',
    old: "    /** 探针信道：信标请求要在这里被认出来，别当成页面流量 */\n    private readonly probe: ProbeChannel | null = null\n  ) {",
    new: "    /** 探针信道：信标请求要在这里被认出来，别当成页面流量 */\n    private readonly probe: ProbeChannel | null = null,\n    /** 下载落盘目录。自动化跑一遍不该往用户的 Downloads 里丢东西 */\n    private readonly downloadDir: string | null = null\n  ) {"
  },
  {
    file: 'F:/code/chrome/src/main/browser/collector.ts',
    label: 'start() 里设下载目录',
    old: "  async start(): Promise<void> {\n    await this.cdp.send('Target.setDiscoverTargets', { discover: true })",
    new: "  async start(): Promise<void> {\n    await this.cdp.send('Target.setDiscoverTargets', { discover: true })\n\n    // 下载落到本次会话的数据目录里。两个理由：自动化不该用用户的下载夹；\n    // 「文件真的落了盘」是验收与事后取证都要的外部证据。\n    // eventsEnabled 让 Browser.downloadWillBegin/Progress 也上来（Page 域那份照旧，去重在 claimDownload）\n    if (this.downloadDir) {\n      await this.cdp\n        .send('Browser.setDownloadBehavior', {\n          behavior: 'allow',\n          downloadPath: this.downloadDir,\n          eventsEnabled: true\n        })\n        .catch(() => undefined)\n    }"
  },
  {
    file: 'F:/code/chrome/src/main/controller.ts',
    label: 'ControllerOptions 加 downloadDir',
    old: "  captureBodies: boolean\n  bodyMaxBytes: number",
    new: "  captureBodies: boolean\n  /** 下载落盘目录（默认 <数据目录>/downloads）。设空串就交回浏览器默认行为 */\n  downloadDir?: string\n  bodyMaxBytes: number"
  },
  {
    file: 'F:/code/chrome/src/main/controller.ts',
    label: '把 downloadDir 交给 Collector',
    old: "      this.collector = new Collector(\n        this.cdp,\n        this.profile,\n        bodyConfig,\n        scriptConfig,\n        this.rules,\n        this.probeChannel\n      )",
    new: "      this.collector = new Collector(\n        this.cdp,\n        this.profile,\n        bodyConfig,\n        scriptConfig,\n        this.rules,\n        this.probeChannel,\n        this.options.downloadDir ?? null\n      )"
  },
  {
    file: 'F:/code/chrome/src/main/index.ts',
    label: 'index 定出下载目录（可用 MONITOR_DOWNLOAD_DIR 覆盖）',
    old: "const PROFILE_DIR = process.env['MONITOR_PROFILE_DIR'] ?? join(DATA_DIR, 'browser-profile')",
    new: "const PROFILE_DIR = process.env['MONITOR_PROFILE_DIR'] ?? join(DATA_DIR, 'browser-profile')\n/** 下载目录。空串 = 用浏览器默认的下载夹（老行为） */\nconst DOWNLOAD_DIR = process.env['MONITOR_DOWNLOAD_DIR'] ?? join(DATA_DIR, 'downloads')"
  },
  {
    file: 'F:/code/chrome/src/main/index.ts',
    label: 'index 建目录并传下去',
    old: "    dbPath: DB_PATH,\n    captureBodies: CAPTURE_BODIES,",
    new: "    dbPath: DB_PATH,\n    downloadDir: DOWNLOAD_DIR,\n    captureBodies: CAPTURE_BODIES,"
  },
  {
    file: 'F:/code/chrome/src/main/index.ts',
    label: 'index 导入 mkdirSync、建下载目录',
    old: "import { existsSync } from 'node:fs'",
    new: "import { existsSync, mkdirSync } from 'node:fs'"
  },
  {
    file: 'F:/code/chrome/src/main/index.ts',
    label: 'index 启动时创建下载目录',
    old: "const UI_TAB = process.env['MONITOR_UI_TAB'] ?? ''",
    new: "// Chrome 不会替我们建这个目录（setDownloadBehavior 指过去但目录不存在时下载会失败）\nif (DOWNLOAD_DIR) {\n  try {\n    mkdirSync(DOWNLOAD_DIR, { recursive: true })\n  } catch {\n    /* 建不出来就交给浏览器默认行为，不因为它起不来 */\n  }\n}\n\nconst UI_TAB = process.env['MONITOR_UI_TAB'] ?? ''"
  }
]