### 3.3 实时分析面（事件流 / WebSocket / 接口画像 / 调用图 / 关联 / 契约 / 导出）

这一层是给「研究 + 自动化测试」用的：把会话里发生的事，算成能**直接下判断**的形状。

**增量游标**：`/events` 与 `/ws` 的 `since` 是**自增 id**，不是时间戳（时钟会回拨，id 不会）。
把返回里的 `nextSince` 直接拿回来当下一次的 `since`，就只拿新增的，不会重复吐已经消费过的。
验收里有一条专门盯这个：追平之后再问，必须回空数组且 `nextSince` 不动。

**事件 kind**：`navigation` / `console` / `exception` / `websocket` / `download` / `dialog` /
`target` / `rule` / `overflow`；`level` 是 `info` / `warn` / `error`。
`console` 只收 error / warning / assert —— 全量 log 走 `/console`，否则事件流会被日志淹掉。

**WebSocket 帧的方向是相对浏览器说的**：`sent` = 页面发出去，`received` = 服务端推过来。
二进制帧的 `payload` 是 base64（`binary: true` 标出来），`size` 已按 4/3 换算回**真实字节数**。

**接口画像的路径模板是保守替换**：`/user/42` 与 `/user/43` 并成 `/user/{int}`，
`{uuid}` / `{hex}` / `{date}` / `{token}` / `.{hash}.` 同理。宁可多出两个模板，
也不要把 `/users/me` 和 `/users/1` 并成一个 —— 合错了会把两个接口的契约搅在一起。

**`optional` 的语义是「不是每个样本都有」**：字段出现次数 `seen < count` 就标 `optional`，
而且父层的可选会往子层传（整个 `bonus` 只在一半样本里出现时，`bonus.deep` 也是可选的）。
契约回归正是靠这个抓「新字段只在部分请求里出现」。

**契约回归的标准动作**：跑一遍 → `POST /contracts` 拍基线 → 改代码 / 改配置 → 再跑一遍 →
`GET /contracts/:id/diff`。返回 `{ summary, added, removed, changed, base, current }`，
`added` / `removed` / `changed` 都是**逐端点**的；`changed` 里再分响应字段、请求字段、状态码与调用次数。

**导出落在 `<数据目录>/exports/`**：

- **HAR 1.2**（DevTools 能直接打开）：CDP 伪头（`:method` 这类）会被剔除，否则 DevTools 打开就报错；
  `connect` 段是 TCP + TLS 之和；每条另带 `_monitor` 段（seq / targetType / 关联状态）。
- **JSONL**：一行一条，含完整请求 / 响应头与正文（二进制 base64），适合丢给脚本再算。
- **资源镜像**：按类型（`document` / `script` / `image` / `font` / …）分子目录，
  文件名 = `正文 hash 前 8 位 + 原文件名`；同一份正文只写一次，另写 `manifest.json` 记
  「每个文件来自哪些 URL」。**同一份响应体被两个不同地址取到，只会落成一个文件** ——
  这正是「共享响应体」能被关联分析抓到的那条线索。

导出的文件可以用 `GET /exports/download?path=<绝对路径>` 取回（只允许 `exports/` 里的文件，
免得 `path` 变成一个任意文件读取的口子）。

**下载落到 `<数据目录>/downloads/`**（`MONITOR_DOWNLOAD_DIR` 可覆盖，设成空串 = 交回浏览器默认）。
自动化跑一遍不该往用户的下载夹里丢东西；而且「文件真的落了盘」是事后取证要的外部证据。
下载的 `begin` / `inProgress` / `completed` 都进事件流，`completed` 带 `receivedBytes`。
