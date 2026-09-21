  /* ---- 本轮新增：事件流 / WebSocket / 接口画像 / 调用图 / 关联 / 导出 / 契约 ---- */

  queryEvents,
  eventStats,

  /**
   * WS 帧入库。分帧方向是「相对浏览器」的：sent = 页面发出去。
   * payload 在采集侧已经按上限截断过，这里只负责落库，不再做二次裁剪。
   */
  appendWsFrames(args) {
    const items = args.items || []
    if (items.length === 0) return { inserted: 0 }
    const inst = args.inst
    db.exec('BEGIN')
    try {
      for (const item of items) {
        S.insertWsFrame.run(
          inst,
          norm(item.seq),
          norm(item.ts) ?? Date.now(),
          norm(item.requestId),
          norm(item.url),
          item.direction === 'sent' ? 'sent' : 'received',
          norm(item.opcode),
          norm(item.payload),
          norm(item.size),
          item.truncated ? 1 : 0,
          item.binary ? 1 : 0
        )
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    return { inserted: items.length }
  },

  queryWsFrames,
  wsConnections,

  endpointProfiles,
  endpointDetail,
  requestGraph,
  relations,

  exportHar,
  exportJsonl,
  exportBodies,

  contractSnapshot,
  contractList,
  contractGet,
  contractDelete,
  contractDiff,
