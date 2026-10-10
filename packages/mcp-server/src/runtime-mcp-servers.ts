/**
 * @input  依赖：调用方给出的 stdio MCP 服务定义（命令、参数、环境、工具超时）
 * @output 导出：RuntimeMcpServers 类型、Codex `--config mcp_servers.*` 覆盖参数、Claude `--mcp-config` JSON 与允许工具名
 * @pos    CLI 运行时注入 MCP 服务的唯一序列化点；默认（未传服务）时两种运行时仍保持「无 MCP」隔离
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 *
 * 只有 Worker 团队的 Lead 委派会传入服务（Council 自身的 stdio MCP）；讨论、审核、Worker 一律不传。
 * Codex 侧仍保留 --ignore-user-config，用户 config.toml 里的 MCP 不会混进来，只追加这里显式给出的条目。
 */

export interface RuntimeMcpServer {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  /** 单次工具调用超时（秒）；团队等待类工具会阻塞到分钟级，必须显式放宽。 */
  toolTimeoutSec?: number;
}

export type RuntimeMcpServers = Readonly<Record<string, RuntimeMcpServer>>;

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/u;

function assertServerName(name: string): void {
  // 服务名会拼进 TOML 点路径与 Claude 工具前缀（mcp__<name>），只允许安全字符。
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new Error(`MCP 服务名不合法：${name}`);
  }
}

/** JSON 字符串字面量同时是合法的 TOML 基本字符串（转义集合是 TOML 的子集）。 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlKey(key: string): string {
  return SERVER_NAME_PATTERN.test(key) ? key : tomlString(key);
}

/** 生成 Codex CLI 的 `--config key=value` 参数对；值按 TOML 解析。 */
export function codexMcpConfigArgs(servers: RuntimeMcpServers | undefined): string[] {
  if (!servers) return [];
  const args: string[] = [];
  for (const [name, server] of Object.entries(servers)) {
    assertServerName(name);
    const prefix = `mcp_servers.${name}`;
    const env = Object.entries(server.env)
      .map(([key, value]) => `${tomlKey(key)}=${tomlString(value)}`)
      .join(",");
    args.push(
      "--config", `${prefix}.command=${tomlString(server.command)}`,
      "--config", `${prefix}.args=[${server.args.map(tomlString).join(",")}]`,
      "--config", `${prefix}.env={${env}}`,
    );
    if (server.toolTimeoutSec !== undefined) {
      args.push("--config", `${prefix}.tool_timeout_sec=${String(Math.ceil(server.toolTimeoutSec))}`);
    }
  }
  return args;
}

/** Claude `--mcp-config` 的 JSON；未传服务时为空表，配合 --strict-mcp-config 屏蔽用户 MCP。 */
export function claudeMcpConfigJson(servers: RuntimeMcpServers | undefined): string {
  const mcpServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers ?? {})) {
    assertServerName(name);
    mcpServers[name] = { type: "stdio", command: server.command, args: [...server.args], env: { ...server.env } };
  }
  return JSON.stringify({ mcpServers });
}

/** --print 非交互模式下 MCP 工具需显式放行，否则 acceptEdits 档会直接拒绝调用。 */
export function claudeAllowedMcpTools(servers: RuntimeMcpServers | undefined): string[] {
  return Object.keys(servers ?? {}).map((name) => {
    assertServerName(name);
    return `mcp__${name}`;
  });
}
