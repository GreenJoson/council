# desktop - Council 桌面应用

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `package.json` | 工具入口 | 固定 Tauri CLI 版本并提供开发、构建和检查命令 |
| `sidecar-build.json` | 构建配置 | 固定 Node 官方运行时版本、下载源、平台归档与 SHA-256 |
| `src-tauri/` | 核心 | Rust 桌面壳、本机设置、共享 SQLite 接入、本地 Agent 服务托管与原生能力 |
| `local-agent-service.md` | 接入说明 | 桌面自动轮次接入本地 Agent 服务的配置、CORS 与验收步骤 |

桌面端使用 Tauri 2 承载 `packages/web` 的 React 构建产物。用户选择的日志库和项目目录只写入操作系统的应用配置目录，不进入源码、文档或 Git。桌面自动轮次不在 Rust 重写状态机，而是把现有 Node 编排服务编译成 Tauri `externalBin` sidecar（与桌面共享同一 SQLite 库文件）：打开 App 自动启动，日志库切换后自动重启，退出时回收整个进程组；编排请求走 loopback HTTP/SSE，内容读写仍走 Tauri 原生命令。

当前桌面发行版本为 `0.4.7`；`package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 与 `src-tauri/tauri.conf.json` 必须同步递增。本版本进一步压缩过长议题的默认摘要高度，并为时间线增加编辑器等高的尾部阅读空间；移除容器级平滑滚动和滚动锚定，避免最后卡片被编辑器挡住或自动反弹。“展开议题 / 收起议题”、消息卡底部折叠、图片/Mermaid 大图与一卡一节点的阶梯导航保持不变。
