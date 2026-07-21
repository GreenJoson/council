# scripts - Council 工程级开发脚本

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `dev.mjs` | 开发入口 | 同时启动本地 HTTP API 与 Operator Console，并统一关闭子进程 |
| `e2e.mjs` | 主验收 | 用隔离 SQLite 启动真实 API/Web/Claude 子进程链路，验证模型设置持久化，再检查 Mock 桌面与移动布局 |
| `build-agent-sidecar.mjs` | 桌面构建 | 编译 MCP HTTP 服务、校验 Node 官方运行时并注入 SEA，生成 Tauri `externalBin` 与许可证资源 |
