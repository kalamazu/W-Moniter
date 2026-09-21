### 5.9 实时分析：事件流 / WebSocket / 接口画像 / 调用图 / 契约回归

四块新面板（栏头下拉框里都在），刷新的方式都是**增量游标**：拉过的不再拉，看到的永远是新的。

- **事件流**：导航 / console 告警 / 未捕获异常 / 下载 / JS 对话框 / WebSocket 生命周期，
  按 kind 分条，`warn` / `error` 高亮。**JS 对话框要在这里点「放行」或「取消」** ——
  不应答页面就一直卡着（面板上会显示那条待应答的）。
- **WebSocket**：左边连接列表、右边帧。`sent` 是页面发出去的、`received` 是服务端推过来的；
  二进制帧按**真实字节数**显示，帧正文可搜。
- **接口画像**：三个页签 —— *接口画像*（按「方法 + 主机 + 路径模板」聚类：调用次数、状态码分布、
  p50/p95、query 与请求体字段分布、调用节奏；点开看字段分布与**响应结构**）、
  *契约回归*（拍基线 → 改东西 → 再跑 → 看 diff）、*导出*（HAR / JSONL / 资源镜像）。
- **调用图**：两个页签 —— *调用图*（谁触发了谁、边权重、互相牵动的功能簇）、
  *关联分析*（共享响应体 / 跳转链 / 共享参数 / 页面 → 域）。

命令行上做同一件事：

```bash
# 事件流：拿一次 nextSince，之后只拉新增
curl -H "authorization: Bearer $TOKEN" "http://127.0.0.1:52137/events?since=0&limit=200"

# WebSocket：先列连接，再按连接看帧
curl -H "authorization: Bearer $TOKEN" "http://127.0.0.1:52137/ws/connections"
curl -H "authorization: Bearer $TOKEN" "http://127.0.0.1:52137/ws?requestId=<id>&limit=100"

# 接口画像 / 调用图 / 关联
curl -H "authorization: Bearer $TOKEN" "http://127.0.0.1:52137/endpoints?sort=calls&minCalls=2"
curl -H "authorization: Bearer $TOKEN" "http://127.0.0.1:52137/graph"
curl -H "authorization: Bearer $TOKEN" "http://127.0.0.1:52137/relations"

# 契约回归：先拍基线，改完东西再 diff
curl -X POST -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
     -d '{"label":"baseline-v1"}' http://127.0.0.1:52137/contracts
curl -H "authorization: Bearer $TOKEN" "http://127.0.0.1:52137/contracts/1/diff"

# 导出：文件落在 <数据目录>/exports/，返回的是绝对路径
curl -X POST -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
     -d '{"includeBodies":true}' http://127.0.0.1:52137/export/har
```

要**推**而不是拉，用 SSE（服务端按 `interval` 毫秒查库，有新的就推一帧）：

```bash
curl -N -H "authorization: Bearer $TOKEN" "http://127.0.0.1:52137/events/stream?since=0&interval=500"
```

它和轮询读的是同一份数据，不会出现「推的」和「查的」不一致。

下载（页面上点了会下载的东西）落在 **`<数据目录>/downloads/`**，不再往你的下载夹里丢；
`MONITOR_DOWNLOAD_DIR` 可以改，设成空串就交回浏览器默认位置。
