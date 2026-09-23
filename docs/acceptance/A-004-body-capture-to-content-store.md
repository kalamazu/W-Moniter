# A-004：响应正文迁移验收

状态：通过  
对应：[T-004](../tasks/T-004-body-capture-to-content-store.md)  
实现：`2014701`

`npm run test:content` 通过：测试站点的 2MiB `/big` 响应超过旧 256KB 门槛，仍获得 body hash、ContentStore 文件和完整 base64 读取结果。SSE 等流式响应仍保持明确未采集语义，缺口统计将在 T-005 完成。
