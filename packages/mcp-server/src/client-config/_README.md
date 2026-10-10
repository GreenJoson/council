# client-config - 客户端接入领域

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `client-config-service.ts` | 用例门面 | `status()` / `apply(client, {force?})` / `restore(client)`；状态 `not_applied`/`applied`/`drifted`/`missing`，DTO 路径把家目录折叠成 `~` |
| `client-config-files.ts` | 落盘边界 | 只读写受管片段：Claude JSON 的 `mcpServers.council` 键（2 空格缩进写回）、Codex TOML 的 `# >>> council managed (do not edit) >>>` 文本块（块外逐字节不变，块外手写 `[mcp_servers.council]` 即 409）；Skill 目录整体替换；文件/目录树 sha256；原子写入 |
| `client-config-store.ts` | 状态账本 | `<data-dir>/client-config/applied.json`（每客户端一条：文件路径、写入时间、写后文件 sha256、受管片段 sha256、Skill 目录树 sha256、stash 路径）与 `stash/<client>/<时间戳>/`（原配置文件副本或 absent、原 Skill 目录副本或 absent、`manifest.json`） |
| `client-config-sources.ts` | 内容来源 | MCP 启动命令：sidecar 用自身可执行 + `--council-stdio-mcp`，dev 用 `process.execPath` + 构建产物 `dist/src/index.js`；Skill 文件：dev 读仓库 `skills/council/`，sidecar 读构建时内嵌的 `council-skill/*` 资源 |

## 职责与约束

- 只碰 Council 自己的片段，用户其余配置原样保留；写前预检（JSON 解析、手写冲突）失败时不 stash、不写入。
- 首次写入前拍 stash；重复写入沿用首次 stash。他人已有的同名 Skill 目录会先进 stash，apply 响应带 `notice` 告知。
- 漂移 = 写后配置文件 sha256 或 Skill 目录树 sha256 与记录不同；未带 `force` 的 apply 返回 409。
- 还原：未漂移按 stash 精确回放（原本不存在的文件会删除）；漂移/文件丢失只删受管片段与我们写的 Skill 目录（原有他人 Skill 从 stash 放回），保留用户后续改动。两种情况都清除 applied 记录，stash 目录保留作备份。
- 写入的 MCP env 只含 `loadMcpConfig` 必需且非敏感的键（数据目录、命令名、预算、本机 HTTP 地址）与按客户端设定的 `COUNCIL_CALLER_ACTOR_ALIAS`，不写任何凭据。

## 入口与依赖方向

`http/routes/client-config-routes.ts` → `client-config-service.ts` → `files` / `store` / `sources` → `errors.ts`、`stdio-mcp.ts`（仅取标记常量）。
目标路径与 MCP env 来自 `config.ts` 的 `loadClientConfigSettings`（`COUNCIL_CLIENT_CONFIG_*`，留空即缺省）。本目录不依赖数据库与编排层。

## 验证方式

`npm run check`；E2E（`scripts/e2e.mjs`）把四个目标路径都指向临时数据目录，`webui-http-smoke.py` 走通写入 → 漂移 409 → 还原，`webui-smoke.py` 在 mock 模式走通界面写入/还原。验证时绝不能让目标路径落到真实家目录。
