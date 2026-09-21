  /* -------------------------------------------- 事件流 / WS / 分析 / 导出 */

  async queryEvents(query: EventQuery): Promise<EventPage | null> {
    if (!this.storage.isEnabled()) return null
    try {
      return (await this.storage.call('queryEvents', {
        inst: this.storage.getInstId(),
        ...query
      })) as EventPage
    } catch {
      return null
    }
  }

  async getEventStats(): Promise<EventStats | null> {
    if (!this.storage.isEnabled()) return null
    try {
      return (await this.storage.call('eventStats', { inst: this.storage.getInstId() })) as EventStats
    } catch {
      return null
    }
  }

  async queryWsFrames(query: WsFrameQuery): Promise<WsFramePage | null> {
    if (!this.storage.isEnabled()) return null
    try {
      return (await this.storage.call('queryWsFrames', {
        inst: this.storage.getInstId(),
        ...query
      })) as WsFramePage
    } catch {
      return null
    }
  }

  async getWsConnections(limit = 50): Promise<{ rows: WsConnectionRow[]; total: number } | null> {
    if (!this.storage.isEnabled()) return null
    try {
      return (await this.storage.call('wsConnections', {
        inst: this.storage.getInstId(),
        limit
      })) as { rows: WsConnectionRow[]; total: number }
    } catch {
      return null
    }
  }

  /* 分析类查询的超时给得比平时宽：一次画像要扫几万行，20 秒不够 */
  private static readonly ANALYSIS_TIMEOUT_MS = 120_000

  async getEndpointProfiles(options: {
    query?: RequestQuery
    sort?: string
    minCalls?: number
    limit?: number
    maxRows?: number
  } = {}): Promise<EndpointPage | null> {
    if (!this.storage.isEnabled()) return null
    const { query, ...rest } = options
    try {
      return (await this.storage.call(
        'endpointProfiles',
        { inst: this.storage.getInstId(), filter: query, ...rest },
        Controller.ANALYSIS_TIMEOUT_MS
      )) as EndpointPage
    } catch (error) {
      this.emit('log', `[分析] 接口画像失败: ${(error as Error).message}`)
      return null
    }
  }

  async getEndpointDetail(
    key: string,
    options: { query?: RequestQuery; sampleLimit?: number; callLimit?: number; maxRows?: number } = {}
  ): Promise<EndpointDetail | null> {
    if (!this.storage.isEnabled()) return null
    const { query, ...rest } = options
    try {
      return (await this.storage.call(
        'endpointDetail',
        { inst: this.storage.getInstId(), key, filter: query, ...rest },
        Controller.ANALYSIS_TIMEOUT_MS
      )) as EndpointDetail
    } catch {
      return null
    }
  }

  async getRequestGraph(options: { query?: RequestQuery; maxRows?: number; maxNodes?: number } = {}): Promise<RequestGraph | null> {
    if (!this.storage.isEnabled()) return null
    const { query, ...rest } = options
    try {
      return (await this.storage.call(
        'requestGraph',
        { inst: this.storage.getInstId(), filter: query, ...rest },
        Controller.ANALYSIS_TIMEOUT_MS
      )) as RequestGraph
    } catch (error) {
      this.emit('log', `[分析] 调用图失败: ${(error as Error).message}`)
      return null
    }
  }

  async getRelations(options: { query?: RequestQuery; maxRows?: number; limit?: number } = {}): Promise<RelationReport | null> {
    if (!this.storage.isEnabled()) return null
    const { query, ...rest } = options
    try {
      return (await this.storage.call(
        'relations',
        { inst: this.storage.getInstId(), filter: query, ...rest },
        Controller.ANALYSIS_TIMEOUT_MS
      )) as RelationReport
    } catch (error) {
      this.emit('log', `[分析] 关联分析失败: ${(error as Error).message}`)
      return null
    }
  }

  /*
   * 导出类不吞异常：它是用户/agent 明确点的一次动作，失败必须说清楚
   * 是「没有数据」还是「写不进去」，返回一个空的成功结果最误事。
   */

  async exportHar(options: ExportQuery = {}): Promise<HarExportReport> {
    const { query, ...rest } = options
    return (await this.storage.call(
      'exportHar',
      { inst: this.storage.getInstId(), filter: query, ...rest },
      Controller.ANALYSIS_TIMEOUT_MS
    )) as HarExportReport
  }

  async exportJsonl(options: ExportQuery = {}): Promise<JsonlExportReport> {
    const { query, ...rest } = options
    return (await this.storage.call(
      'exportJsonl',
      { inst: this.storage.getInstId(), filter: query, ...rest },
      Controller.ANALYSIS_TIMEOUT_MS
    )) as JsonlExportReport
  }

  async exportBodies(options: ExportQuery & { dir?: string } = {}): Promise<ResourceExportReport> {
    const { query, ...rest } = options
    return (await this.storage.call(
      'exportBodies',
      { inst: this.storage.getInstId(), filter: query, ...rest },
      Controller.ANALYSIS_TIMEOUT_MS
    )) as ResourceExportReport
  }

  /* ------------------------------------------------------------ 契约回归 */

  async contractSnapshot(options: { label?: string; query?: RequestQuery; sampleLimit?: number } = {}): Promise<ContractSummary> {
    const { query, ...rest } = options
    return (await this.storage.call(
      'contractSnapshot',
      { inst: this.storage.getInstId(), filter: query, ...rest },
      Controller.ANALYSIS_TIMEOUT_MS
    )) as ContractSummary
  }

  async listContracts(limit = 50): Promise<ContractListRow[] | null> {
    if (!this.storage.isEnabled()) return null
    try {
      const result = (await this.storage.call('contractList', { limit })) as { rows: ContractListRow[] }
      return result.rows
    } catch {
      return null
    }
  }

  async getContract(id: number, withSchema = true): Promise<unknown> {
    return this.storage.call('contractGet', { id, withSchema }, Controller.ANALYSIS_TIMEOUT_MS)
  }

  async deleteContract(id: number): Promise<{ deleted: number }> {
    return (await this.storage.call('contractDelete', { id })) as { deleted: number }
  }

  async contractDiff(options: { baseId: number; query?: RequestQuery; sampleLimit?: number }): Promise<ContractDiff> {
    const { query, ...rest } = options
    return (await this.storage.call(
      'contractDiff',
      { inst: this.storage.getInstId(), filter: query, ...rest },
      Controller.ANALYSIS_TIMEOUT_MS
    )) as ContractDiff
  }

  /**
   * 应答 JS 对话框。
   *
   * 对话框会把渲染进程挂住 —— 页面从此不再前进，采集也停了。
   * 所以「记录到了」还不够，必须有一条放行的路，否则监控对象会卡死在那里。
   */
  async handleDialog(accept: boolean, promptText?: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.collector) return { ok: false, error: '没有正在运行的浏览器' }
    return this.collector.handleDialog(accept, promptText)
  }
