  /* ---- 分析层：事件流 / WS / 画像 / 调用图 / 关联 / 导出 / 契约 ---- */

  queryEvents: (query: EventQuery) =>
    ipcRenderer.invoke('monitor:events', query) as Promise<EventPage | null>,

  getEventStats: () => ipcRenderer.invoke('monitor:event-stats') as Promise<EventStats | null>,

  queryWsFrames: (query: WsFrameQuery) =>
    ipcRenderer.invoke('monitor:ws-frames', query) as Promise<WsFramePage | null>,

  getWsConnections: (limit?: number) =>
    ipcRenderer.invoke('monitor:ws-connections', limit) as Promise<{
      rows: WsConnectionRow[]
      total: number
    } | null>,

  getEndpointProfiles: (options) =>
    ipcRenderer.invoke('monitor:endpoints', options) as Promise<EndpointPage | null>,

  getEndpointDetail: (key: string, options) =>
    ipcRenderer.invoke('monitor:endpoint-detail', key, options) as Promise<EndpointDetail | null>,

  getRequestGraph: (options) =>
    ipcRenderer.invoke('monitor:graph', options) as Promise<RequestGraph | null>,

  getRelations: (options) =>
    ipcRenderer.invoke('monitor:relations', options) as Promise<RelationReport | null>,

  exportHar: (options) =>
    ipcRenderer.invoke('monitor:export-har', options) as Promise<HarExportReport>,

  exportJsonl: (options) =>
    ipcRenderer.invoke('monitor:export-jsonl', options) as Promise<JsonlExportReport>,

  exportBodies: (options) =>
    ipcRenderer.invoke('monitor:export-bodies', options) as Promise<ResourceExportReport>,

  contractSnapshot: (options) =>
    ipcRenderer.invoke('monitor:contract-snapshot', options) as Promise<ContractSummary>,

  listContracts: (limit?: number) =>
    ipcRenderer.invoke('monitor:contract-list', limit) as Promise<ContractListRow[] | null>,

  getContract: (id: number, withSchema?: boolean) =>
    ipcRenderer.invoke('monitor:contract-get', id, withSchema) as Promise<unknown>,

  deleteContract: (id: number) =>
    ipcRenderer.invoke('monitor:contract-delete', id) as Promise<{ deleted: number }>,

  contractDiff: (options) =>
    ipcRenderer.invoke('monitor:contract-diff', options) as Promise<ContractDiff>,

  handleDialog: (accept: boolean, promptText?: string) =>
    ipcRenderer.invoke('monitor:dialog', accept, promptText) as Promise<{
      ok: boolean
      error?: string
    }>,
