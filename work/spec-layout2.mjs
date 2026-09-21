export default [
  {
    file: 'scripts/test-layout.mjs',
    label: '1 SNAP 带上下拉框选项',
    old: `      const pick = el.querySelector('.pane-pick')
      const body = el.querySelector('.pane-body')
      return {
        pick: pick ? pick.value : null,`,
    new: `      const pick = el.querySelector('.pane-pick')
      const body = el.querySelector('.pane-body')
      return {
        pick: pick ? pick.value : null,
        // 栏头下拉框里列出的面板名 —— 「瀑布图 / 统计那些去哪了」就靠它兜底
        options: pick ? Array.from(pick.options).map((o) => o.textContent.trim()) : [],`
  },
  {
    file: 'scripts/test-layout.mjs',
    label: '2 加 A4：下拉框列全十个面板',
    old: `/* ------------------------------------------------- B 拖动分隔条 */`,
    new: `check('A4 栏头下拉框列全了十个面板（瀑布图 / 统计 / 会话都在这）', () => {
  const options = s.panes[0].options
  assert(options.length === 10, '选项数应为 10，实际 ' + options.length + '：' + options.join('/'))
  for (const name of ['瀑布图', '统计', '会话', '环境', 'DOM', '脚本', '规则', '控制台', '请求列表', '请求详情']) {
    assert(options.includes(name), '下拉框里少了「' + name + '」')
  }
  assert(s.panes[1].options.length === 10, '每一栏的下拉框都该是同一份全量列表')
})

/* ------------------------------------------------- B 拖动分隔条 */`
  },
  {
    file: 'scripts/test-layout.mjs',
    label: '3 F1 补：瀑布图真的渲染出来了',
    old: `check('F1 ＋ 分栏 → 新栏放的是还没露面的面板（这里是瀑布图）', () => {
  assert(two.panes.length === 2, '应 2 栏，实际 ' + two.panes.length)
  assert(picksOf(two).join(',') === 'list,waterfall', '期望 list,waterfall，实际 ' + picksOf(two).join(','))
})`,
    new: `check('F1 ＋ 分栏 → 新栏放的是还没露面的面板（这里是瀑布图），且真的渲染出来了', () => {
  assert(two.panes.length === 2, '应 2 栏，实际 ' + two.panes.length)
  assert(picksOf(two).join(',') === 'list,waterfall', '期望 list,waterfall，实际 ' + picksOf(two).join(','))
  assert(two.panes[1].bodyClass.indexOf('waterfall') >= 0,
    '新栏里没有瀑布图，实际 body 里是 "' + two.panes[1].bodyClass + '"')
})`
  }
]