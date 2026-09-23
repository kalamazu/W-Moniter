# A-010：全量采集路径独立验收

状态：已通过 · 独立验收 2026-09-24 · 实现 `4bd3984` · 验收加固 `516364a` · 对应 [T-010](../tasks/T-010-capture-coverage-probe.md)

自动证据：`npm run test:capture-paths` 3/3；`CAPTURE_PROFILE=H` 3/3；`npm run test:capture-cdp` 1/1；`npm run test:content` 7/7；`npm run test:rules:e2e` 22/22。代理模式分“完整场景”和“跳过上传”各跑一轮，前者明确记录页面在 2 MiB 上传处停滞，后者明确记录 WS 失败；探针本身通过不代表产品覆盖通过。

独立复核：检查 [能力账本](../architecture/capture-coverage.md) 中每行 origin/page/终端证据是否相互独立；复跑代理上传和 WS 的缺口；确认 64 KiB 声明长度却只收 1 KiB 的响应不会再标 `stored`；核对实验 Profile、内核版本与内存采样方式。未补齐的来源保持未达 M1 全量门槛。

## 独立验收结论

通过“真值矩阵”任务，不等于通过 M1 全量采集里程碑。L/H 直连各 3/3、CDP 大正文 1/1；代理完整场景和跳过上传场景均 3/3，分别如实记录上传停滞、WS 失败、SSE/下载未存储。`test:rules:e2e` 22/22 无回归；所有未覆盖路径仍保持缺口标记。
