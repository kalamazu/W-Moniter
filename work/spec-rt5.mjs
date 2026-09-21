const RT = 'F:/code/chrome/scripts/test-realtime.mjs'

export default [
  {
    file: RT,
    label: '下载 completed 改等待',
    old: `  await check('下载被记下来了，文件名与页面点的一致，并且走到了 completed', async () => {
    const rows = await downloadEvents()
    const begin = rows.find((row) => row.detail?.event === 'begin')
    assert(begin, \`没有 begin 事件：\${JSON.stringify(rows)}\`)
    assert(begin.detail.filename === DOWNLOAD_NAME, \`filename=\${begin.detail.filename}\`)
    assert(String(begin.url ?? '').includes('/download.txt'), \`url=\${begin.url}\`)
    const done = rows.find((row) => row.detail?.event === 'completed')
    assert(done, \`没有走到 completed：\${JSON.stringify(rows.map((r) => r.detail?.event))}\`)
    assert(done.detail.receivedBytes > 0, \`completed 的字节数是 \${done.detail.receivedBytes}\`)
  })`,
    new: `  await check('下载被记下来了，文件名与页面点的一致，并且走到了 completed', async () => {
    // 下载是异步的：begin/inProgress 先到、completed 后到。这里等它，而不是拿到 begin 就断言
    const done = await waitFor(
      '下载走到 completed',
      async () => (await downloadEvents()).find((row) => row.detail?.event === 'completed') ?? null,
      20000,
      250
    )
    const rows = await downloadEvents()
    const begin = rows.find((row) => row.detail?.event === 'begin')
    assert(begin, \`没有 begin 事件：\${JSON.stringify(rows)}\`)
    assert(begin.detail.filename === DOWNLOAD_NAME, \`filename=\${begin.detail.filename}\`)
    assert(String(begin.url ?? '').includes('/download.txt'), \`url=\${begin.url}\`)
    assert(done.detail.receivedBytes > 0, \`completed 的字节数是 \${done.detail.receivedBytes}\`)
    assert(done.id > begin.id, \`completed(\${done.id}) 排在 begin(\${begin.id}) 之前\`)
  })`
  },
  {
    file: RT,
    label: '下载文件落盘改等待',
    old: `  await check(\`下载的文件真的落到了磁盘（\${downloadPath}）\`, async () => {
    assert(existsSync(downloadPath), \`文件不存在：\${downloadPath}\`)`,
    new: `  await check(\`下载的文件真的落到了磁盘（\${downloadPath}）\`, async () => {
    await waitFor('下载文件落盘', async () => (existsSync(downloadPath) ? true : null), 15000, 200)
    assert(existsSync(downloadPath), \`文件不存在：\${downloadPath}\`)`
  }
]