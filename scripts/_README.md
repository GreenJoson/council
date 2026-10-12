# scripts - Council 工程级开发脚本

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `dev.mjs` | 开发入口 | 同时启动本地 HTTP API 与 Operator Console，并统一关闭子进程 |
| `e2e.mjs` | 主验收 | 注入显式迁移配置与假 Keychain，用隔离 SQLite 启动真实 API/Web/Claude/兼容 Provider 子进程链路，验证双 Agent 热加载、品牌目录、别名/恢复边界和长列表滚动，再检查 Mock 桌面与移动布局 |
| `build-agent-sidecar.mjs` | 桌面构建 | 编译 MCP HTTP 服务、校验 Node 官方运行时并注入 SEA，生成 Tauri `externalBin` 与许可证资源 |
| `set-version.mjs` | 本地发版 | `npm run version:set -- x.y.z`：以 tauri.conf.json 为正本，一次改齐 desktop package.json / package-lock、Cargo.toml / Cargo.lock 与中英文 README 首屏版本；新版本必须更大，任何一处命中数不对就整体不落盘 |
| `install-desktop.mjs` | 本地发版 | `npm run desktop:install`：检查干净提交、构建不早于 HEAD、版本比已装的新、没有活动任务，再退出应用、经停止接口停服务、zip 备份旧应用到 app-backups、替换并逐字节核对，启动后核对 schema、日志库身份与数据计数 |
