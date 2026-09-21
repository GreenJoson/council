/**
 * @input  依赖：公开 prompt、Claude Code CLI stream-json、共享进程工具与可选 AbortSignal
 * @output 导出：ClaudeRuntime 增量生成、结构化失败/进度、分阶段回合预算、独立输出限额与可用性检查
 * @pos    无数据库副作用且只转发公开 text_delta 的 Claude Code 子进程运行边界；讨论默认强制只读，
 *         生成时强制清空 MCP 配置，使被召唤 Agent 无法取得 Council 写工具或递归召唤自身
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 * 分阶段回合预算、结构化失败和早期会话/白名单进度回调
 */

import { classifyClaudeFailure, NativeRuntimeProgressTracker, type NativeRuntimeProgressListener, type NativeRuntimeProgress } from "./native-runtime-progress.js";
import {
  assertRuntimeTimers,
  makeAbortError,
  normalizeCliOption,
  ProcessOutputLimitError,
  runBoundedProcess,
  type BoundedProcessMessages,
  type ProcessResult,
} from "./process-utils.js";
import {
  JsonLineDecoder,
  type RuntimeTextListener,
} from "./runtime-stream.js";
import type { ClaudeResponse, CouncilConfig } from "./types.js";
import type { AgentPermissionProfile } from "./agent-execution-policy.js";

type ClaudeRuntimeConfig = Pick<
  CouncilConfig,
  | "claudeCommand"
  | "claudeArgs"
  | "claudePermissionMode"
  | "claudeTimeoutMs"
  | "claudeKillGraceMs"
  | "claudeMaxTurns"
  | "claudeExecutionMaxTurns"
  | "claudeReviewMaxTurns"
  | "maxOutputChars"
  | "cliMaxStreamChars"
>;

// 只读沙箱只约束文件系统，约束不到 MCP 工具的外部副作用。被编排召唤的 headless Agent
// 若继承调用者的 MCP 配置，就能拿到 Council 自身的写工具——自行发帖会绕过 lease/原子提交、
// 自行建议题会造成议题分裂、递归召唤会让自动交接失去出口。正式回复一律由编排器提交，
// Agent 不需要任何 MCP，因此在进程边界上直接清空，而不是靠提示词约束。
const MCP_ISOLATION_ARGS = [
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
] as const;

const MAX_STDERR_DETAIL_CHARS = 300;

/** 取 stderr 首个非空行作为失败原因；CLI 的拒绝理由都在第一行。 */
function firstStderrLine(stderr: string): string {
  const line = stderr
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  if (!line) {
    return "";
  }
  return line.length > MAX_STDERR_DETAIL_CHARS
    ? `${line.slice(0, MAX_STDERR_DETAIL_CHARS)}…`
    : line;
}

export interface ClaudeRuntimeInput {
  prompt: string;
  cwd: string;
  sessionId?: string;
  model?: string;
  signal?: AbortSignal;
  onActivity?: () => void;
  onProgress?: NativeRuntimeProgressListener;
  purpose?: "brief" | "execution" | "review";
  onTextEvent?: RuntimeTextListener;
  /** 仅显式任务委派传入；普通讨论省略后固定为 read_only。 */
  permissionProfile?: AgentPermissionProfile;
}

export interface ClaudeAvailability {
  available: boolean;
  authenticated: boolean;
  version?: string;
  authMethod?: string;
  error?: string;
}

export class ClaudeRuntimeError extends Error {
  progress?: NativeRuntimeProgress;
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly diagnosticCode: string,
    /**
     * 仅供本地日志的失败细节。message 会成为公开消息，privateDetail 不会——
     * 两者必须保持这个不对称，否则 CLI 的 stderr 会随讨论一起被存进共享库。
     */
    readonly privateDetail?: string,
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
  subtype?: unknown;
  errors?: unknown;
  num_turns?: unknown;
  permission_denials?: unknown;
  loggedIn?: unknown;
  authMethod?: unknown;
}

const ABORT_MESSAGE = "Claude Code 调用已取消。";
const STREAM_RETAINED_OUTPUT_MULTIPLIER = 3;

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

function textFromClaudeContent(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((item) => (
      isRecord(item) && item.type === "text" && typeof item.text === "string"
        ? item.text
        : ""
    ))
    .join("");
}

function observeClaudeStreamEvent(value: unknown, listener: RuntimeTextListener): void {
  if (!isRecord(value)) {
    return;
  }
  if (value.type === "stream_event" && isRecord(value.event)) {
    const event = value.event;
    if (event.type === "message_start") {
      listener({ operation: "reset" });
      return;
    }
    if (
      event.type === "content_block_delta"
      && isRecord(event.delta)
      && event.delta.type === "text_delta"
      && typeof event.delta.text === "string"
      && event.delta.text
    ) {
      listener({ operation: "append", content: event.delta.text });
    }
    return;
  }
  if (value.type === "assistant" && isRecord(value.message)) {
    const content = textFromClaudeContent(value.message.content);
    if (content) {
      listener({ operation: "replace", content });
    }
    return;
  }
  if (value.type === "result" && typeof value.result === "string" && value.result.trim()) {
    listener({ operation: "replace", content: value.result });
  }
}

function loginError(): ClaudeRuntimeError {
  return new ClaudeRuntimeError(
    "Claude Code CLI 未登录。请先完成一次 claude auth login；Claude Desktop 手动接力模式不受影响。",
    false,
    "authentication_failed",
  );
}

function classifyFailure(value: unknown): ClaudeRuntimeError {
  const failure = classifyClaudeFailure(value);
  return new ClaudeRuntimeError(failure.message, failure.retryable, failure.diagnosticCode);
}

function parseClaudeOutput(stdout: string, finalResult?: ClaudeJsonResult): ClaudeResponse {
  const parsed = finalResult ?? parseJsonObject(stdout);
  if (!parsed) {
    const content = stdout.trim();
    if (!content) {
      throw new Error("Claude Code 没有返回可用内容。");
    }
    return { content };
  }
  const content = typeof parsed.result === "string" ? parsed.result.trim() : "";
  if (parsed.is_error === true || (typeof parsed.subtype === "string" && parsed.subtype.startsWith("error_"))) {
    throw classifyFailure(parsed);
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
    onStdoutChunk?: (chunk: string) => void,
    maxTotalOutputChars?: number,
    retainedOutputChars = this.config.maxOutputChars,
  ): Promise<ProcessResult> {
    try {
      return await runBoundedProcess({
        command: this.config.claudeCommand,
        args: [...this.config.claudeArgs, ...args],
        input,
        ...(cwd ? { cwd } : {}),
        ...(signal ? { signal } : {}),
        timeoutMs: this.config.claudeTimeoutMs,
        killGraceMs: this.config.claudeKillGraceMs,
        maxOutputChars: retainedOutputChars,
        stdoutOverflow: onStdoutChunk ? "truncate" : "stop",
        ...(onStdoutChunk ? { onStdoutChunk } : {}),
        ...(maxTotalOutputChars ? { maxTotalOutputChars } : {}),
        messages: PROCESS_MESSAGES,
      });
    } catch (error) {
      if (error instanceof ProcessOutputLimitError && maxTotalOutputChars !== undefined) {
        throw new ClaudeRuntimeError(
          `Claude Code 执行事件流超过配置上限（已接收 ${error.receivedChars} 字符，上限 ${error.limitChars}）。请调整 COUNCIL_CLI_MAX_STREAM_CHARS。`,
          false,
          "stream_output_limit",
        );
      }
      throw error;
    }
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
    const permissionProfile = input.permissionProfile ?? "read_only";
    const permissionArgs = permissionProfile === "danger_full_access"
      ? ["--dangerously-skip-permissions"]
      : [
          "--permission-mode",
          permissionProfile === "workspace_write" ? "acceptEdits" : this.config.claudePermissionMode,
        ];
    const turnLimit = input.purpose === "execution" ? this.config.claudeExecutionMaxTurns
      : input.purpose === "review" ? this.config.claudeReviewMaxTurns : this.config.claudeMaxTurns;
    const progress = new NativeRuntimeProgressTracker("claude", input.onProgress, turnLimit);
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      // 没有预览/活动监听的代码委派只需完整事件，避免逐字分片重复放大传输量。
      ...(input.onTextEvent || input.onActivity ? ["--include-partial-messages"] : []),
      // CLI 契约：--print 搭配 stream-json 必须带 --verbose，否则子进程直接退出 1
      // 且不产出任何 stream-json，调用方只能看到一个没有原因的失败。
      "--verbose",
      ...permissionArgs,
      ...MCP_ISOLATION_ARGS,
      "--max-turns",
      String(turnLimit),
      ...(model ? ["--model", model] : []),
      ...(sessionId ? ["--resume", sessionId] : []),
    ];
    let finalResult: ClaudeJsonResult | undefined;
    // 最终结果单独提取，不依赖可能截断 JSON 行的 stdout 首尾窗口。
    const decoder = new JsonLineDecoder((value) => {
      if (isRecord(value) && value.type === "result") finalResult = value;
      progress.observe(value);
      input.onActivity?.();
      if (input.onTextEvent) observeClaudeStreamEvent(value, input.onTextEvent);
    });
    try {
      const result = await this.#run(
        args,
        input.prompt,
        input.cwd,
        input.signal,
        (chunk) => decoder.push(chunk),
        this.config.cliMaxStreamChars,
        this.config.maxOutputChars * STREAM_RETAINED_OUTPUT_MULTIPLIER,
      );
      decoder.flush();
      if (input.signal?.aborted) {
        throw makeAbortError(ABORT_MESSAGE);
      }
      if (result.exitCode !== 0) {
        const parsed = finalResult ?? parseJsonObject(result.stdout);
        if (parsed?.is_error === true || (typeof parsed?.subtype === "string" && parsed.subtype.startsWith("error_"))) {
          throw classifyFailure(parsed);
        }
        // CLI 因参数或环境自身拒绝时只写 stderr、不产出 stream-json，公开消息里就只剩
        // 「检查登录状态和模型权限」这种猜测。stderr 可能带路径与提示词，绝不能进公开流，
        // 因此原因只随错误对象走到本地日志，公开消息保持脱敏。
        throw new ClaudeRuntimeError(
          "Claude Code 调用失败，请查看失败阶段与本地日志。",
          true,
          `process_exit_${String(result.exitCode)}`,
          firstStderrLine(result.stderr),
        );
      }
      const response = parseClaudeOutput(result.stdout, finalResult);
      if (response.content.length > this.config.maxOutputChars) {
        throw new ClaudeRuntimeError(
          `Claude Code 最终回复超过 ${this.config.maxOutputChars} 字符，请缩短交付摘要或调整 COUNCIL_MAX_OUTPUT_CHARS。`,
          false,
          "final_output_limit",
        );
      }
      return response;
    } catch (error) {
      if (error instanceof ClaudeRuntimeError) error.progress = progress.snapshot;
      throw error;
    }
  }
}
