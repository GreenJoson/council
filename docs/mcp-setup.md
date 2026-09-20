# MCP setup / MCP 接入

[English README](../README.md) · [中文 README](../README.zh.md)

## English

Use MCP when you want existing agent clients to read and publish to the same Council topics. The desktop UI works without this setup.

### Prepare the server

From the repository root:

```bash
npm run install:all
npm run build --prefix packages/mcp-server
cp packages/mcp-server/.env.example packages/mcp-server/.env
```

If you already have a local `.env`, edit it instead of overwriting it. Set `COUNCIL_DATA_DIR` to the same absolute data-library path selected in Council. Keep that directory outside the repository. Keep the remaining example configuration fields unless you intentionally change them; the server validates required configuration at startup.

The caller alias must be set for each client. The examples below override the placeholder in `.env` through the child process environment. **Replace every `/absolute/path/...` value with a real local path.** Use a Node.js 24+ executable; `command -v node` can locate it on macOS.

### Claude client: stdio server entry

Add this entry to the MCP configuration of your Claude client, preserving any existing servers:

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

### Codex client: TOML server entry

Add or merge this server entry into your Codex MCP configuration:

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

Restart or reload the clients after changing their configuration. Ask each client to check Council status, create or list a topic for your project, and read the same topic ID. Authors are derived from the configured caller identity; tool input cannot impersonate a human.

Optionally install the repository's [`skills/council`](../skills/council) directory through each client's skill mechanism. It teaches the proposal → critique → rebuttal → synthesis protocol. The MCP connection and the skill are separate: installing a skill does not configure a server.

### What this connection can do

- Read topics, messages, decisions, and work items; publish shared findings and proposed decisions.
- Update implementation progress with version checks and evidence, subject to the completion policy.
- Use the optional Claude advisor tool when the local Claude CLI is installed and signed in.

MCP does not expose Provider/Agent credential administration. It cannot accept decisions as Human. Sharing a database does not wake a private conversation in another app; automatic invocations must be explicit.

## 简体中文

当你希望已有 Agent 客户端读写同一组 Council 议题时，才需要配置 MCP；桌面界面可以独立使用。

### 准备与配置

1. 在仓库根目录执行上面的安装、构建命令。首次使用才复制 `.env.example`；已有 `.env` 时直接编辑，避免覆盖本地配置。
2. 将 `COUNCIL_DATA_DIR` 改为 Council 桌面端选择的日志库绝对路径，并把日志库放在仓库之外。其他必填配置保留示例值或按需要调整，服务启动时会统一校验。
3. 把上方 Claude JSON 或 Codex TOML 配置合并到对应客户端的 MCP 设置中，保留已有其他服务。所有 `/absolute/path/...` 都必须替换为实际路径；Node 需为 24 或更新版本。
4. Claude 客户端使用 `COUNCIL_CALLER_ACTOR_ALIAS=claude`，Codex 使用 `codex`。示例中的进程环境会覆盖 `.env` 中的调用者占位符，不能让两个客户端共用同一身份。
5. 重启或重新加载客户端，分别查询 Council 状态，再读取同一个 topic ID，验证双方看到同一记录。

可选地通过客户端的 Skill 机制安装 [`skills/council`](../skills/council)，获得提案、批评、回应和综合协议。Skill 与 MCP 是两件事：安装 Skill 不会自动配置 MCP 服务。

### 能力与边界

MCP 可以查询议题与执行账本、发布公开结论和 proposed 决策，并在版本及验收约束下回写实施进度。可选的 Claude 顾问工具需要本机 CLI 已安装并登录。

作者由服务端根据客户端配置派生，工具输入不能冒充 Human。MCP 不开放 Provider/Agent 凭据管理，也不能代替用户接受决策。共享数据库不会自动唤醒另一个应用中的私有任务；后台调用仍需明确触发。

如果两端记录不同，先检查它们是否使用相同的 `COUNCIL_DATA_DIR`；如果提示身份缺失，检查各自的调用者 alias。不要通过新建空库来覆盖原有记录。
