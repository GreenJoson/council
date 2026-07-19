# desktop - Council 桌面应用

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `package.json` | 工具入口 | 固定 Tauri CLI 版本并提供开发、构建和检查命令 |
| `src-tauri/` | 核心 | Rust 桌面壳、本机设置、共享 SQLite 接入与原生能力 |

桌面端使用 Tauri 2 承载 `packages/web` 的 React 构建产物。用户选择的日志库和项目目录只写入操作系统的应用配置目录，不进入源码、文档或 Git。

当前桌面发行版本为 `0.2.1`；`package.json`、`src-tauri/Cargo.toml` 与 `src-tauri/tauri.conf.json` 必须同步递增。
