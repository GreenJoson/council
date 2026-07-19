# src - Council 桌面 Rust 源码

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `main.rs` | 入口 | 启动 Tauri 桌面进程 |
| `lib.rs` | 核心 | 提供 IPC、持久 SQLite 连接和内容变更事件 |
| `settings.rs` | 设置 | 安全持久化日志库、当前项目和最近项目 |
| `validation.rs` | 边界 | 校验目录、ID、分页与文本输入 |
