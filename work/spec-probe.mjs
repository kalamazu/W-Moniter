export default [
  {
    file: 'scripts/test-probe.mjs',
    label: '环境面板改为「已在栏里就直接用」',
    old: `  // 挂上调试目标时 React 往往还没挂载，必须等元素出现，而不是查一次没有就判死
  const tabs = await waitFor('.tabs', 30000)
  if (!tabs) return { ok: false, reason: 'no-tabs', html: document.body.innerHTML.slice(0, 300) }
  const tab = [...document.querySelectorAll('.tab')].find((b) => b.textContent.trim() === '环境')
  if (!tab) return { ok: false, reason: 'no-env-tab', html: tabs.innerHTML.slice(0, 300) }
  tab.click()
  const button = await waitFor('.probe-run', 20000)`,
    new: `  // 挂上调试目标时 React 往往还没挂载，必须等元素出现，而不是查一次没有就判死
  // 自由工作区之后没有「环境 tab」了：?tab=env 开局就把环境面板摆进栏里。老版界面
  // 还要点一下 tab，所以两种都认：先等面板，等不到再找 tab 点。
  let button = await waitFor('.probe-run', 12000)
  if (!button) {
    const tabs = await waitFor('.tabs', 10000)
    if (!tabs) return { ok: false, reason: 'no-tabs', html: document.body.innerHTML.slice(0, 300) }
    const tab = [...document.querySelectorAll('.tab')].find((b) => b.textContent.trim() === '环境')
    if (!tab) return { ok: false, reason: 'no-env-panel', html: tabs.innerHTML.slice(0, 300) }
    tab.click()
    button = await waitFor('.probe-run', 20000)
  }`
  }
]