| POST | `/contracts` | `{ label?, sampleLimit?, domain? }` 给当前接口契约拍快照，回 `{ id, endpoints, truncated }` |
| DELETE | `/contracts/:id` | 删掉一份契约快照 |
| POST | `/export/har` · `/export/jsonl` · `/export/bodies` | 导出 HAR 1.2 / JSONL / 资源镜像，返回落盘的**绝对路径**与计数 |
| POST | `/dialog` | `{ accept, promptText? }` 应答 JS 对话框 —— **不应答页面就一直卡着** |