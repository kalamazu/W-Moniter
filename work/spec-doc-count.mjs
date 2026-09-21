export default [
  {
    file: 'README.md',
    label: '1 状态表 22→23',
    old: `| 自由工作区：1–4 栏 / 每栏自选面板 / 可拖分隔条 / 布局落盘 | ✅ 22/22（\`npm run test:layout\`） |`,
    new: `| 自由工作区：1–4 栏 / 每栏自选面板（十个面板都在栏头下拉框里）/ 可拖分隔条 / 布局落盘 | ✅ 23/23（\`npm run test:layout\`） |`
  },
  {
    file: 'README.md',
    label: '2 验收数据段标题 + 明细补 A4',
    old: `\`npm run test:layout\` —— 自由工作区验收 **22/22 通过**。`,
    new: `\`npm run test:layout\` —— 自由工作区验收 **23/23 通过**。`
  },
  {
    file: 'README.md',
    label: '3 明细里补 A4 一行',
    old: `   顶栏是「＋ 分栏 / ⇔ 左右 / ⟲ 复位」三个按钮                          ✓`,
    new: `   顶栏是「＋ 分栏 / ⇔ 左右 / ⟲ 复位」三个按钮                          ✓
   栏头下拉框列全十个面板（瀑布图 / 统计 / 会话都在这）                  ✓`
  },
  {
    file: 'README.md',
    label: '4 命令清单 22→23',
    old: `npm run test:layout        # 自由工作区验收（22 项，合成鼠标事件拖分隔条，跑时别碰鼠标）`,
    new: `npm run test:layout        # 自由工作区验收（23 项，合成鼠标事件拖分隔条，跑时别碰鼠标）`
  },
  {
    file: 'README.md',
    label: '5 目录结构 22→23',
    old: `  test-layout.mjs             自由工作区验收（22 项：分栏 / 拖动 / 落盘 / 重启恢复）`,
    new: `  test-layout.mjs             自由工作区验收（23 项：分栏 / 拖动 / 面板选择 / 落盘 / 重启恢复）`
  },
  {
    file: 'README.md',
    label: '6 F1 那行补「真的渲染出来」',
    old: `F  ＋ 分栏 → 新栏放的是还没露面的面板                                    ✓`,
    new: `F  ＋ 分栏 → 新栏放的是还没露面的面板，且瀑布图真的渲染出来了            ✓`
  },
  {
    file: 'docs/设计文档.md',
    label: '7 D10 里 22→23',
    old: `验收 \`npm run test:layout\`（22 项：往渲染进程里合成 \`mousedown\`/\`mousemove\`/\`mouseup\`，判据取`,
    new: `验收 \`npm run test:layout\`（23 项：往渲染进程里合成 \`mousedown\`/\`mousemove\`/\`mouseup\`，判据取`
  },
  {
    file: 'docs/使用手册.md',
    label: '8 4.1 说清下拉框里有什么',
    old: `- 每栏栏头有个下拉框，选这一栏显示什么；栏头的 \`✕\` 关掉这一栏（只剩一栏时不显示，免得工作区空掉）`,
    new: `- 每栏栏头那颗胶囊下拉框就是「这一栏显示什么」，**十个面板全在里面**（瀑布图、统计、脚本、规则、
  控制台、环境、DOM、会话都在）；栏头的 \`✕\` 关掉这一栏（只剩一栏时不显示，免得工作区空掉）`
  }
]