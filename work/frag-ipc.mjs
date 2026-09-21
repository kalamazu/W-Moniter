
  /* ------------------------------------- 分析层：事件流 / WS / 画像 / 导出 */

  ipcMain.handle('monitor:events', async (_event, query: EventQuery) =>
    (await controller?.queryEvents(query)) ?? null
  )

  ipcMain.handle('monitor:event-stats', async () => (await controller?.getEventStats()) ?? null)

  ipcMain.handle('monitor:ws-frames', async (_event, query: WsFrameQuery) =>
    (await controller?.queryWsFrames(query)) ?? null
  )

  ipcMain.handle('monitor:ws-connections', async (_event, limit?: number) =>
    (await controller?.getWsConnections(limit)) ?? null
  )

  ipcMain.handle(
    'monitor:endpoints',
    async (_event, options: Parameters<Controller['getEndpointProfiles']>[0]) =>
      (await controller?.getEndpointProfiles(options)) ?? null
  )

  ipcMain.handle(
    'monitor:endpoint-detail',
    async (_event, key: string, options: Parameters<Controller['getEndpointDetail']>[1]) =>
      (await controller?.getEndpointDetail(key, options)) ?? null
  )

  ipcMain.handle(
    'monitor:graph',
    async (_event, options: Parameters<Controller['getRequestGraph']>[0]) =>
      (await controller?.getRequestGraph(options)) ?? null
  )

  ipcMain.handle(
    'monitor:relations',
    async (_event, options: Parameters<Controller['getRelations']>[0]) =>
      (await controller?.getRelations(options)) ?? null
  )

  // 导出/契约/对话框这几条不吞异常：它们是「点下去要结果」的动作，
  // 失败必须把原因原样带回渲染进程，返回 null 只会让人以为「没数据」
  ipcMain.handle('monitor:export-har', async (_event, options: ExportQuery) => {
    if (!controller) throw new Error('控制器还没起来')
    return controller.exportHar(options)
  })

  ipcMain.handle('monitor:export-jsonl', async (_event, options: ExportQuery) => {
    if (!controller) throw new Error('控制器还没起来')
    return controller.exportJsonl(options)
  })

  ipcMain.handle('monitor:export-bodies', async (_event, options: ExportQuery & { dir?: string }) => {
    if (!controller) throw new Error('控制器还没起来')
    return controller.exportBodies(options)
  })

  ipcMain.handle(
    'monitor:contract-snapshot',
    async (_event, options: Parameters<Controller['contractSnapshot']>[0]) => {
      if (!controller) throw new Error('控制器还没起来')
      return controller.contractSnapshot(options)
    }
  )

  ipcMain.handle('monitor:contract-list', async (_event, limit?: number) =>
    (await controller?.listContracts(limit)) ?? null
  )

  ipcMain.handle('monitor:contract-get', async (_event, id: number, withSchema?: boolean) =>
    (await controller?.getContract(id, withSchema)) ?? null
  )

  ipcMain.handle('monitor:contract-delete', async (_event, id: number) =>
    (await controller?.deleteContract(id)) ?? { deleted: 0 }
  )

  ipcMain.handle(
    'monitor:contract-diff',
    async (_event, options: Parameters<Controller['contractDiff']>[0]) => {
      if (!controller) throw new Error('控制器还没起来')
      return controller.contractDiff(options)
    }
  )

  ipcMain.handle('monitor:dialog', async (_event, accept: boolean, promptText?: string) =>
    (await controller?.handleDialog(accept, promptText)) ?? { ok: false, error: '控制器还没起来' }
  )