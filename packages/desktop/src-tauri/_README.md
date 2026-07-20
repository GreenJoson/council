# src-tauri - Council Rust 桌面运行层

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `Cargo.toml` | 依赖清单 | 固定 Rust、Tauri 与原生插件依赖 |
| `build.rs` | 构建入口 | 生成 Tauri 资源和权限元数据 |
| `tauri.conf.json` | 应用配置 | 窗口、CSP、React 构建、版本、图标与 macOS 本地 ad-hoc 整包签名设置 |
| `capabilities/default.json` | 权限边界 | 主窗口可使用的最小原生能力 |
| `icons/` | 品牌资源 | 多 Agent 圆桌主题的 Council 图标源图与各平台打包尺寸 |
| `src/lib.rs` | IPC 入口 | 注册桌面设置、持久 SQLite 连接、内容与 revision 事件命令，以及本地 Agent 服务配置/健康/拉起命令和退出清理 |
| `src/main.rs` | 进程入口 | 启动桌面应用 |
| `src/settings.rs` | 设置核心 | 原子保存日志库、当前项目、最近项目与本地 Agent 服务配置（地址默认值唯一来源） |
| `src/orchestration.rs` | 服务边界 | 本地 Agent 服务的 std 健康探测（TCP + 最小 HTTP GET）、autostart 子进程拉起与进程组终止 |
| `src/validation.rs` | 输入边界 | 对齐 HTTP/MCP 的路径、分页、ID 与文本上限，并解析 loopback 服务地址 |

本目录不保存用户选择的路径。运行时设置由 `SettingsStore` 写入操作系统分配的应用配置目录。SQLite 迁移只在首次打开或切换日志库时执行，普通轮询与内容命令复用同一受锁保护的连接。

本地 Agent 服务接入：`get_orchestration_config` 返回设置里的 loopback 服务地址（默认值集中在 `settings.rs` 的 `DEFAULT_ORCHESTRATION_BASE_URL`，其他代码一律从设置读取）；`check_orchestration_service` 在 `spawn_blocking` 中用 std TcpStream 做健康探测，不持有状态锁、不带 Origin 头、不引入 tokio/reqwest；`start_orchestration_service` 仅在设置配置了 `orchestrationAutostart` 时按配置拉起子进程（Unix 下放入独立进程组），应用退出时对整个进程组先 SIGTERM、有界等待后 SIGKILL，避免留下孤儿进程。CSP 的 `connect-src` 放行 `http://127.0.0.1:*` 与 `http://localhost:*` 以允许编排 fetch 与 SSE。接入步骤与 CORS 要求见 `../local-agent-service.md`。
