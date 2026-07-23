/**
 * @input  依赖：公开 prompt、Claude Code CLI 配置、共享进程工具与可选 AbortSignal
 * @output 导出：纯 ClaudeRuntime 生成接口、可用性检查与脱敏失败分类
 * @pos    无数据库副作用的 Claude Code 子进程运行边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  assertRuntimeTimers,
  makeAbortError,
  normalizeCliOption,
  runBoundedProcess,
  type BoundedProcessMessages,
  type ProcessResult,
} from "./process-utils.js";
import type { ClaudeResponse, CouncilConfig } from "./types.js";

type ClaudeRuntimeConfig = Pick<
  CouncilConfig,
  | "claudeCommand"
  | "claudeArgs"
  | "claudePermissionMode"
  | "claudeTimeoutMs"
  | "claudeKillGraceMs"
  | "claudeMaxTurns"
  | "maxOutputChars"
>;

export interface ClaudeRuntimeInput {
  prompt: string;
  cwd: string;
  sessionId?: string;
  model?: string;
  signal?: AbortSignal;
}

export interface ClaudeAvailability {
  available: boolean;
  authenticated: boolean;
  version?: string;
  authMethod?: string;
  error?: string;
}

export class ClaudeRuntimeError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly diagnosticCode: string,
  ) {
    super(message);
    this.name = "ClaudeRuntimeError";
  }
}

interface ClaudeJsonResult {
  result?: unknown;
  session_id?: unknown;
  sessionId?: unknown;
  model?: unknown;
  is_error?: unknown;
  loggedIn?: unknown;
  authMethod?: unknown;
}

const ABORT_MESSAGE = "Claude Code 调用已取消。";

const PROCESS_MESSAGES: BoundedProcessMessages = {
  aborted: ABORT_MESSAGE,
  timeout: "Claude Code 调用超时，请缩小议题或调整 COUNCIL_CLAUDE_TIMEOUT_MS。",
  outputLimit: "Claude Code 输出超过配置上限，请缩小问题或提高 COUNCIL_MAX_OUTPUT_CHARS。",
  commandNotFound: "找不到 Claude Code 可执行程序，请安装 CLI 或设置 COUNCIL_CLAUDE_COMMAND。",
  spawnFailed: "无法启动 Claude Code，请检查可执行权限和项目目录配置。",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(text: string): ClaudeJsonResult | undefined {
  const candidates = [text.trim(), ...text.trim().split("\n").reverse()];
  for (const candidate of candidates) {
    if (!candidate.startsWith("{")) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      // 继续尝试下一行，兼容运行时附带提示文本的情况。
    }
  }
  return undefined;
}

function loginError(): ClaudeRuntimeError {
  return new ClaudeRuntimeError(
    "Claude Code CLI 未登录。请先完成一次 claude auth login；Claude Desktop 手动接力模式不受影响。",
    false,
    "authentication_failed",
  );
}

function classifyFailure(content: string): ClaudeRuntimeError {
  if (/not logged in|authentication|unauthorized/i.test(content)) {
    return loginError();
  }
  if (/out of usage credits|usage limit|quota|insufficient credit/i.test(content)) {
    return new ClaudeRuntimeError(
      "Claude 模型额度不足，请补充额度或在 Council 设置中切换模型。",
      false,
      "quota_exhausted",
    );
  }
  if (/model.*(?:not found|unavailable|not supported|access)|invalid model/i.test(content)) {
    return new ClaudeRuntimeError(
      "Claude 模型不可用，请在 Council 设置中选择当前账号可用的模型。",
      false,
      "model_unavailable",
    );
  }
  if (/max(?:imum)?(?: number of)? turns|turn limit|reached[^\n]*turn/i.test(content)) {
    return new ClaudeRuntimeError(
      "Claude 已达到本轮工具回合上限。请缩小议题范围，或提高 Council 的 Claude 回合上限。",
      false,
      "max_turns_exhausted",
    );
  }
  const retryable = /overloaded|rate limit|temporar|try again|service unavailable/i.test(content);
  return new ClaudeRuntimeError(
    "Claude Code 返回失败结果，请检查模型权限和本地日志。",
    retryable,
    retryable ? "transient_failure" : "request_failed",
  );
}

function parseClaudeOutput(stdout: string): ClaudeResponse {
  const parsed = parseJsonObject(stdout);
  if (!parsed) {
    const content = stdout.trim();
    if (!content) {
      throw new Error("Claude Code 没有返回可用内容。");
    }
    return { content };
  }
  const content = typeof parsed.result === "string" ? parsed.result.trim() : "";
  if (parsed.is_error === true) {
    throw classifyFailure(content);
  }
  if (!content) {
    throw new Error("Claude Code 返回失败结果，请检查认证、模型和权限配置。");
  }
  const rawSessionId = parsed.session_id ?? parsed.sessionId;
  const sessionId =
    typeof rawSessionId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(rawSessionId)
      ? rawSessionId
      : undefined;
  const model = typeof parsed.model === "string" ? parsed.model : undefined;
  return {
    content,
    ...(sessionId ? { sessionId } : {}),
    ...(model ? { model } : {}),
  };
}

function normalizeSessionId(sessionId: string | undefined): string | undefined {
  return normalizeCliOption(
    sessionId,
    /^[A-Za-z0-9._:-]+$/,
    () => new Error("Claude session ID 格式无效。"),
  );
}

function normalizeModel(model: string | undefined): string | undefined {
  return normalizeCliOption(
    model,
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/,
    () => new Error("Claude model 格式无效。"),
  );
}

export class ClaudeRuntime {
  constructor(private readonly config: ClaudeRuntimeConfig) {
    if (config.claudePermissionMode !== "plan") {
      throw new Error("ClaudeRuntime 只允许 plan 权限模式。");
    }
    assertRuntimeTimers(
      config.claudeTimeoutMs,
      config.claudeKillGraceMs,
      "ClaudeRuntime 定时器配置无效。",
    );
  }

  async #run(
    args: string[],
    input: string,
    cwd?: string,
    signal?: AbortSignal,
  ): Promise<ProcessResult> {
    return await runBoundedProcess({
      command: this.config.claudeCommand,
      args: [...this.config.claudeArgs, ...args],
      input,
      ...(cwd ? { cwd } : {}),
      ...(signal ? { signal } : {}),
      timeoutMs: this.config.claudeTimeoutMs,
      killGraceMs: this.config.claudeKillGraceMs,
      maxOutputChars: this.config.maxOutputChars,
      messages: PROCESS_MESSAGES,
    });
  }

  async checkAvailability(): Promise<ClaudeAvailability> {
    try {
      const versionResult = await this.#run(["--version"], "");
      if (versionResult.exitCode !== 0) {
        throw new Error("Claude Code 版本检查失败。");
      }
      const authResult = await this.#run(["auth", "status"], "");
      const authJson = parseJsonObject(authResult.stdout);
      const authenticated = authJson?.loggedIn === true;
      const authMethod =
        typeof authJson?.authMethod === "string" ? authJson.authMethod : undefined;
      return {
        available: true,
        authenticated,
        version: versionResult.stdout.trim() || "unknown",
        ...(authMethod ? { authMethod } : {}),
        ...(!authenticated
          ? { error: "Claude Code CLI 尚未登录；自动顾问模式需要先完成一次登录。" }
          : {}),
      };
    } catch (error) {
      return {
        available: false,
        authenticated: false,
        error: error instanceof Error ? error.message : "Claude Code 可用性检查失败。",
      };
    }
  }

  async generate(input: ClaudeRuntimeInput): Promise<ClaudeResponse> {
    const model = normalizeModel(input.model);
    const sessionId = normalizeSessionId(input.sessionId);
    const args = [
      "--print",
      "--output-format",
      "json",
      "--permission-mode",
      this.config.claudePermissionMode,
      "--max-turns",
      String(this.config.claudeMaxTurns),
      ...(model ? ["--model", model] : []),
      ...(sessionId ? ["--resume", sessionId] : []),
    ];
    const result = await this.#run(args, input.prompt, input.cwd, input.signal);
    if (input.signal?.aborted) {
      throw makeAbortError(ABORT_MESSAGE);
    }
    if (result.exitCode !== 0) {
      const parsed = parseJsonObject(result.stdout);
      const content = typeof parsed?.result === "string" ? parsed.result : "";
      if (parsed?.is_error === true) {
        throw classifyFailure(content);
      }
      throw new ClaudeRuntimeError(
        "Claude Code 调用失败，请检查登录状态、模型权限和本地日志。",
        true,
        `process_exit_${String(result.exitCode)}`,
      );
    }
    return parseClaudeOutput(result.stdout);
  }
}
