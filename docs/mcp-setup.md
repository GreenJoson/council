# MCP setup / MCP 接入

[English README](../README.md) · [中文 README](../README.zh.md)

## English

Use MCP when you want existing agent clients to read and publish to the same Council topics. The desktop UI works without this setup.

### Recommended: Settings → Client access → Write

Open **Model & Provider settings** (the model router dialog), choose **Client access** at the bottom of the left navigation, and click **Write** on the Claude Code and/or Codex card. Council then:

- registers a `council` stdio MCP server in that client's config, pointing at the running Council service's data library and caller identity (`claude` or `codex`);
- copies the repository's [`skills/council`](../skills/council) directory into that client's skills directory.

Restart or reload the client afterwards. Ask it to check Council status and read a topic ID to confirm both clients see the same records.

Only Council's own fragment is touched; everything else in the file is preserved:

| Client | Config file (default) | Managed fragment | Skill directory (default) |
|---|---|---|---|
| Claude Code | `~/.claude.json` | the `mcpServers.council` key (rewritten with 2-space indentation) | `~/.claude/skills/council` |
| Codex | `<codex-home>/config.toml` (`<codex-home>` is `CODEX_HOME`, or `~/.codex`) | a text block between `# >>> council managed (do not edit) >>>` and `# <<< council managed <<<` | `<codex-home>/skills/council` |

The service's `COUNCIL_CLIENT_CONFIG_CLAUDE_FILE`, `COUNCIL_CLIENT_CONFIG_CLAUDE_SKILLS_DIR`, `COUNCIL_CLIENT_CONFIG_CODEX_FILE` and `COUNCIL_CLIENT_CONFIG_CODEX_SKILLS_DIR` override these targets (absolute paths; leave empty for the defaults). If the Codex file already contains a hand-written `[mcp_servers.council]` table outside the managed block, Write is refused (409); remove or rename that table first.

**Backup, state and restore.** Bookkeeping lives under `<data-dir>/client-config/`:

- `stash/<client>/<timestamp>/` — taken before the first write: the original config file (or a note that it did not exist), any existing directory at the skill path, and a `manifest.json`. Rewrites reuse the first stash.
- `applied.json` — per client: target paths, write time, the SHA-256 of the config file after writing, of the managed fragment and of the skill tree, and the stash path.

Each card shows one of four states:

- **Not written** — no record.
- **Written** — the file and skill tree still match what Council wrote.
- **Drifted** — the config file or skill tree changed after writing (the client, you, or another tool edited it). A plain Write is refused; **Rewrite (overwrite drift)** replaces Council's fragment and skill directory again, leaving your other edits alone.
- **File missing** — the record exists but the config file is gone.

**Restore** clears the record and keeps the stash as a backup:

- if the state is **Written**, the stash is replayed exactly (a file that did not exist before is deleted again);
- if it is **Drifted** or **File missing**, only Council's fragment and the skill directory Council wrote are removed, a previously existing skill directory is put back from the stash, and your later edits are kept.

Note: Claude Code rewrites `~/.claude.json` itself fairly often, so the Claude card may show **Drifted** soon after writing. That is expected; Restore then removes only the `council` key.

The registration contains no credentials. Its `env` carries the data library path, the non-secret runtime limits, the local HTTP address and `COUNCIL_CALLER_ACTOR_ALIAS`. In development the command is the service's own Node.js executable plus the built `packages/mcp-server/dist/src/index.js` (run `npm run build --prefix packages/mcp-server` first). In the desktop app it is the bundled service executable with `--council-stdio-mcp`. If Node.js or the app moves, the card reports an outdated registration; click Write again.

### Fallback: manual configuration

Use this only when the UI is not available, for example for a client on another machine or a non-default config location you do not want Council to manage.

From the repository root:

```bash
npm run install:all
npm run build --prefix packages/mcp-server
cp packages/mcp-server/.env.example packages/mcp-server/.env
```

If you already have a local `.env`, edit it instead of overwriting it. Set `COUNCIL_DATA_DIR` to the same absolute data-library path selected in Council. Keep that directory outside the repository. Keep the remaining example configuration fields unless you intentionally change them; the server validates required configuration at startup.

The caller alias must be set for each client. The examples below override the placeholder in `.env` through the child process environment. **Replace every `/absolute/path/...` value with a real local path.** Use a Node.js 24+ executable; `command -v node` can locate it on macOS.

Claude client — add this entry to its MCP configuration, preserving any existing servers:

```json
{
  "mcpServers": {
    "council": {
      "command": "/absolute/path/to/node",
      "args": [
        "--env-file=/absolute/path/to/council/packages/mcp-server/.env",
        "/absolute/path/to/council/packages/mcp-server/dist/src/index.js"
      ],
      "env": {
        "COUNCIL_CALLER_ACTOR_ALIAS": "claude"
      }
    }
  }
}
```

Some clients expose server entries through their own UI; enter the same command, arguments, and environment there.

Codex client — add or merge this server entry into its MCP configuration:

```toml
[mcp_servers.council]
command = "/absolute/path/to/node"
args = [
  "--env-file=/absolute/path/to/council/packages/mcp-server/.env",
  "/absolute/path/to/council/packages/mcp-server/dist/src/index.js"
]

[mcp_servers.council.env]
COUNCIL_CALLER_ACTOR_ALIAS = "codex"
```

A hand-written `[mcp_servers.council]` table blocks the UI Write for Codex; remove it before switching to the recommended path.

Restart or reload the clients after changing their configuration. Optionally install [`skills/council`](../skills/council) through each client's skill mechanism. It teaches the proposal → critique → rebuttal → synthesis protocol. The MCP connection and the skill are separate: installing a skill does not configure a server.

### What this connection can do

- Read topics, messages, decisions, and work items; publish shared findings and proposed decisions.
- Update implementation progress with version checks and evidence, subject to the completion policy.
- Use the optional Claude advisor tool when the local Claude CLI is installed and signed in.

Authors are derived from the configured caller identity; tool input cannot impersonate a human. MCP does not expose Provider/Agent credential administration. It cannot accept decisions as Human. Sharing a database does not wake a private conversation in another app; automatic invocations must be explicit.

## 简体中文

当你希望已有 Agent 客户端读写同一组 Council 议题时，才需要配置 MCP；桌面界面可以独立使用。

### 首选：设置 → 客户端接入 → 写入

打开「模型与 Provider 设置」（模型路由对话框），在左侧导航底部选择「客户端接入」，在 Claude Code 和/或 Codex 卡片上点「写入」。Council 会：

- 在该客户端配置里注册名为 `council` 的 stdio MCP 服务，指向当前 Council 服务使用的日志库，并绑定调用者身份（`claude` 或 `codex`）；
- 把仓库的 [`skills/council`](../skills/council) 目录复制到该客户端的 Skill 目录。

写入后重启或重新加载客户端，让它查询 Council 状态并读取同一个 topic ID，确认双方看到同一记录。

Council 只改自己的片段，文件里其余内容原样保留：

| 客户端 | 配置文件（默认） | 受管片段 | Skill 目录（默认） |
|---|---|---|---|
| Claude Code | `~/.claude.json` | `mcpServers.council` 键（以 2 空格缩进写回） | `~/.claude/skills/council` |
| Codex | `<codex-home>/config.toml`（`<codex-home>` 为 `CODEX_HOME`，未设置时是 `~/.codex`） | `# >>> council managed (do not edit) >>>` 与 `# <<< council managed <<<` 之间的文本块 | `<codex-home>/skills/council` |

服务端配置 `COUNCIL_CLIENT_CONFIG_CLAUDE_FILE`、`COUNCIL_CLIENT_CONFIG_CLAUDE_SKILLS_DIR`、`COUNCIL_CLIENT_CONFIG_CODEX_FILE`、`COUNCIL_CLIENT_CONFIG_CODEX_SKILLS_DIR` 可覆盖上述目标（绝对路径，留空即默认）。若 Codex 文件在受管块之外已有手写的 `[mcp_servers.council]`，写入会被拒绝（409），请先删除或改名该表。

**备份、状态与还原。** 账本位于 `<data-dir>/client-config/`：

- `stash/<client>/<时间戳>/`：首次写入前拍下的备份，包括原配置文件（或“原本不存在”的标记）、Skill 路径上原有的目录，以及 `manifest.json`。重复写入沿用首次备份。
- `applied.json`：每个客户端一条记录，包括目标路径、写入时间、写入后配置文件的 SHA-256、受管片段与 Skill 目录树的 SHA-256，以及备份路径。

每张卡片显示四种状态之一：

- **未写入**：没有记录。
- **已写入**：配置文件与 Skill 目录仍与 Council 写入时一致。
- **已漂移**：写入后配置文件或 Skill 目录被改动（客户端自身、你或其他工具）。此时普通「写入」会被拒绝；「重新写入（覆盖漂移）」只重写 Council 的片段与 Skill 目录，你的其他改动不受影响。
- **文件丢失**：有记录，但配置文件已不存在。

**「还原」** 会清除记录，备份目录保留：

- 状态为**已写入**时，按备份精确回放；原本不存在的文件会被删除。
- 状态为**已漂移**或**文件丢失**时，只删除 Council 的片段和 Council 写入的 Skill 目录，原有的同名 Skill 目录从备份放回，你之后的改动保留。

注意：Claude Code 自己会频繁改写 `~/.claude.json`，所以 Claude 卡片写入后不久就可能显示「已漂移」。这属于预期行为，此时「还原」只会移除 `council` 键。

注册内容不含任何凭据。`env` 只包含日志库路径、非敏感的运行上限、本机 HTTP 地址和 `COUNCIL_CALLER_ACTOR_ALIAS`。开发环境下，启动命令是服务自身的 Node.js 可执行文件加构建产物 `packages/mcp-server/dist/src/index.js`（需先执行 `npm run build --prefix packages/mcp-server`）；桌面应用里则是内置服务可执行文件加 `--council-stdio-mcp`。Node.js 或应用位置变化后，卡片会提示注册已过期，重新「写入」即可。

### 备用：手动配置

仅在无法使用界面时采用，例如为另一台机器上的客户端配置，或目标是你不希望 Council 托管的非默认位置。

1. 在仓库根目录执行上方英文部分的安装、构建命令。首次使用才复制 `.env.example`；已有 `.env` 时直接编辑，避免覆盖本地配置。
2. 将 `COUNCIL_DATA_DIR` 改为 Council 桌面端选择的日志库绝对路径，并把日志库放在仓库之外。其他必填配置保留示例值或按需要调整，服务启动时会统一校验。
3. 把上方 Claude JSON 或 Codex TOML 配置合并到对应客户端的 MCP 设置中，保留已有其他服务。所有 `/absolute/path/...` 都必须替换为实际路径；Node 需为 24 或更新版本。
4. Claude 客户端使用 `COUNCIL_CALLER_ACTOR_ALIAS=claude`，Codex 使用 `codex`。示例中的进程环境会覆盖 `.env` 中的调用者占位符，不能让两个客户端共用同一身份。
5. 重启或重新加载客户端，分别查询 Council 状态，再读取同一个 topic ID，验证双方看到同一记录。

手写的 `[mcp_servers.council]` 会阻止界面对 Codex 的写入；改用首选方式前请先删除它。可选地通过客户端的 Skill 机制安装 [`skills/council`](../skills/council)，获得提案、批评、回应和综合协议。Skill 与 MCP 是两件事：安装 Skill 不会自动配置 MCP 服务。

### 能力与边界

MCP 可以查询议题与执行账本、发布公开结论和 proposed 决策，并在版本及验收约束下回写实施进度。可选的 Claude 顾问工具需要本机 CLI 已安装并登录。

作者由服务端根据客户端配置派生，工具输入不能冒充 Human。MCP 不开放 Provider/Agent 凭据管理，也不能代替用户接受决策。共享数据库不会自动唤醒另一个应用中的私有任务；后台调用仍需明确触发。

如果两端记录不同，先检查它们是否使用相同的 `COUNCIL_DATA_DIR`；如果提示身份缺失，检查各自的调用者 alias。不要通过新建空库来覆盖原有记录。
