# A-001：统一身份、动作与任务契约验收

状态：通过
对应实现任务：[T-001](../tasks/T-001-action-task-contract.md)
实现 commits：`318e797 feat: add target-aware action task contracts`、`5d58cc7 refactor: separate action policy and target resolution`
验收范围：协议、三入口一致性、目标保护、幂等、取消与 unknown 语义，以及既有控制面回归。

## 验收判据与证据

| 判据 | 证据 |
| --- | --- |
| UI、HTTP、MCP 对同一 `action + idempotencyKey + input + target` 返回同一 `taskId`、同一结构和同一领域输出 | `npm run test:actions`：UI/HTTP/MCP 共享任务用例通过 |
| 相同幂等键但不同输入明确冲突 | `npm run test:actions`：冲突用例通过 |
| mutation 缺少 TargetRef 或目标版本过期会失败，绝不回退到 UI 焦点 | `npm run test:actions`：缺失/过期目标用例通过 |
| 任务可取消；远端效果无法确认时是 `unknown` 而不是伪造成功或失败 | `npm run test:actions`：TaskService 构建产物单测通过 |
| 新协议不破坏既有工作区和控制面 | `npm run test:workspaces`：7/7；`npm run test:control`：33/33 |
| 构建和类型约束完整 | `npm run typecheck`、`npm run build` 通过 |

## 结论与遗留项

验收通过 M0 的最小动作/任务执行语义。当前已注册的垂直切片仅是工作区动作；重放、Cookie/站点存储、浏览器 Tab 等动作会按相同协议逐项迁入。任务账本暂存主进程内存，不能把它当作重启后的审计记录或长任务恢复能力。

回退实现按逆序执行 `git revert 5d58cc7`、`git revert 318e797`；此验收与记录文档可单独用其文档提交回退。
