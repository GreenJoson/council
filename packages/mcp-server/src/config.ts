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

function parseArgs(env: NodeJS.ProcessEnv): string[] {
  const raw = env.COUNCIL_CLAUDE_ARGS_JSON?.trim();
  if (!raw) {
    return [];
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new Error("COUNCIL_CLAUDE_ARGS_JSON 必须是字符串数组 JSON。");
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
  return {
    dataDir,
    databasePath: path.join(dataDir, "council.sqlite3"),
    claudeCommand: requireEnv("COUNCIL_CLAUDE_COMMAND", env),
    claudeArgs: parseArgs(env),
    ...(model ? { claudeModel: model } : {}),
    claudePermissionMode: requireEnv("COUNCIL_CLAUDE_PERMISSION_MODE", env),
    claudeTimeoutMs: parsePositiveInteger("COUNCIL_CLAUDE_TIMEOUT_MS", env),
    claudeMaxTurns: parsePositiveInteger("COUNCIL_CLAUDE_MAX_TURNS", env),
    sqliteBusyTimeoutMs: parsePositiveInteger("COUNCIL_SQLITE_BUSY_TIMEOUT_MS", env),
    maxContextChars: parsePositiveInteger("COUNCIL_MAX_CONTEXT_CHARS", env),
    maxOutputChars: parsePositiveInteger("COUNCIL_MAX_OUTPUT_CHARS", env),
    defaultMessageLimit,
  };
}
