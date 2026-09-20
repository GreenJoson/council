# src-tauri - Council Rust 桌面运行层

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `Cargo.toml` | 依赖清单 | 固定 Rust、Tauri 与原生插件依赖 |
| `build.rs` | 构建入口 | 生成 Tauri 资源和权限元数据 |
| `tauri.conf.json` | 应用配置 | 窗口、CSP、React 构建、版本、图标与 macOS 本地 ad-hoc 整包签名设置 |
| `Entitlements.plist` | macOS 权限 | 允许 Node/V8 sidecar 在 Hardened Runtime 下创建 JIT/可执行内存 |
| `binaries/` | 构建产物边界 | 保存构建时生成、由 Tauri 打包且不进入 Git 的 Agent Service sidecar |
| `resources/` | 运行配置 | 保存 sidecar 非敏感默认配置（含独立 CLI 事件流预算）及构建时复制的 Node 许可证 |
| `capabilities/default.json` | 权限边界 | 主窗口可使用的最小原生能力 |
| `icons/` | 品牌资源 | 多 Agent 圆桌主题的 Council 图标源图与各平台打包尺寸 |
| `src/lib.rs` | IPC 入口 | 注册桌面设置、ready + 数据库实例身份门后的持久 SQLite 连接、动态 Actor alias 内容命令与 revision 事件，以及本地 Agent 服务配置/健康/拉起命令和退出清理 |
| `src/main.rs` | 进程入口 | 启动桌面应用 |
| `src/settings.rs` | 设置核心 | 原子保存日志库、当前项目、最近项目与本地 Agent 服务配置（地址默认值唯一来源） |
| `src/orchestration.rs` | 服务边界 | 构造内置 sidecar 环境、补全登录 shell PATH、验证 HTTP 200 + `ready=true` + 数据库实例身份、进程拉起、日志落盘与进程组终止 |
| `src/validation.rs` | 输入边界 | 对齐 HTTP/MCP 的路径、分页、ID 与文本上限，并解析 loopback 服务地址 |

本目录不保存用户选择的路径。运行时设置由 `SettingsStore` 写入操作系统分配的应用配置目录。SQLite 生产迁移只由 Node sidecar 在启动时执行；首次打开和切换日志库时，Rust 必须等待 sidecar 报告 ready 后再验证并复用同一受锁保护的连接。

本地 Agent 服务接入：`get_orchestration_config` 返回设置里的 loopback 服务地址（默认值集中在 `settings.rs` 的 `DEFAULT_ORCHESTRATION_BASE_URL`，其他代码一律从设置读取）；`check_orchestration_service` 在 `spawn_blocking` 中用 std TcpStream 做有界 ready 探测，不持有状态锁、不带 Origin 头、不引入 tokio/reqwest，普通 HTTP 响应或 `ready=false` 均不算可用。完成日志库配置后，Rust 自动解析与主程序同目录的 `externalBin`，用 `resources/agent-service-defaults.json` 构造非敏感环境，并从登录 shell 补全 Finder 缺失的 CLI PATH；sidecar 标准输出和错误写入操作系统应用日志目录。应用退出时对整个进程组先 SIGTERM、有界等待后 SIGKILL，避免留下孤儿进程。CSP 的 `connect-src` 放行 loopback 以允许编排 fetch 与 SSE。完整说明见 `../local-agent-service.md`。
