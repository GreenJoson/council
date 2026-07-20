# desktop - Council 桌面应用

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `package.json` | 工具入口 | 固定 Tauri CLI 版本并提供开发、构建和检查命令 |
| `src-tauri/` | 核心 | Rust 桌面壳、本机设置、共享 SQLite 接入、本地 Agent 服务托管与原生能力 |
| `local-agent-service.md` | 接入说明 | 桌面自动轮次接入本地 Agent 服务的配置、CORS 与验收步骤 |

桌面端使用 Tauri 2 承载 `packages/web` 的 React 构建产物。用户选择的日志库和项目目录只写入操作系统的应用配置目录，不进入源码、文档或 Git。桌面自动轮次不在 Rust 重写状态机，而是复用 Node 编排服务（与桌面共享同一 SQLite 库文件）：编排请求走 loopback HTTP/SSE，内容读写仍走 Tauri 原生命令；服务离线时面板显示可执行指引并自动重试接入。

当前桌面发行版本为 `0.2.1`；`package.json`、`src-tauri/Cargo.toml` 与 `src-tauri/tauri.conf.json` 必须同步递增。
