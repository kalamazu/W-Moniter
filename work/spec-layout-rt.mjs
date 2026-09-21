const LV = 'F:/code/chrome/scripts/test-layout.mjs'
const NAMES = "['瀑布图', '统计', '会话', '环境', 'DOM', '脚本', '规则', '控制台', '请求列表', '请求详情', '事件流', 'WebSocket', '接口画像', '调用图']"

export default [
  {
    file: LV,
    label: '面板清单判据改成 14 个（含实时分析四面板）',
    old: `check('A4 栏头下拉框列全了十个面板（瀑布图 / 统计 / 会话都在这）', () => {
  const options = s.panes[0].options
  assert(options.length === 10, '选项数应为 10，实际 ' + options.length + '：' + options.join('/'))
  for (const name of ['瀑布图', '统计', '会话', '环境', 'DOM', '脚本', '规则', '控制台', '请求列表', '请求详情']) {
    assert(options.includes(name), '下拉框里少了「' + name + '」')
  }
  assert(s.panes[1].options.length === 10, '每一栏的下拉框都该是同一份全量列表')
})`,
    new: `check('A4 栏头下拉框列全了十四个面板（瀑布图 / 统计 / 会话 / 实时分析四个都在这）', () => {
  const ALL = ${NAMES}
  const options = s.panes[0].options
  assert(options.length === ALL.length, '选项数应为 ' + ALL.length + '，实际 ' + options.length + '：' + options.join('/'))
  for (const name of ALL) {
    assert(options.includes(name), '下拉框里少了「' + name + '」')
  }
  assert(s.panes[1].options.length === ALL.length, '每一栏的下拉框都该是同一份全量列表')
})`
  }
]