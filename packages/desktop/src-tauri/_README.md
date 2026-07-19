# src-tauri - Council Rust 桌面运行层

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `Cargo.toml` | 依赖清单 | 固定 Rust、Tauri 与原生插件依赖 |
| `build.rs` | 构建入口 | 生成 Tauri 资源和权限元数据 |
| `tauri.conf.json` | 应用配置 | 窗口、CSP、React 构建、版本和显式桌面图标设置 |
| `capabilities/default.json` | 权限边界 | 主窗口可使用的最小原生能力 |
| `icons/` | 品牌资源 | 多 Agent 圆桌主题的 Council 图标源图与各平台打包尺寸 |
| `src/lib.rs` | IPC 入口 | 注册桌面设置、持久 SQLite 连接、内容与 revision 事件命令 |
| `src/main.rs` | 进程入口 | 启动桌面应用 |
| `src/settings.rs` | 设置核心 | 原子保存日志库、当前项目和最近项目 |
| `src/validation.rs` | 输入边界 | 对齐 HTTP/MCP 的路径、分页、ID 与文本上限 |

本目录不保存用户选择的路径。运行时设置由 `SettingsStore` 写入操作系统分配的应用配置目录。SQLite 迁移只在首次打开或切换日志库时执行，普通轮询与内容命令复用同一受锁保护的连接。
