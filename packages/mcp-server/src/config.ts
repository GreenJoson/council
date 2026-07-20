/**
 * @input  依赖：COUNCIL_* 环境变量与本地文件系统
 * @output 导出：经过校验的 CouncilConfig（含 Claude 与 Codex 后台运行时配置）
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
const REQUIRED_CODEX_SANDBOX_MODE = "read-only";
const DEFAULT_CODEX_COMMAND = "codex";
const DEFAULT_CODEX_TIMEOUT_MS = 180_000;
const DEFAULT_CODEX_KILL_GRACE_MS = 3_000;

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

// Codex 侧拦截运行时保留参数、危险沙箱/审批参数与子命令注入；
// 校验统一小写，因此 "-c" 同时覆盖 "-C/--cd" 的短写变体。
const FORBIDDEN_CODEX_ARGS = new Set([
  "--",
  "-c",
  "-i",
  "-m",
  "-o",
  "-p",
  "-s",
  "--add-dir",
  "--all",
  "--cd",
  "--config",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--full-auto",
  "--image",
  "--json",
  "--last",
  "--local-provider",
  "--model",
  "--oss",
  "--output-last-message",
  "--output-schema",
  "--profile",
  "--sandbox",
  "--skip-git-repo-check",
  "exec",
  "resume",
  "review",
]);

function requireEnv(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`缺少环境变量 ${name}，请在 MCP 配置中设置。`);
  }
  return value;
}

function parsePositiveIntegerValue(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`环境变量 ${name} 必须是正整数。`);
  }
  return value;
}

function parsePositiveInteger(name: string, env: NodeJS.ProcessEnv): number {
  return parsePositiveIntegerValue(name, requireEnv(name, env));
}

function parseTimerValue(name: string, raw: string): number {
  const value = parsePositiveIntegerValue(name, raw);
  if (value > MAX_NODE_TIMER_MS) {
    throw new Error(`环境变量 ${name} 不能超过 Node.js 定时器上限。`);
  }
  return value;
}

function parseTimer(name: string, env: NodeJS.ProcessEnv): number {
  return parseTimerValue(name, requireEnv(name, env));
}

/** Codex 配置允许缺省：未设置时使用安全默认值，设置后按同样规则严格校验。 */
function parseOptionalTimer(name: string, env: NodeJS.ProcessEnv, fallback: number): number {
  const raw = env[name]?.trim();
  return raw ? parseTimerValue(name, raw) : fallback;
}

function isForbiddenArg(value: string, forbidden: ReadonlySet<string>): boolean {
  const flag = value.split("=", 1)[0]?.toLowerCase() ?? "";
  return forbidden.has(flag);
}

function parseArgsJson(
  name: string,
  env: NodeJS.ProcessEnv,
  forbidden: ReadonlySet<string>,
): string[] {
  const raw = env[name]?.trim();
  if (!raw) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} 必须是有效的字符串数组 JSON。`);
  }
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new Error(`${name} 必须是字符串数组 JSON。`);
  }
  if (parsed.some((value) => isForbiddenArg(value, forbidden))) {
    throw new Error(`${name} 包含运行时保留参数或危险权限参数。`);
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
  const codexModel = env.COUNCIL_CODEX_MODEL?.trim();
  const codexSandboxMode = env.COUNCIL_CODEX_SANDBOX_MODE?.trim() || REQUIRED_CODEX_SANDBOX_MODE;
  if (codexSandboxMode !== REQUIRED_CODEX_SANDBOX_MODE) {
    throw new Error("COUNCIL_CODEX_SANDBOX_MODE 必须为 read-only。");
  }
  return {
    dataDir,
    databasePath: path.join(dataDir, "council.sqlite3"),
    claudeCommand: requireEnv("COUNCIL_CLAUDE_COMMAND", env),
    claudeArgs: parseArgsJson("COUNCIL_CLAUDE_ARGS_JSON", env, FORBIDDEN_CLAUDE_ARGS),
    ...(model ? { claudeModel: model } : {}),
    claudePermissionMode: permissionMode,
    claudeTimeoutMs: parseTimer("COUNCIL_CLAUDE_TIMEOUT_MS", env),
    claudeKillGraceMs: parseTimer("COUNCIL_CLAUDE_KILL_GRACE_MS", env),
    claudeMaxTurns: parsePositiveInteger("COUNCIL_CLAUDE_MAX_TURNS", env),
    codexCommand: env.COUNCIL_CODEX_COMMAND?.trim() || DEFAULT_CODEX_COMMAND,
    codexArgs: parseArgsJson("COUNCIL_CODEX_ARGS_JSON", env, FORBIDDEN_CODEX_ARGS),
    ...(codexModel ? { codexModel } : {}),
    codexSandboxMode,
    codexTimeoutMs: parseOptionalTimer("COUNCIL_CODEX_TIMEOUT_MS", env, DEFAULT_CODEX_TIMEOUT_MS),
    codexKillGraceMs: parseOptionalTimer(
      "COUNCIL_CODEX_KILL_GRACE_MS",
      env,
      DEFAULT_CODEX_KILL_GRACE_MS,
    ),
    sqliteBusyTimeoutMs: parsePositiveInteger("COUNCIL_SQLITE_BUSY_TIMEOUT_MS", env),
    maxContextChars: parsePositiveInteger("COUNCIL_MAX_CONTEXT_CHARS", env),
    maxOutputChars: parsePositiveInteger("COUNCIL_MAX_OUTPUT_CHARS", env),
    defaultMessageLimit,
  };
}
