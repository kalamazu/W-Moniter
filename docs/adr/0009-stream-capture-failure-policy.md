# ADR-0009：流式采集采用 fail-open 与独立完整性终态

状态：已接受（2026-09-24）

## 决策

HTTP 上传、响应、SSE 分段、WebSocket 帧与下载产物都以原始字节写入 ContentStore；线上网络转发与本地证据写盘是两条独立终态。内容服务失败时继续转发浏览器流量（fail-open），同时记录 `content_error` / `gap`，不得发布 complete manifest，也不得用预览冒充原文。

上传和普通响应使用流式 tee 与背压；长连接按原始网络片段提交有序 ContentRef；WebSocket 在进入有界 SQLite 队列前先提交正文，只把 4 KiB 预览放入行存储；下载完成后流式归档，成功后删除工作区下载目录中的临时原文件。

## 原因

管理终端的采集故障不应改变用户访问站点的业务结果。另一方面，静默丢弃会破坏证据可信度，因此“转发成功”和“证据完整”必须分别表达。ContentStore 的临时文件、EOF/长度校验和原子 manifest 保证中断输入不会被误标为完整。

## 后果

- 慢盘通过 Node stream 背压限制内存，但会降低对应网络流速度。
- 活跃 SSE 可通过 `stream` 事件按 cursor 查询已提交分段；尚未提交或失败的分段显示 gap。
- 内容服务允许并发 staging，避免一个长连接造成全局队头阻塞；发布仍依赖内容寻址与原子文件。
- 正文读取继续复用 `content.readRange`，UI、HTTP 与 MCP 不复制另一份正文协议。

