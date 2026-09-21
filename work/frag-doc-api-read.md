| GET | `/events` · `/events/stats` | 事件流水（导航 / console 告警 / 异常 / 下载 / 对话框 / WS 生命周期）与按 kind·level 的计数；`since` 是**自增 id 游标**，拿返回里的 `nextSince` 反复拉就只拿新增 |
| GET | `/events/stream` | **SSE**：按 `since` 增量推事件（`interval` 毫秒为周期查库，`event: events` 一帧一批）。断了重连照旧从 `since` 续，不会丢也不会重 |
| GET | `/ws` · `/ws/connections` | WebSocket / SSE 的帧明细与按连接汇总（`direction` 相对浏览器：`sent` = 页面发出去） |
| GET | `/endpoints` · `/endpoints/detail` | 接口画像（路径模板聚类 + 状态码 / 耗时 / 参数 / 请求体字段分布 + 调用节奏）与单端点详情（含从**真实响应体**推出来的响应结构） |
| GET | `/graph` | 请求调用图：节点、边（次数 / 失败数 / 平均耗时）、连通分量（互相牵动的功能簇） |
| GET | `/relations` | 关联分析：共享响应体 / 重定向链 / 跨域加载关系 / 跨端点复用的 query 取值 |
| GET | `/contracts` · `/contracts/:id` · `/contracts/:id/diff` | 契约快照列表 / 取一份 / 与「现在」比对（新增或消失的端点、字段、状态码） |
| GET | `/exports/download` | 取回 `exports/` 下已经导出的文件（见 §3.3，只允许该目录里的文件） |