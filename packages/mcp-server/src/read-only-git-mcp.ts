/**
 * @input  依赖：ACP stdio MCP 配置、内部 Git 根目录/仓库白名单环境与只读 Git diff 服务
 * @output 导出：获授权 ACP DelegatedRuntime 可调用的多仓库单工具 MCP server 与安全启动配置
 * @pos    DelegatedRuntime 的多仓库 Git diff 桥；只暴露 council_git_diff，不继承 Council 主服务工具
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { isSea } from "node:sea";
import type { McpServerStdio } from "@agentclientprotocol/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import {
  COUNCIL_GIT_DIFF_TOOL_NAME,
  ReadOnlyGitDiff,
  ReadOnlyGitDiffError,
  type GitCommitGrant,
  type ReadOnlyGitDiffConfig,
} from "./read-only-git-diff.js";

export const READ_ONLY_GIT_MCP_FLAG = "--readonly-git-mcp";

const ENV = {
  root: "COUNCIL_READONLY_GIT_ROOT",
  targets: "COUNCIL_READONLY_GIT_TARGETS",
  command: "COUNCIL_READONLY_GIT_COMMAND",
  timeoutMs: "COUNCIL_READONLY_GIT_TIMEOUT_MS",
  killGraceMs: "COUNCIL_READONLY_GIT_KILL_GRACE_MS",
  maxFiles: "COUNCIL_READONLY_GIT_MAX_FILES",
  maxLines: "COUNCIL_READONLY_GIT_MAX_LINES",
  maxHunksPerFile: "COUNCIL_READONLY_GIT_MAX_HUNKS_PER_FILE",
  maxOutputChars: "COUNCIL_READONLY_GIT_MAX_OUTPUT_CHARS",
} as const;

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`缺少内部只读 Git 配置 ${name}。`);
  }
  return value;
}

function positiveInteger(name: string, env: NodeJS.ProcessEnv): number {
  const value = Number(required(name, env));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`内部只读 Git 配置 ${name} 必须是正整数。`);
  }
  return value;
}

function configFromEnvironment(env: NodeJS.ProcessEnv): {
  root: string;
  targets: readonly GitCommitGrant[];
  config: ReadOnlyGitDiffConfig;
} {
  let targets: unknown;
  try {
    targets = JSON.parse(required(ENV.targets, env));
  } catch {
    throw new Error(`内部只读 Git 配置 ${ENV.targets} 不是有效 JSON。`);
  }
  if (
    !Array.isArray(targets)
    || targets.some((target) =>
      !target
      || typeof target !== "object"
      || Array.isArray(target)
      || typeof (target as Record<string, unknown>).repository !== "string"
      || typeof (target as Record<string, unknown>).commit !== "string")
  ) {
    throw new Error(`内部只读 Git 配置 ${ENV.targets} 必须是仓库/commit 数组。`);
  }
  return {
    root: required(ENV.root, env),
    targets: targets as GitCommitGrant[],
    config: {
      gitCommand: required(ENV.command, env),
      gitDiffTimeoutMs: positiveInteger(ENV.timeoutMs, env),
      gitDiffKillGraceMs: positiveInteger(ENV.killGraceMs, env),
      gitDiffMaxFiles: positiveInteger(ENV.maxFiles, env),
      gitDiffMaxLines: positiveInteger(ENV.maxLines, env),
      gitDiffMaxHunksPerFile: positiveInteger(ENV.maxHunksPerFile, env),
      gitDiffMaxOutputChars: positiveInteger(ENV.maxOutputChars, env),
    },
  };
}

function entryCommand(): { command: string; args: string[] } {
  if (isSea()) {
    return {
      command: process.execPath,
      args: [READ_ONLY_GIT_MCP_FLAG],
    };
  }
  const entry = process.argv[1];
  if (!entry) {
    throw new Error("无法定位 Council Agent Service 入口。");
  }
  return {
    command: process.execPath,
    args: [
      ...process.execArgv,
      entry,
      READ_ONLY_GIT_MCP_FLAG,
    ],
  };
}

export function readOnlyGitMcpServerConfig(
  root: string,
  config: ReadOnlyGitDiffConfig,
  targets: readonly GitCommitGrant[] = [],
): McpServerStdio {
  const launch = entryCommand();
  return {
    name: "Council Read-only Git",
    command: launch.command,
    args: launch.args,
    env: [
      { name: ENV.root, value: root },
      { name: ENV.targets, value: JSON.stringify(targets) },
      { name: ENV.command, value: config.gitCommand },
      { name: ENV.timeoutMs, value: String(config.gitDiffTimeoutMs) },
      { name: ENV.killGraceMs, value: String(config.gitDiffKillGraceMs) },
      { name: ENV.maxFiles, value: String(config.gitDiffMaxFiles) },
      { name: ENV.maxLines, value: String(config.gitDiffMaxLines) },
      { name: ENV.maxHunksPerFile, value: String(config.gitDiffMaxHunksPerFile) },
      { name: ENV.maxOutputChars, value: String(config.gitDiffMaxOutputChars) },
    ],
  };
}

export async function createReadOnlyGitMcpServer(
  root: string,
  config: ReadOnlyGitDiffConfig,
  targets: readonly GitCommitGrant[] = [],
): Promise<McpServer> {
  const gitDiff = await ReadOnlyGitDiff.create(root, config, targets);
  const server = new McpServer({
    name: "council-readonly-git",
    version: "1",
  });
  server.registerTool(
    COUNCIL_GIT_DIFF_TOOL_NAME,
    {
      title: "读取受控 Git diff",
      description:
        "读取本轮已授权仓库中已提交 commit 或 base/head 范围的安全 diff；不读取未提交工作区，敏感路径会被过滤。",
      inputSchema: {
        repository: z.string().min(1).max(200).optional(),
        commit: z.string().min(1).max(200).optional(),
        base: z.string().min(1).max(200).optional(),
        head: z.string().min(1).max(200).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ repository, commit, base, head }) => {
      try {
        const text = await gitDiff.generate({
          ...(repository ? { repository } : {}),
          ...(commit ? { commit } : {}),
          ...(base ? { base } : {}),
          ...(head ? { head } : {}),
        });
        return { content: [{ type: "text", text }] };
      } catch (error) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: error instanceof ReadOnlyGitDiffError
              ? error.message
              : "Council Git diff 执行失败。",
          }],
        };
      }
    },
  );
  return server;
}

export async function runReadOnlyGitMcp(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const settings = configFromEnvironment(env);
  const server = await createReadOnlyGitMcpServer(
    settings.root,
    settings.config,
    settings.targets,
  );
  await server.connect(new StdioServerTransport());
}
