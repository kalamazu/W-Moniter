`npm run test:realtime` —— **实时分析面验收 47/47 通过**（真开 Chrome + 受控 origin + peer origin）。
判据全部落在**外部可观测的真值**上，不采信引擎自述：

```text
A 采集    WS 帧条数与服务端双向日志一致（3 帧：1 发 2 收）                ✓
          页面发出的帧逐字等于服务端收到的（方向没标反）                  ✓
          服务端推的帧逐字等于库里「收到」的那两条                        ✓
          WS 生命周期（created / handshake / closed）进了事件流           ✓
          导航事件带目标 URL，主框架标记正确                              ✓
          事件流统计与事件行对得上（同一份数据的两个口径）                ✓
B 实时性  since 之后的每一条 id 都更大且严格递增                          ✓
          导航到入库延迟 238ms（要求 < 3000ms）                           ✓
          消费过的游标再问只回空、nextSince 不变（不重复吐）              ✓
          下载：begin → inProgress → completed，文件名与页面点的一致      ✓
          下载文件真的落到 <数据目录>/downloads/，内容逐字对              ✓
C 分析    接口聚成一个端点，调用次数 / 不同 URL 数 / 状态码 / MIME 都对    ✓
          query 参数（token / page）与请求体字段（user / n / extra）      ✓
          extra 只在 phase2 带 → 标成「可选」                             ✓
          调用节奏：间隔是真实毫秒数                                      ✓
          端点详情解出响应结构：ok / name / echo.user / items[] / meta.source
          / bonus.deep，bonus.deep 标成「非每次都有」                     ✓
          详情里的最近调用与库里的真实调用对得上（seq 双向可查）          ✓
          调用图有指向该端点的边，次数与真实调用一致                      ✓
          连通分量（功能簇）给出且节点数自洽                              ✓
          共享参数里能看到 token=tk-1（跨端点同值）                       ✓
          跨域取图被关联成「origin 页面 → peer 域」，且同域请求不算关联   ✓
D 导出    HAR：文件在、entry 数 = 库里请求数、字节数 = 文件大小            ✓
          结构合法（pages / entries / timings），正文是**真的响应**        ✓
          没有 CDP 伪头（:method 这类，DevTools 打开会直接报错）           ✓
          JSONL：行数 = 请求数、每行合法 JSON、正文是真的                 ✓
          资源镜像：manifest 可解析、落盘正文与真实响应逐字一致           ✓
E 回归    新字段 bonus.deep 被标成「响应结构新增」                          ✓
          新请求字段 extra 也被看出来                                      ✓
          不误报：没有端点消失，新增的只可能是下载那条 URL                ✓
          契约能列出来、能删掉（删掉之后列表里就没了）                    ✓
F 对话框  记录类型与文案 → 页面此刻确实卡住 → 放行后页面继续跑              ✓
          关闭事件排在打开事件之后                                        ✓
G 三入口  MCP 列出了分析层全部工具（42 个）                                ✓
          monitor_events / endpoints / ws_frames 与 HTTP 结果**逐字一致**  ✓
          monitor_contracts 两边逐字一致且 total = raw.length              ✓
          SSE /events/stream 真推得动 data 帧                              ✓
H 界面    四个新面板（事件流 / WebSocket / 接口画像 / 调用图）真的渲染出行  ✓
```

`npm run test:analytics` —— **分析层协议级验收 40/40 通过**。不起浏览器，数据按列直接灌进存储进程，
判据全在「算出来的东西对不对」：端点画像的分位数、共享体的去重、调用图的边、HAR 的结构、
契约回归的增删。采集端有没有把数据喂进来由 `test:realtime` 负责，两层分开，出问题能立刻定位。
