# 桌面自动轮次 × 本地 Agent 服务接入说明

> ⚠️ 一旦接入方式（命令、设置字段、CORS 要求）有所变化，请更新本文件

## 架构

桌面端**不在 Rust 重写编排状态机**。自动轮次复用 `packages/mcp-server` 的 Node HTTP/SSE 编排服务（"本地 Agent 服务"），与桌面共享同一个 SQLite 库文件：

- 内容读写（议题、消息、决策）仍走 Tauri 原生命令直连 Rust `council-core`；
- 编排请求（capabilities、runs、actions、SSE）走 loopback HTTP 直连本地 Agent 服务；
- 服务地址只保存在桌面设置层（`settings.json`），前端与业务代码不硬编码端口。

服务离线时，自动轮次面板显示离线徽章与可执行指引（含服务地址），桌面按
`VITE_COUNCIL_DESKTOP_HEALTH_INTERVAL_MS` 周期做 Rust 侧健康探测；服务启动后自动转
LIVE（重新加载能力、回放当前议题），无需重启应用。

## 桌面设置（settings.json）

位于操作系统应用配置目录（macOS：`~/Library/Application Support/app.council.desktop/settings.json`）。
新增两个可选字段，旧版设置文件无损升级：

```json
{
  "orchestrationBaseUrl": "http://127.0.0.1:4317",
  "orchestrationAutostart": {
    "command": "npm",
    "args": ["run", "start:http"],
    "cwd": "/absolute/path/to/council/packages/mcp-server",
    "env": {}
  }
}
```

- `orchestrationBaseUrl`：缺省为 `http://127.0.0.1:4317`（与服务端 `COUNCIL_HTTP_PORT`
  默认一致；默认值唯一来源是 `src-tauri/src/settings.rs`）。只接受
  `http://<loopback 主机>[:端口]`，不允许路径/查询/非 loopback 主机。
- `orchestrationAutostart`：缺省 `None`——只探测已运行的服务，不自动拉起。配置后，
  桌面在首次探测失败时拉起该命令一次（Unix 下放入独立进程组），应用退出时对整个
  进程组先 SIGTERM、2 秒有界等待后 SIGKILL，不留孤儿进程。`cwd` 必须是存在的绝对目录。

## 服务端前提（packages/mcp-server 的 .env）

1. 服务与桌面必须指向**同一个数据目录**：`COUNCIL_DATA_DIR` 指向桌面所选日志库目录
   （两者共用其中的 `council.sqlite3`）。
2. CORS 白名单需包含桌面 webview 的 Origin（见下）。
3. 端口如改动，桌面 `orchestrationBaseUrl` 需同步修改。

### 桌面 webview 的 Origin（实测值）

| 运行方式 | 实测 Origin |
|---|---|
| `tauri dev`（webview 加载 Vite devUrl） | `http://127.0.0.1:5173` |
| 生产/`tauri build` 构建（macOS，含 `--debug`） | `tauri://localhost` |

注意：Rust 侧健康探测不带 Origin 头，不受 CORS 白名单影响；受影响的是 webview 内的
fetch 与 SSE。

- **开发链路**：默认 `.env.example` 已包含 `http://localhost:5173`；如 devUrl 用的是
  `127.0.0.1`，把 `http://127.0.0.1:5173` 加入 `COUNCIL_HTTP_CORS_ORIGINS_JSON`。
- **生产链路**：服务端只对固定字面量 `tauri://localhost` 开例外，其他自定义协议 origin
  仍被拒绝。把该值加入 `COUNCIL_HTTP_CORS_ORIGINS_JSON` 后，生产构建可直接使用编排服务。

## 验收步骤（全链路）

1. 配置服务：复制 `packages/mcp-server/.env.example` 为 `.env`，设置
   `COUNCIL_DATA_DIR=<桌面日志库目录>`，并按上表补充 CORS origin。
2. 启动服务：`cd packages/mcp-server && npm run start:http`（或配置
   `orchestrationAutostart` 交由桌面拉起）。
3. 启动桌面：`cd packages/desktop && npm run dev`（或运行打包产物）。
4. 期望看到：
   - 服务未启动时，自动轮次面板显示「离线」徽章与
     「未检测到本地 Council 服务（http://127.0.0.1:4317）。启动服务后将自动接入。」；
   - 启动服务后数秒内面板自动转 LIVE，适配器列表出现服务端能力（如 Claude Code），
     无需重启桌面应用；
   - 选中议题后能创建并启动自动轮次，Run 状态经 SSE 实时校准；
   - 停止服务后面板回到断线提示（HTTP 仓储自身的重连逻辑接管），服务重启后恢复。
5. 退出桌面应用后确认无遗留服务子进程（仅在配置了 autostart 时需要检查）。
