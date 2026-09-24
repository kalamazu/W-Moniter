# A-023：代理与环境配置中心验收

状态：已通过 · 复验 2026-09-25 · 实现 `d1eab06`、`9678c69` · 对应 [T-023](../tasks/T-023-environment-proxy-center.md)

## 证据与结论

- `test:core-centers` 7/7：环境不可变版本、应用/待重启、DNS/TCP 诊断、明文凭据字段拒绝和失败上游如实报告。
- 同一验收启动受控 HTTP CONNECT 上游，应用版本并重启工作区后，上游真实观察到浏览器流量。
- 单上游使用 Chromium 原生 proxy-server；多路由编译 PAC，支持域 glob 与 IPv4 /8、/16、/24、/32；必须有显式 `*` 终态。
- SecretRef 无提供器时启动 fail-closed，不会静默无认证或回退直连；普通配置和输出不含明文秘密。

结论：按 ADR-0010 的安全边界通过。SecretRef 本机提供器仍需单独安全任务，当前只交付引用契约与拒绝语义。
