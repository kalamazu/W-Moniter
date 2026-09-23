# ADR-0006：登录状态必须由证据等级驱动

状态：接受（T-013，2026-09-23）

## 决定

`site_identities` 保存工作区/profile/origin 当前投影，`auth_observations` 追加记录线索和验证事件。Cookie 变更只产生 `suspected` 或 `unknown`，绝不直接给 `verified`；只有针对明确工作区、明确本地 fixture origin 的 `/auth/whoami` 主动验证返回账号才可给 `verified`。401 是 `logged_out`，超时或服务错误是 `unknown`。`verified` 有 5 分钟新鲜期；工作区浏览器重启时立即降为 `stale`，浏览器仍带旧 Cookie 也不能重新提升为已验证。

验证适配器只接受 `http://127.0.0.1:<port>/` 或 `http://localhost:<port>/`，不是通用真实网站登录检测，也不自动代填密码。Cookie 值用于一次性 fixture 验证请求，但不进入身份表、观察明细、普通 Cookie 事件或摘要。工作区范围由存储进程绑定，HTTP/MCP/UI 都经同一动作目录，显式 workspaceId 错误不得退回活动工作区。

## 后续门槛

真实网站适配器需逐站定义可验证的端点/页面证据、账号字段与误判模型，经独立权限与隐私评审后立项。休眠工作区的离线摘要当前不开放；后续只读 repository 必须按 v10 scope 校验并呈现 stale，不得偷偷启动浏览器。
