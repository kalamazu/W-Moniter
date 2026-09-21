export default [
  {
    file: 'work/shots-layout.mjs',
    label: '导入路径',
    old: `import { launchApp, sleep, ROOT } from './app-harness.mjs'
import { startOrigin } from './test-origin.mjs'`,
    new: `import { launchApp, sleep, ROOT } from '../scripts/app-harness.mjs'
import { startOrigin } from '../scripts/test-origin.mjs'`
  }
]