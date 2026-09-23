<p align="center">
  <img src="docs/logo.png" alt="W-Monitor" width="200">
</p>

<h1 align="center">W-Monitor</h1>

<p align="center">
  <strong>用真实的 Chrome 监控目标站点 —— 零污染、全量采集、智能干预</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-22+-green" alt="Node 22+">
  <img src="https://img.shields.io/badge/Chrome-130+-4285F4" alt="Chrome 130+">
  <img src="https://img.shields.io/badge/Platform-Windows%2011%20%7C%20macOS%20%7C%20Linux-blue" alt="Platform">
  <img src="https://img.shields.io/badge/License-MIT-yellow" alt="License">
</p>

<p align="center">
  <a href="#-快速开始">快速开始</a> •
  <a href="#-功能特性">功能特性</a> •
  <a href="#-架构设计">架构设计</a> •
  <a href="#-文档">文档</a> •
  <a href="#-命令参考">命令参考</a>
</p>

---

## 什么是 W-Monitor？

W-Monitor 是一个本机工具，用**真实的 Chrome** 打开目标站点，把它的请求、响应、body、JS 源码、DOM、console、cookie 与站点存储全记下来，并且随时能动手改包、注入、模拟真人操作、增删站点资源。

**面向「研究 + 自动化测试」**：观测要全、干预要真生效、判据要能对回页面侧。

```
┌─────────────────────────────────────────────────────────────┐
│                      W-Monitor 架构                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ┌──────────────┐     ┌──────────────┐     ┌────────────┐ │
│   │   Electron   │────▶│  真实 Chrome  │────▶│  存储进程   │ │
│   │   控制面板    │◀────│  (独立进程)   │     │  (SQLite)  │ │
│   └──────────────┘     └──────────────┘     └────────────┘ │
│          │                    │                    │        │
│          ▼                    ▼                    ▼        │
│   ┌──────────────┐     ┌──────────────┐     ┌────────────┐ │
│   │   HTTP API   │     │  CDP 通道    │     │  本地代理   │ │
│   │  (64 条路由)  │     │  (fd 3/4)   │     │  (MITM)   │ │
│   └──────────────┘     └──────────────┘     └────────────┘ │
│          │                                                  │
│          ▼                                                  │
│   ┌──────────────┐                                         │
│   │   MCP Server │                                         │
│   │  (58 个工具)  │                                         │
│   └──────────────┘                                         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 三个关键特征

| 特征 | 说明 |
|:---:|------|
| 🔒 **零污染** | 承载目标页面的是**独立进程的真 Chrome**，不是 Electron。CDP 走 `--remote-debugging-pipe`，`netstat` 扫不到监听端口 |
| ⏸️ **先接管、再放行** | 启动先停在 `about:blank`，等所有 target attach 完才 `Page.navigate` —— 首屏请求一条不漏 |
| ✅ **判据在页面侧** | 改包有没有生效、点击有没有真点到、cookie 有没有真写进去，都由页面自己回报，不采信工具自述 |

---

## 🚀 快速开始

### 安装

```bash
git clone https://github.com/kalamazu/W-Moniter.git
cd W-Moniter
npm install
```

### 启动

```bash
npm run dev
```

> 默认打开 https://example.com，会拉起一个真实的 Chrome 窗口

### 前置条件

| 项目 | 要求 |
|------|------|
| Node.js | **22+**（存储进程用 `node:sqlite`） |
| Chrome | 已安装（不设则自动查找；`CHROME_PATH` 可指定） |
| 图形界面 | **必须有头**：窗口要真的显示出来 |
| 平台 | Windows 11（主力）/ macOS / Linux |

### MCP Server（给 Agent 用）

```bash
# 方式 1：自动发现
node mcp/server.mjs --data-dir=<数据目录>

# 方式 2：直接指定地址
node mcp/server.mjs --url=http://127.0.0.1:52137?token=<token>
```

### 打包

```bash
npm run dist:win
# 产物：dist/ChromiumMonitor-<版本>-portable.exe（单文件双击即用）
```

> 目标机器**不需要装 Node**，但**仍然需要 Chrome**

---

## 🎯 功能特性

### 📡 采集能力

| 功能 | 状态 | 说明 |
|------|:----:|------|
| 网络请求全量采集 | ✅ | 请求/响应/body/JS 源码 |
| 多 target 覆盖 | ✅ | page / OOPIF / Worker / Service Worker |
| JS 源码采集 | ✅ | 内联、eval、Worker、SW 全覆盖 |
| WebSocket 帧采集 | ✅ | 双向、二进制按真实字节数 |
| 虚拟滚动 | ✅ | 10 万条实测 137fps |
| 落盘存储 | ✅ | SQLite，36,697 行/秒 |

### 🔧 干预能力

| 功能 | 状态 | 说明 |
|------|:----:|------|
| 规则引擎 | ✅ | 7 种动作，host 分桶匹配 4~6µs |
| 请求改写 | ✅ | 拦截/跳转/延时/改请求头/改响应头 |
| 响应改写 | ✅ | 改 body/伪造响应/fixture mock |
| 注入脚本 | ✅ | document_start / document_ready |
| 拟人化输入 | ✅ | 贝塞尔弧线 + 变速 + 停顿 + 错字回退 |

### 🎨 界面能力

| 功能 | 状态 | 说明 |
|------|:----:|------|
| 自由工作区 | ✅ | 1–4 栏，每栏自选面板 |
| 窗口吸附 | ✅ | 浏览器贴到控制窗口旁边 |
| 15 个面板 | ✅ | 列表/瀑布图/统计/脚本/详情等 |
| 站点资源面板 | ✅ | Cookie/本地存储/IndexedDB/缓存 |

### 🤖 AI 控制面

| 功能 | 状态 | 说明 |
|------|:----:|------|
| HTTP API | ✅ | 64 条路由，127.0.0.1 + Bearer token |
| MCP Server | ✅ | 58 个工具，stdio JSON-RPC |
| 截图 | ✅ | 视口/整页/元素，落盘 + MCP image 块 |
| 页面导航 | ✅ | 等 load 再回读落地 URL/标题 |
| DOM 检查 | ✅ | DOM 树/盒模型/命中样式/事件监听器 |

---

## 🏗️ 架构设计

### 核心设计决策

| 决策 | 原因 |
|------|------|
| 真 Chrome 而非 Electron | Electron 的 `window.chrome` 不完整，是成熟的检测点 |
| 吸附而非嵌入 | 跨进程 `SetParent` 会让 Chrome 几何不可控 |
| 独立存储进程 | 绝不在 CDP 事件回调里做同步 IO |
| pipe 而非端口 | `netstat` 扫不到任何监听端口 |
| 先接管再放行 | 首屏请求一条不漏 |

### Profile 系统

| | Profile L（默认） | Profile H（隐蔽） |
|---|---|---|
| Domain | 全开（含 `Runtime.enable`） | 白名单，`Runtime`/`Debugger` 不开 |
| 断点 | 支持 | 降级为 Hook + 信标回传 |
| 控制台 | 可用 | 故意不可用 |
| 用途 | 开发调试 | 有 CDP 检测的目标 |

---

## 📊 测试验收

W-Monitor 拥有完善的自动化测试体系，所有功能都经过真机验收：

```bash
# 完整测试套件
npm run test:storage       # 存储进程自检（54 项）
npm run test:scripts       # 脚本采集验收（9 项）
npm run test:rules         # 规则引擎自检（59 项）
npm run test:rules:e2e     # 干预端到端验收（22 项）
npm run test:proxy         # 代理验收（24 项）
npm run test:dom           # DOM 与元素检查验收（19 项）
npm run test:sessions      # 会话管理验收（9 项）
npm run test:dock          # 窗口吸附验收（25 项）
npm run test:layout        # 自由工作区验收（23 项）
npm run test:probe         # 检测探针验收（14 项）
npm run test:input         # 拟人化输入验收（16 项）
npm run test:control       # AI 控制面验收（33 项）
npm run test:drill         # Agent 演练（39 项）
npm run test:smoke         # 全量冒烟（129 项）
npm run test:realtime      # 实时分析面验收（47 项）
npm run test:sitedata      # 站点资源验收（30 项）
npm run test:analytics     # 分析层协议级验收（57 项）
npm run verify             # 采集完整性验收
```

### 性能指标

| 指标 | 数值 | 说明 |
|------|------|------|
| 采集完整性 | 189/189 (100%) | 零漏抓 |
| 存储吞吐 | 36,697 行/秒 | 设计指标 10,000/秒 |
| 列表滚动帧率 | 137fps | 10 万条数据 |
| 规则匹配开销 | 4~6µs/次 | 2000 条规则压测 |
| 页面性能影响 | < 4% | L/H Profile 均达标 |

---

## 📁 项目结构

```
W-Moniter/
├── src/
│   ├── main/                    # Electron 主进程
│   │   ├── index.ts             # 入口 + IPC 装配
│   │   ├── controller.ts        # 编排：启动浏览器、连接、批处理
│   │   ├── browser/             # Chrome 控制
│   │   │   ├── locate.ts        # 查找内核
│   │   │   ├── launch.ts        # 启动参数
│   │   │   ├── cdp.ts           # CDP 命令/响应/事件
│   │   │   ├── collector.ts     # 网络采集与归一化
│   │   │   ├── body-capture.ts  # body 拦截与存储
│   │   │   └── site-data.ts     # 站点资源管理
│   │   ├── rules/               # 规则引擎
│   │   ├── proxy/               # 代理进程
│   │   ├── storage/             # 存储 RPC 客户端
│   │   └── window/              # 窗口管理（吸附等）
│   ├── renderer/                # 看板 UI
│   │   └── components/          # 各面板组件
│   ├── preload/                 # contextBridge
│   └── shared/                  # 跨层类型定义
├── control/server.mjs           # 控制服务（HTTP API）
├── mcp/server.mjs               # MCP Server（58 个工具）
├── storage/server.mjs           # 存储进程（SQLite）
├── proxy/server.mjs             # 本地代理（MITM）
├── scripts/                     # 测试脚本
├── docs/                        # 文档
└── work/                        # 一次性脚本
```

---

## 📖 文档

| 文档 | 说明 |
|------|------|
| [使用手册](docs/使用手册.md) | 上手指南 / 面板介绍 / 任务 recipe / 排障 / 打包 |
| [AI 控制面](docs/AI-控制面.md) | HTTP API / MCP / 鉴权 / 地址发现 |
| [工程实施蓝图](docs/智能Web管理终端-工程实施蓝图.md) | 长期架构、文件级改造与验收门槛 |
| [实施进度与待办](docs/实施进度与待办.md) | 人类进度总览、已知边界与下一优先级 |
| [任务看板](docs/tasks/README.md) | 可认领任务、独立验收和回滚记录 |
| [设计文档](docs/设计文档.md) | 架构 / 模块职责 / 决策记录 / 测试策略 |
| [技术方案](docs/技术方案.md) | 需求级完整方案（目标、路线 P0–P7） |
| [多会话监视器（历史）](docs/多会话监视器设计.md) | 早期多会话方案；当前以工作区蓝图与 ADR 为准 |

---

## ⚙️ 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MONITOR_URL` | `https://example.com` | 起始 URL |
| `MONITOR_PROFILE` | `L` | `L`（默认）或 `H` |
| `CHROME_PATH` | 自动查找 | 指定 Chrome 路径 |
| `MONITOR_DATA_DIR` | 当前目录 | 数据目录 |
| `MONITOR_API_PORT` | `0`（随机） | 控制服务端口 |
| `MONITOR_PROXY` | `0` | 开本地代理 |
| `MONITOR_BODY_TYPES` | 全部 | 采集 body 的 resourceType |
| `MONITOR_RULES` | `<数据目录>/rules.json` | 规则文件路径 |
| `MONITOR_UI_TAB` | `list` | 开局面板 |

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

```bash
# 开发
npm run dev          # 启动开发服务器
npm run typecheck    # 类型检查
npm run build        # 构建

# 测试
npm run test:smoke   # 全量冒烟测试
npm run verify       # 采集完整性验收
```

---

## 📄 License

[MIT](LICENSE)

---

<p align="center">
  <strong>W-Monitor</strong> — 让 Chrome 监控更简单、更真实
</p>
