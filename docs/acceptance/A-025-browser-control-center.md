# A-025：浏览器完全控制中心验收

状态：纵向首版通过 · 验收 2026-09-25 · 实现 `f923b34` · 对应 [T-025](../tasks/T-025-browser-control-center.md)

## 证据与结论

- `test:execution-centers` T-025 4/4：真实 Chromium 返回 Browser/Tab/Frame 树；新建 Tab；刷新推进 document generation；旧引用拒绝；selector wait 与动作时间线闭环。
- `test:input` 16/16、`test:dom` 19/19：显式选择器定位、可信输入、DOM/CSS/iframe 基础路径和失效 nodeId 错误保持可用。
- `test:control` 33/33：截图、元素截图、导航、输入及 MCP/HTTP 能力没有因统一 Action 接线退化。
- 上传只接受工作区 `uploads` 受管目录内的规范化文件；副作用动作携带 workspace/tab/generation，不回退到 UI 当前焦点。

结论：首版控制中心通过。视觉 Tab 分组、窗口几何持久化与多人/Agent 人类接管租约未伪装为已交付，保留在 ADR-0011 的生产化边界中。
