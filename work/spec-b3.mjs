export default [
  {
    file: 'scripts/test-layout.mjs',
    label: 'B3 标题不再提防抖',
    old: `check('B3 拖完落的盘和界面一致（防抖 400ms 之后）', () => {`,
    new: `check('B3 拖完落的盘和界面一致', () => {`
  }
]