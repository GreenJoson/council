# 桌面内置 Agent Service 说明

> ⚠️ 一旦打包、启动生命周期、配置或诊断方式有所变化，请更新本文件

## 用户结论

Council.app 已内置 Agent Service 和 Node.js 运行时。正常使用时不需要打开终端，不需要执行 `npm run dev:api`，也不需要提前启动常驻服务。

生命周期由桌面端统一管理：

1. 首次启动选择日志库后，Rust 启动内置 sidecar；sidecar 完成唯一的 Node schema
   迁移并返回 `ready=true` 与数据库实例 UUID 后，Rust 才打开内容 Store 并精确比对身份；
2. 后续打开 App 时自动启动；
3. 切换日志库时终止旧 sidecar，再以新日志库重启；
4. 退出 App 时先发 SIGTERM，超时后终止整个进程组，不留下后台孤儿进程；
5. sidecar 暂未就绪时，界面保持离线并按打包配置有界探测；普通 HTTP 响应或
   `ready=false` 均不算启动成功。

用户仍需分别完成 Claude Code CLI / Codex CLI 的安装和登录。模型选择、兼容 Provider 与 API Key 在 Council 的设置中心完成；API Key 只进入系统 Keychain，不写入 SQLite、设置文件或 sidecar 配置。

## 运行架构

桌面端不在 Rust 重写编排状态机，而是复用经过测试的 Node 编排实现：

```text
React UI ── Tauri IPC ── Rust council-core ───────── SQLite
    │                         ▲
    └── loopback REST/SSE ── 内置 Agent Service sidecar
                                  ├── Node schema migrator ── SQLite
                                  └── Claude/Codex CLI + 兼容 Provider
```

- Node sidecar 是唯一生产 schema 迁移所有者；Rust 只在 ready 门后验证 schema 和实例身份，
  再访问 SQLite；端口上另一日志库的 ready 服务不能被误用；
- 内容读写（议题、消息、决策）走 Tauri IPC；
- 自动轮次、Agent 设置、连接测试与 SSE 走 loopback HTTP；
- Rust 与 sidecar 使用桌面选择的同一日志库，因此共享同一个 `council.sqlite3`；
- 前端不保存端口，服务地址由桌面设置层统一提供；
- sidecar 只监听 loopback，CORS 只允许 Council 的开发与生产 webview origin。

## 构建链

`npm run dev:desktop`、`npm run build:desktop`、桌面检查和测试都会先运行 `scripts/build-agent-sidecar.mjs`：

1. 编译 `packages/orchestrator` 与 `packages/mcp-server`；
2. 用 esbuild 将 HTTP 服务及 JavaScript 依赖合并为单文件；
3. 按 `sidecar-build.json` 下载固定版本的 Node 官方发行归档；
4. 对归档执行锁定的 SHA-256 校验，失败时删除缓存并终止构建；
5. 使用 Node SEA + postject 生成独立可执行程序并重新签名；
6. 交给 Tauri `externalBin` 放入应用包，并在 Hardened Runtime 签名时应用 V8 所需的最小 JIT/可执行内存 entitlement；
7. 同时带上实际 Node 发行版许可证。

生成的运行时、缓存和二进制均被 `.gitignore` 排除。源码仓库只提交构建脚本、锁定配置和非敏感运行默认值。

当前构建链支持 Apple Silicon 与 Intel macOS 归档；脚本必须在对应架构主机上原生构建，拒绝把错误架构的 Node 运行时注入目标程序。

## 配置边界

`src-tauri/resources/agent-service-defaults.json` 是内置服务非敏感默认配置的正本，包含
schema 迁移重试、桌面 ready 轮询、超时、轮次、限流和 loopback 参数。Rust 启动时动态覆盖：

- `COUNCIL_DATA_DIR`：桌面当前日志库；
- `COUNCIL_HTTP_HOST` / `COUNCIL_HTTP_PORT`：桌面设置解析后的 loopback 端点；
- `PATH`：从用户登录 shell 读取，解决从 Finder 打开 App 时找不到 `claude` / `codex` 的问题。

日志库路径、项目路径和 API Key 不进入构建资源。模型与 Provider 的非敏感配置保存在共享 SQLite，密钥保存在系统 Keychain。

Claude 的默认工具回合预算为 24。这个预算足以覆盖常见的仓库检索和文件读取，同时仍受单次调用总超时约束；达到上限时会被识别为明确、不可重试的回合耗尽，而不是模糊的 `request_failed`。

旧版 `settings.json` 中的 `orchestrationAutostart` 仍作为开发者覆盖保留；普通用户不需要新增或修改该字段。若未设置覆盖，桌面始终使用安装包内置 sidecar。

## 浏览器开发模式

独立浏览器 Operator Console 仍然是开发模式，不属于安装后的 Council.app。需要调试 Web/API 时可运行：

```bash
npm run dev
```

该命令会启动开发 HTTP 服务和 Vite。桌面 App 的日常使用不依赖它，也不会要求项目源码目录继续存在。

## 故障排查

如果自动轮次长时间没有转为 LIVE：

1. 在 Council 设置中分别测试 Claude、Codex 或远程 Provider；
2. 确认对应 CLI 已安装并完成登录；
3. 查看操作系统分配的 Council 应用日志目录中的 `agent-service.log`；
4. 确认没有另一个开发服务占用相同 loopback 端口；
5. 退出并重新打开 Council，桌面会重新拉起干净的 sidecar。

sidecar 在 schema 迁移或 ready 探测阶段失败时，桌面不会让 Rust 抢先打开日志库，而是
失败关闭并保留原库与已验证备份。修复配置或数据库问题后重新打开应用；不要绕过 ready 门
直接修改数据库。

Agent 失败时，运行快照只接收适配器显式标记过的脱敏原因，例如未登录、额度不足、模型不可用或工具回合耗尽。未知错误继续显示通用提示；原始上游输出、命令行内容和堆栈不会进入议题记录。`agent-service.log` 会记录诊断码与同一份脱敏原因，便于本地排查。
