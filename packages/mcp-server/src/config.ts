/**
 * @input  依赖：COUNCIL_* 环境变量与本地文件系统
 * @output 导出：经过校验的 CouncilConfig
 * @pos    MCP 服务的集中式配置加载入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { MAX_LIST_LIMIT } from "./constants.js";
import type { CouncilConfig } from "./types.js";

const MAX_NODE_TIMER_MS = 2_147_483_647;
const REQUIRED_PERMISSION_MODE = "plan";
const FORBIDDEN_CLAUDE_ARGS = new Set([
  "--",
  "-c",
  "-p",
  "-r",
  "--add-dir",
  "--allow-dangerously-skip-permissions",
  "--allowed-tools",
  "--allowedtools",
  "--continue",
  "--dangerously-skip-permissions",
  "--fork-session",
  "--max-turns",
  "--model",
  "--output-format",
  "--permission-mode",
  "--permission-prompt-tool",
  "--print",
  "--resume",
  "--session-id",
]);

function requireEnv(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`缺少环境变量 ${name}，请在 MCP 配置中设置。`);
  }
  return value;
}

function parsePositiveInteger(name: string, env: NodeJS.ProcessEnv): number {
  const raw = requireEnv(name, env);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`环境变量 ${name} 必须是正整数。`);
  }
  return value;
}

function parseTimer(name: string, env: NodeJS.ProcessEnv): number {
  const value = parsePositiveInteger(name, env);
  if (value > MAX_NODE_TIMER_MS) {
    throw new Error(`环境变量 ${name} 不能超过 Node.js 定时器上限。`);
  }
  return value;
}

function isForbiddenClaudeArg(value: string): boolean {
  const flag = value.split("=", 1)[0]?.toLowerCase() ?? "";
  return FORBIDDEN_CLAUDE_ARGS.has(flag);
}

function parseArgs(env: NodeJS.ProcessEnv): string[] {
  const raw = env.COUNCIL_CLAUDE_ARGS_JSON?.trim();
  if (!raw) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("COUNCIL_CLAUDE_ARGS_JSON 必须是有效的字符串数组 JSON。");
  }
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new Error("COUNCIL_CLAUDE_ARGS_JSON 必须是字符串数组 JSON。");
  }
  if (parsed.some(isForbiddenClaudeArg)) {
    throw new Error("COUNCIL_CLAUDE_ARGS_JSON 包含运行时保留参数或危险权限参数。");
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CouncilConfig {
  const dataDir = requireEnv("COUNCIL_DATA_DIR", env);
  if (!path.isAbsolute(dataDir)) {
    throw new Error("COUNCIL_DATA_DIR 必须是绝对路径。");
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const model = env.COUNCIL_CLAUDE_MODEL?.trim();
  const defaultMessageLimit = parsePositiveInteger("COUNCIL_DEFAULT_MESSAGE_LIMIT", env);
  if (defaultMessageLimit > MAX_LIST_LIMIT) {
    throw new Error(`COUNCIL_DEFAULT_MESSAGE_LIMIT 不能超过 ${String(MAX_LIST_LIMIT)}。`);
  }
  const permissionMode = requireEnv("COUNCIL_CLAUDE_PERMISSION_MODE", env);
  if (permissionMode !== REQUIRED_PERMISSION_MODE) {
    throw new Error("COUNCIL_CLAUDE_PERMISSION_MODE 必须为 plan。");
  }
  return {
    dataDir,
    databasePath: path.join(dataDir, "council.sqlite3"),
    claudeCommand: requireEnv("COUNCIL_CLAUDE_COMMAND", env),
    claudeArgs: parseArgs(env),
    ...(model ? { claudeModel: model } : {}),
    claudePermissionMode: permissionMode,
    claudeTimeoutMs: parseTimer("COUNCIL_CLAUDE_TIMEOUT_MS", env),
    claudeKillGraceMs: parseTimer("COUNCIL_CLAUDE_KILL_GRACE_MS", env),
    claudeMaxTurns: parsePositiveInteger("COUNCIL_CLAUDE_MAX_TURNS", env),
    sqliteBusyTimeoutMs: parsePositiveInteger("COUNCIL_SQLITE_BUSY_TIMEOUT_MS", env),
    maxContextChars: parsePositiveInteger("COUNCIL_MAX_CONTEXT_CHARS", env),
    maxOutputChars: parsePositiveInteger("COUNCIL_MAX_OUTPUT_CHARS", env),
    defaultMessageLimit,
  };
}
