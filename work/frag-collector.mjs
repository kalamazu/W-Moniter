  /**
   * WS 连接：`sessionId|requestId` → 握手 URL。
   * 帧事件本身不带 URL，只有 webSocketCreated 带 —— 不缓存的话每帧都得现猜。
   */
  private readonly wsUrls = new Map<string, string>()
  private wsFrameCount = 0
  private wsFrameDropped = 0
  /** 正在等应答的 JS 对话框所在的 session。不记住它，agent 想放行都找不到人 */
  private dialogSession: string | null = null
  /** console/exception 这类高噪音事件已经记了多少条 */
  private noisyEventCount = 0
  private noisyEventOverflowed = false
  /** 下载事件的去重键（Browser 与 Page 两个域可能报同一次下载） */
  private readonly seenDownloadKeys = new Set<string>()

  /**
   * 事件流入口。
   *
   * console / exception 是高噪音事件：一个死循环配上 console.error
   * 能在一秒里造出几万条。这类事件封顶；导航、下载、对话框、WebSocket
   * 这些稀疏但重要的照旧全记 —— 丢了它们，事件流就不再是行为时间线了。
   */
  private emitEvent(item: MonitoredEvent): void {
    const noisy = item.kind === 'console' || item.kind === 'exception'
    if (noisy) {
      if (this.noisyEventCount >= EVENT_NOISY_LIMIT) {
        if (!this.noisyEventOverflowed) {
          this.noisyEventOverflowed = true
          this.emit('event', {
            ts: Date.now(),
            kind: 'overflow',
            level: 'warn',
            detail: {
              limit: EVENT_NOISY_LIMIT,
              note:
                'console/exception 事件已达单实例上限，后续同类不再入库（控制台面板仍保留最近 ' +
                CONSOLE_RING +
                ' 条）'
            }
          } satisfies MonitoredEvent)
          this.emit('log', `[events] console/exception 超过 ${EVENT_NOISY_LIMIT} 条，之后同类事件不再入库`)
        }
        return
      }
      this.noisyEventCount += 1
    }
    this.emit('event', item)
  }

  /** 下载事件的去重：同一个 guid 只记一次 */
  private claimDownload(key: string): boolean {
    if (this.seenDownloadKeys.has(key)) return false
    this.seenDownloadKeys.add(key)
    if (this.seenDownloadKeys.size > 256) {
      const oldest = this.seenDownloadKeys.values().next().value
      if (oldest !== undefined) this.seenDownloadKeys.delete(oldest)
    }
    return true
  }

  private wsUrlFor(sessionId: string | undefined, requestId: string): string | undefined {
    return this.wsUrls.get(`${sessionId ?? 'root'}|${requestId}`)
  }

  /**
   * 一帧 WebSocket 数据。
   *
   * payloadData 在文本帧里是文本、在二进制帧里是 base64（CDP 的约定），
   * 所以 size 要按帧类型换算，别把 base64 的长度当成载荷大小报给上层。
   */
  private onWsFrame(event: CdpEvent, direction: 'sent' | 'received'): void {
    const p = params<{
      requestId: string
      timestamp?: number
      response?: { opcode?: number; payloadData?: string }
    }>(event)
    if (this.wsFrameCount >= WS_FRAME_LIMIT) {
      this.wsFrameDropped += 1
      return
    }
    this.wsFrameCount += 1
    const data = p.response?.payloadData ?? ''
    const opcode = p.response?.opcode ?? 0
    const binary = opcode === 2
    const truncated = data.length > WS_PAYLOAD_MAX
    const frame: WsFrameRecord = {
      seq: this.resolveSeq(event.sessionId, p.requestId),
      ts: toMs(p.timestamp),
      requestId: p.requestId,
      url: this.wsUrlFor(event.sessionId, p.requestId),
      direction,
      opcode,
      payload: truncated ? data.slice(0, WS_PAYLOAD_MAX) : data,
      size: binary ? Math.floor((data.length * 3) / 4) : data.length,
      truncated,
      binary
    }
    this.emit('wsframe', frame)
  }

  /**
   * 应答 JS 对话框。
   *
   * 对话框会把渲染进程挂住（页面从此不再前进），所以「记录」之外还得能让
   * 调用方放行 —— 这是监控之外的控制能力，也是自动化测试会用到的那一半。
   */
  async handleDialog(accept: boolean, promptText?: string): Promise<{ ok: boolean; error?: string }> {
    const sessionId = this.dialogSession ?? this.findSessionByTargetType('page')
    if (!sessionId) return { ok: false, error: '当前没有打开的对话框' }
    try {
      await this.cdp.send(
        'Page.handleJavaScriptDialog',
        promptText === undefined ? { accept } : { accept, promptText },
        sessionId
      )
      return { ok: true }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  }

  /** WS 采集计数，给状态面板与 /status 用 */
  getWsStats(): { frames: number; dropped: number; connections: number } {
    return { frames: this.wsFrameCount, dropped: this.wsFrameDropped, connections: this.wsUrls.size }
  }
