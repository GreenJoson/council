/**
 * @input  依赖：stdio-mcp.ts 的 resolveStdioMcpLaunch（dev 用 dist/src/index.js，桌面 sidecar 用自身可执行 + 标记）、启动时收集的 COUNCIL_* 环境
 * @output 导出：resolveCouncilMcpEntry（定位本机 Council MCP 入口）、buildLeadMcpServers（Lead 委派专用的 council MCP 定义）、
 *         LEAD_MCP_TOOL_TIMEOUT_SEC
 * @pos    Worker 团队 Lead 注入 MCP 的唯一组装点；只有团队 Lead 的执行阶段会拿到这份配置
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 *
 * 身份：COUNCIL_CALLER_ACTOR_ALIAS 固定为 Lead 执行者 Agent 的 @别名，MCP 进程据此解析调用者，Lead 不能冒充他人；
 * COUNCIL_TEAM_LEAD_DELEGATION_ID 让团队工具无需 taskId 就能定位团队，同时把 MCP 进程切到「只注册团队工具」模式。
 * 地址：COUNCIL_HTTP_HOST/PORT 取 HTTP 服务实际监听值（写操作经回环 HTTP 转发，不由 MCP 进程直接驱动委派）。
 */
import type { RuntimeMcpServers } from "../runtime-mcp-servers.js";
import { resolveStdioMcpLaunch } from "../stdio-mcp.js";

/** council_wait_worker 单次最多阻塞 600 秒；工具超时留出余量，Codex 默认 60 秒会提前掐断等待。 */
export const LEAD_MCP_TOOL_TIMEOUT_SEC = 900;

export interface CouncilMcpEntry {
  command: string;
  args: readonly string[];
}

/**
 * 与客户端接入写入的注册同源：dev 指向构建产物 dist/src/index.js，桌面 sidecar 用自身可执行 + --council-stdio-mcp。
 * 只有源码未构建（tsx 跑源码且没有 dist）时找不到入口：返回 undefined，由 TeamService 拒绝组队并说明原因。
 */
export function resolveCouncilMcpEntry(): CouncilMcpEntry | undefined {
  try {
    return resolveStdioMcpLaunch();
  } catch {
    return undefined;
  }
}

export function buildLeadMcpServers(input: {
  entry: CouncilMcpEntry;
  /** collectCouncilEnv() 的结果：数据库路径等 COUNCIL_* 配置，已剔除身份与凭据类键。 */
  baseEnv: Readonly<Record<string, string>>;
  callerAlias: string;
  leadDelegationId: string;
  httpHost: string;
  httpPort: number;
}): RuntimeMcpServers {
  return {
    council: {
      command: input.entry.command,
      args: input.entry.args,
      env: {
        ...input.baseEnv,
        COUNCIL_CALLER_ACTOR_ALIAS: input.callerAlias,
        COUNCIL_TEAM_LEAD_DELEGATION_ID: input.leadDelegationId,
        COUNCIL_HTTP_HOST: input.httpHost,
        COUNCIL_HTTP_PORT: String(input.httpPort),
      },
      toolTimeoutSec: LEAD_MCP_TOOL_TIMEOUT_SEC,
    },
  };
}
