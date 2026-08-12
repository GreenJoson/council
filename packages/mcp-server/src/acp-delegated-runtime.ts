/**
 * @input  依赖：声明式 ACP RuntimeDefinition、ACP v1 SDK、项目目录/仓库白名单、只读 Git MCP、持久 RuntimeBinding 与 AbortSignal
 * @output 导出：每 binding 长驻、可恢复、含受控多仓库 diff/文本读取的通用 ACP DelegatedRuntime
 * @pos    供应商无关的 DelegatedRuntime；外部 Agent 拥有 AgentLoop，Council 只管理 session 与权限
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type ClientConnection,
  type RequestPermissionRequest,
  type SessionConfigOption,
  type SessionConfigSelectGroup,
  type SessionConfigSelectOption,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import {
  RUNTIME_CAPABILITY_KEYS,
  type RuntimeCapabilityKey,
} from "council-orchestrator";
import type { CouncilConfig } from "./types.js";
import type { AcpRuntimeDefinition } from "./acp-runtime-registry.js";
import {
  IS_POSIX,
  makeAbortError,
  normalizeCliOption,
  runBoundedProcess,
  terminateProcessTree,
} from "./process-utils.js";
import { isProtectedProjectRelativePath } from "./project-path-policy.js";
import {
  COUNCIL_GIT_DIFF_TOOL_NAME,
  normalizeGitCommitGrant,
  resolveAuthorizedGitRepositoryRoot,
  type GitCommitGrant,
} from "./read-only-git-diff.js";
import { readOnlyGitMcpServerConfig } from "./read-only-git-mcp.js";

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/,-]*$/u;
const SESSION_PATTERN = /^[A-Za-z0-9._:-]+$/u;
const READ_ONLY_TOOL_KINDS = new Set(["read", "search", "think"]);

function isAllowedDelegatedTool(
  kind: string | null | undefined,
  name: string | null | undefined,
  capabilities: readonly string[],
): boolean {
  if (name === COUNCIL_GIT_DIFF_TOOL_NAME) {
    return capabilities.includes("git_diff");
  }
  if (kind === "read" || kind === "search") {
    return capabilities.includes("repository_read");
  }
  return kind === "think"
    && capabilities.includes("text")
    && READ_ONLY_TOOL_KINDS.has(kind);
}

export interface AcpRuntimeAvailability {
  available: boolean;
  authenticated: boolean;
  version?: string;
  error?: string;
}

export interface AcpDelegatedRuntimeInput {
  definition: AcpRuntimeDefinition;
  /** Council policy 与 Runtime 声明取交集后的唯一有效能力集。 */
  grantedCapabilities: readonly RuntimeCapabilityKey[];
  bindingId: string;
  cwd: string;
  prompt: string;
  model: string;
  gitCommitTargets?: readonly GitCommitGrant[];
  sessionId?: string;
  signal?: AbortSignal;
  onUpdate?: (update: SessionUpdate) => void;
  onPermission?: (request: RequestPermissionRequest) => void;
}

export interface AcpDelegatedRuntimeResult {
  content: string;
  sessionId: string;
}

export class AcpDelegatedRuntimeError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly diagnosticCode: string,
  ) {
    super(message);
    this.name = "AcpDelegatedRuntimeError";
  }
}

interface ActiveTurn {
  onUpdate?: (update: SessionUpdate) => void;
  onPermission?: (request: RequestPermissionRequest) => void;
}

interface ManagedAcpProcess {
  definition: AcpRuntimeDefinition;
  grantedCapabilities: readonly RuntimeCapabilityKey[];
  bindingId: string;
  cwd: string;
  rootRealPath: string;
  repositoryRoots: readonly string[];
  model: string;
  gitCommitTargets: readonly GitCommitGrant[];
  sessionId: string;
  child: ChildProcessWithoutNullStreams;
  connection: ClientConnection;
  completion: Promise<void>;
  activeTurn?: ActiveTurn;
  promptActive: boolean;
}

function normalizeGrantedCapabilities(
  definition: AcpRuntimeDefinition,
  capabilities: readonly RuntimeCapabilityKey[],
): RuntimeCapabilityKey[] {
  const declared = new Set(definition.declaredCapabilities);
  const granted = RUNTIME_CAPABILITY_KEYS.filter((capability) =>
    capabilities.includes(capability));
  if (
    !granted.includes("text")
    || granted.some((capability) => !declared.has(capability))
  ) {
    throw new AcpDelegatedRuntimeError(
      `${definition.displayName} 的 ACP 授权能力无效。`,
      false,
      "invalid_capabilities",
    );
  }
  return granted;
}

function sameCapabilities(
  left: readonly RuntimeCapabilityKey[],
  right: readonly RuntimeCapabilityKey[],
): boolean {
  return left.length === right.length
    && left.every((capability, index) => capability === right[index]);
}

function normalizeGitCommitTargets(
  targets: readonly GitCommitGrant[] | undefined,
): readonly GitCommitGrant[] {
  const normalized = new Map<string, GitCommitGrant>();
  for (const target of targets ?? []) {
    const grant = normalizeGitCommitGrant(target);
    normalized.set(`${grant.repository}\0${grant.commit}`, grant);
  }
  return [...normalized.values()].sort((left, right) =>
    left.repository.localeCompare(right.repository)
    || left.commit.localeCompare(right.commit));
}

function sameGitCommitTargets(
  left: readonly GitCommitGrant[],
  right: readonly GitCommitGrant[],
): boolean {
  return left.length === right.length
    && left.every((target, index) =>
      target.repository === right[index]?.repository
      && target.commit === right[index]?.commit);
}

function normalizeModel(model: string, definition: AcpRuntimeDefinition): string {
  return normalizeCliOption(
    model,
    MODEL_PATTERN,
    () => new AcpDelegatedRuntimeError(
      `${definition.displayName} 模型 ID 格式无效。`,
      false,
      "invalid_model",
    ),
  )!;
}

function normalizeSession(
  sessionId: string | undefined,
  definition: AcpRuntimeDefinition,
): string | undefined {
  return normalizeCliOption(
    sessionId,
    SESSION_PATTERN,
    () => new AcpDelegatedRuntimeError(
      `${definition.displayName} session ID 格式无效。`,
      false,
      "invalid_session",
    ),
  );
}

function flattenSelectOptions(
  option: SessionConfigOption,
): SessionConfigSelectOption[] {
  if (option.type !== "select") {
    return [];
  }
  return (
    option.options as Array<SessionConfigSelectOption | SessionConfigSelectGroup>
  ).flatMap((candidate) =>
    "options" in candidate ? candidate.options : [candidate]);
}

/**
 * `session/new` 的旧模型形状。
 *
 * SDK 1.3.0 用 `configOptions` + `session/set_config_option` 表达模型选择，
 * 但真实 Agent 未必跟到这一版：Kimi Code CLI 1.44.0 同样自称 protocolVersion 1，
 * 返回的却是 `models.availableModels`，且 `session/set_config_option` 直接
 * 报 -32601。两种形状都要认，否则只能跑通假 Agent。
 */
interface LegacyAgentModelState {
  availableModels: Array<{ modelId?: unknown; name?: unknown }>;
  currentModelId?: unknown;
}

const SET_MODEL_METHOD = "session/set_model";

function legacyModelState(response: unknown): LegacyAgentModelState | undefined {
  if (typeof response !== "object" || response === null) {
    return undefined;
  }
  const models = (response as { models?: unknown }).models;
  if (typeof models !== "object" || models === null) {
    return undefined;
  }
  const available = (models as { availableModels?: unknown }).availableModels;
  if (!Array.isArray(available)) {
    return undefined;
  }
  return {
    availableModels: available as LegacyAgentModelState["availableModels"],
    currentModelId: (models as { currentModelId?: unknown }).currentModelId,
  };
}

async function selectSessionModel(
  connection: ClientConnection,
  sessionId: string,
  model: string,
  sessionResponse: unknown,
  configOptions: readonly SessionConfigOption[] | null | undefined,
  definition: AcpRuntimeDefinition,
  cancellationSignal: AbortSignal,
): Promise<void> {
  if (definition.modelSelection !== "session-config") {
    return;
  }
  const selector = configOptions?.find((option) =>
    option.type === "select"
    && (option.category === "model" || option.id === "model"));
  const selected = selector
    ? flattenSelectOptions(selector).find((candidate) =>
        candidate.value === model || candidate.name === model)
    : undefined;
  if (selector && selected) {
    if (selector.currentValue !== selected.value) {
      await connection.agent.request(
        methods.agent.session.setConfigOption,
        { sessionId, configId: selector.id, value: selected.value },
        { cancellationSignal },
      );
    }
    return;
  }
  const legacy = legacyModelState(sessionResponse);
  const legacyMatch = legacy?.availableModels.find((candidate) =>
    candidate.modelId === model || candidate.name === model);
  if (legacy && typeof legacyMatch?.modelId === "string") {
    if (legacy.currentModelId !== legacyMatch.modelId) {
      await connection.agent.request(
        SET_MODEL_METHOD,
        { sessionId, modelId: legacyMatch.modelId },
        { cancellationSignal },
      );
    }
    return;
  }
  // 两种形状都没给出这个模型：宁可开局失败，也不要静默用默认模型跑完一轮。
  const offered = legacy?.availableModels
    .map((candidate) => candidate.modelId)
    .filter((candidate): candidate is string => typeof candidate === "string")
    ?? [];
  throw new AcpDelegatedRuntimeError(
    offered.length > 0
      ? `${definition.displayName} 没有模型 ${model}；它公开的是 ${offered.join("、")}。`
      : `${definition.displayName} 没有公开可选择的模型 ${model}。`,
    false,
    "invalid_model",
  );
}

function withinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function readProjectText(
  roots: readonly string[],
  requestedPath: string,
  line: number | null | undefined,
  limit: number | null | undefined,
  maximumChars: number,
): string {
  if (!path.isAbsolute(requestedPath)) {
    throw new Error("ACP 只允许读取绝对文件路径。");
  }
  const realPath = realpathSync(requestedPath);
  const root = [...roots]
    .filter((candidate) => withinRoot(candidate, realPath))
    .sort((left, right) => right.length - left.length)[0];
  const relativePath = root ? path.relative(root, realPath) : "";
  const info = statSync(realPath);
  if (
    !root
    || isProtectedProjectRelativePath(relativePath)
    || !info.isFile()
    || info.size > maximumChars * 4
  ) {
    throw new Error("ACP 文件读取超出当前项目或目标不是普通文件。");
  }
  const startLine = line ?? 1;
  const lineLimit = limit ?? Number.MAX_SAFE_INTEGER;
  if (
    !Number.isSafeInteger(startLine)
    || startLine <= 0
    || !Number.isSafeInteger(lineLimit)
    || lineLimit <= 0
  ) {
    throw new Error("ACP 文件读取行范围无效。");
  }
  const content = readFileSync(realPath, "utf8");
  if (content.includes("\0")) {
    throw new Error("ACP 只允许读取普通文本文件。");
  }
  const selected = content
    .split(/\r?\n/u)
    .slice(startLine - 1, startLine - 1 + lineLimit)
    .join("\n");
  if (selected.length <= maximumChars) {
    return selected;
  }
  return `${selected.slice(0, maximumChars)}\n[Council：文件读取已达到安全上限]`;
}

function publicRuntimeError(
  error: unknown,
  definition: AcpRuntimeDefinition,
): AcpDelegatedRuntimeError {
  if (error instanceof AcpDelegatedRuntimeError) {
    return error;
  }
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
    return new AcpDelegatedRuntimeError(
      `找不到 ${definition.displayName}，请安装后重试。`,
      false,
      "command_not_found",
    );
  }
  const message = error instanceof Error ? error.message : "";
  if (/auth|required|login|unauthorized/iu.test(message)) {
    return new AcpDelegatedRuntimeError(
      `${definition.displayName} 尚未登录或登录已失效。`,
      false,
      "authentication_required",
    );
  }
  return new AcpDelegatedRuntimeError(
    `${definition.displayName} ACP 调用暂时失败，请检查本机 Agent 状态。`,
    true,
    "request_failed",
  );
}

export class AcpDelegatedRuntime {
  readonly #processes = new Map<string, ManagedAcpProcess>();

  constructor(private readonly config: CouncilConfig) {}

  async checkAvailability(
    definition: AcpRuntimeDefinition,
  ): Promise<AcpRuntimeAvailability> {
    try {
      const result = await runBoundedProcess({
        command: definition.agentCommand,
        args: [...definition.versionArgs],
        input: "",
        timeoutMs: this.config.acpStartupTimeoutMs,
        killGraceMs: this.config.acpKillGraceMs,
        maxOutputChars: this.config.maxOutputChars,
        messages: {
          aborted: `${definition.displayName} 可用性检查已取消。`,
          timeout: `${definition.displayName} 可用性检查超时。`,
          outputLimit: `${definition.displayName} 可用性检查输出过长。`,
          commandNotFound: `找不到 ${definition.displayName}。`,
          spawnFailed: `${definition.displayName} 无法启动。`,
        },
      });
      return result.exitCode === 0
        ? {
            available: true,
            authenticated: true,
            version: result.stdout.trim() || "unknown",
          }
        : {
            available: true,
            authenticated: false,
            error: `${definition.displayName} 状态检查失败。`,
          };
    } catch (error) {
      return {
        available: false,
        authenticated: false,
        error: publicRuntimeError(error, definition).message,
      };
    }
  }

  async probe(
    definition: AcpRuntimeDefinition,
    cwd: string,
    model: string,
    grantedCapabilities: readonly RuntimeCapabilityKey[],
  ): Promise<void> {
    const bindingId = `probe-${randomUUID()}`;
    try {
      await this.#open(
        bindingId,
        cwd,
        normalizeModel(model, definition),
        definition,
        normalizeGrantedCapabilities(definition, grantedCapabilities),
      );
    } finally {
      await this.closeBinding(bindingId);
    }
  }

  async generate(
    input: AcpDelegatedRuntimeInput,
  ): Promise<AcpDelegatedRuntimeResult> {
    if (input.signal?.aborted) {
      throw makeAbortError(`${input.definition.displayName} ACP 调用已取消。`);
    }
    const model = normalizeModel(input.model, input.definition);
    const grantedCapabilities = normalizeGrantedCapabilities(
      input.definition,
      input.grantedCapabilities,
    );
    const gitCommitTargets = normalizeGitCommitTargets(input.gitCommitTargets);
    const expectedSessionId = normalizeSession(input.sessionId, input.definition);
    let managed = this.#processes.get(input.bindingId);
    if (
      managed
      && (
        managed.definition.id !== input.definition.id
        || managed.cwd !== input.cwd
        || managed.model !== model
        || !sameCapabilities(managed.grantedCapabilities, grantedCapabilities)
        || !sameGitCommitTargets(managed.gitCommitTargets, gitCommitTargets)
        || (
          expectedSessionId !== undefined
          && managed.sessionId !== expectedSessionId
        )
      )
    ) {
      await this.closeBinding(input.bindingId);
      managed = undefined;
    }
    managed ??= await this.#open(
      input.bindingId,
      input.cwd,
      model,
      input.definition,
      grantedCapabilities,
      expectedSessionId,
      gitCommitTargets,
    );
    if (managed.promptActive) {
      throw new AcpDelegatedRuntimeError(
        `同一 ${input.definition.displayName} RuntimeBinding 已有活动回合。`,
        true,
        "turn_already_active",
      );
    }

    let output = "";
    let outputExceeded = false;
    let safetyViolation = false;
    managed.promptActive = true;
    managed.activeTurn = {
      onPermission: input.onPermission,
      onUpdate: (update) => {
        if (
          update.sessionUpdate === "tool_call"
          && !isAllowedDelegatedTool(
            update.kind,
            update.name,
            managed!.grantedCapabilities,
          )
          && update.status !== "failed"
          && update.status !== "completed"
        ) {
          safetyViolation = true;
          void managed!.connection.agent.notify(methods.agent.session.cancel, {
            sessionId: managed!.sessionId,
          });
          return;
        }
        if (
          update.sessionUpdate === "agent_message_chunk"
          && update.content.type === "text"
        ) {
          output += update.content.text;
          if (output.length > this.config.maxOutputChars) {
            outputExceeded = true;
            void managed!.connection.agent.notify(methods.agent.session.cancel, {
              sessionId: managed!.sessionId,
            });
            return;
          }
        }
        input.onUpdate?.(update);
      },
    };

    const cancel = (): void => {
      void managed!.connection.agent.notify(methods.agent.session.cancel, {
        sessionId: managed!.sessionId,
      }).catch(() => undefined);
    };
    input.signal?.addEventListener("abort", cancel, { once: true });
    try {
      const response = await managed.connection.agent.request(
        methods.agent.session.prompt,
        {
          sessionId: managed.sessionId,
          prompt: [{ type: "text", text: input.prompt }],
        },
        input.signal ? { cancellationSignal: input.signal } : undefined,
      );
      // ACP 消息按线序到达，但 SDK 会分别调度 notification handler 与 request
      // completion；让同一批已到达的 text chunk 先完成投影，避免末分片丢失。
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (input.signal?.aborted || response.stopReason === "cancelled") {
        throw makeAbortError(`${input.definition.displayName} ACP 调用已取消。`);
      }
      if (outputExceeded) {
        throw new AcpDelegatedRuntimeError(
          `${input.definition.displayName} 最终回复超过输出上限。`,
          false,
          "output_limit",
        );
      }
      if (safetyViolation) {
        throw new AcpDelegatedRuntimeError(
          `${input.definition.displayName} 请求了 Council headless 策略禁止的工具。`,
          false,
          "permission_denied",
        );
      }
      if (response.stopReason !== "end_turn") {
        throw new AcpDelegatedRuntimeError(
          `${input.definition.displayName} 未完成回复：${response.stopReason}。`,
          response.stopReason === "max_tokens",
          `stop_${response.stopReason}`,
        );
      }
      const content = output.trim();
      if (!content) {
        throw new AcpDelegatedRuntimeError(
          `${input.definition.displayName} 没有返回公开文本。`,
          true,
          "empty_response",
        );
      }
      return { content, sessionId: managed.sessionId };
    } catch (error) {
      if (input.signal?.aborted) {
        throw input.signal.reason instanceof Error
          ? input.signal.reason
          : makeAbortError(`${input.definition.displayName} ACP 调用已取消。`);
      }
      throw publicRuntimeError(error, input.definition);
    } finally {
      input.signal?.removeEventListener("abort", cancel);
      managed.activeTurn = undefined;
      managed.promptActive = false;
    }
  }

  async closeBinding(bindingId: string): Promise<void> {
    const managed = this.#processes.get(bindingId);
    if (!managed) {
      return;
    }
    this.#processes.delete(bindingId);
    try {
      if (managed.promptActive) {
        await managed.connection.agent.notify(methods.agent.session.cancel, {
          sessionId: managed.sessionId,
        }).catch(() => undefined);
      }
      managed.connection.close();
    } finally {
      await terminateProcessTree(
        managed.child,
        managed.completion,
        this.config.acpKillGraceMs,
      );
    }
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(
      [...this.#processes.keys()].map(async (bindingId) =>
        await this.closeBinding(bindingId)),
    );
  }

  async #open(
    bindingId: string,
    cwd: string,
    model: string,
    definition: AcpRuntimeDefinition,
    grantedCapabilities: readonly RuntimeCapabilityKey[],
    sessionId?: string,
    gitCommitTargets: readonly GitCommitGrant[] = [],
  ): Promise<ManagedAcpProcess> {
    const rootRealPath = realpathSync(cwd);
    const repositoryRoots = new Set<string>([rootRealPath]);
    for (const repository of new Set(
      gitCommitTargets.map((target) => target.repository),
    )) {
      if (repository === ".") {
        continue;
      }
      try {
        repositoryRoots.add(
          await resolveAuthorizedGitRepositoryRoot(rootRealPath, repository),
        );
      } catch {
        // 不可用的关联仓库由 council_git_diff 返回稳定诊断，不能扩大文件读取根。
      }
    }
    const child = spawn(
      definition.agentCommand,
      definition.buildLaunchArgs({ cwd, model }),
      {
        cwd,
        detached: IS_POSIX,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      },
    );
    child.stderr.resume();
    const completion = new Promise<void>((resolve) => {
      child.once("error", resolve);
      child.once("close", () => resolve());
    });

    let managed: ManagedAcpProcess | undefined;
    const app = client({ name: "Council" })
      .onRequest(methods.client.session.requestPermission, (context) => {
        const request = context.params;
        managed?.activeTurn?.onPermission?.(request);
        const kind = request.toolCall.kind ?? "other";
        const allowed = isAllowedDelegatedTool(
          kind,
          request.toolCall.name,
          grantedCapabilities,
        );
        const option = request.options.find((candidate) =>
          candidate.kind === (allowed ? "allow_once" : "reject_once"))
          ?? (!allowed
            ? request.options.find((candidate) => candidate.kind === "reject_always")
            : undefined);
        return option
          ? { outcome: { outcome: "selected" as const, optionId: option.optionId } }
          : { outcome: { outcome: "cancelled" as const } };
      })
      .onRequest(methods.client.fs.readTextFile, (context) => {
        if (!grantedCapabilities.includes("repository_read")) {
          throw new Error("该 ACP RuntimeDefinition 未获得项目文件读取能力。");
        }
        return {
          content: readProjectText(
            managed?.repositoryRoots ?? [...repositoryRoots],
            context.params.path,
            context.params.line,
            context.params.limit,
            this.config.acpMaxFileReadChars,
          ),
        };
      })
      .onRequest(methods.client.fs.writeTextFile, () => {
        throw new Error("Council headless ACP Runtime 禁止写文件。");
      })
      .onNotification(methods.client.session.update, (context) => {
        if (context.params.sessionId === managed?.sessionId) {
          managed.activeTurn?.onUpdate?.(context.params.update);
        }
      });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout),
    );
    const connection = app.connect(stream);
    const startupSignal = AbortSignal.timeout(this.config.acpStartupTimeoutMs);
    try {
      await connection.agent.request(
        methods.agent.initialize,
        {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            ...(grantedCapabilities.includes("repository_read")
              ? { fs: { readTextFile: true, writeTextFile: false } }
              : {}),
            terminal: false,
            session: { configOptions: {} },
          },
          clientInfo: { name: "Council", version: "1" },
        },
        { cancellationSignal: startupSignal },
      );
      const mcpServers = grantedCapabilities.includes("git_diff")
        ? [readOnlyGitMcpServerConfig(
            rootRealPath,
            this.config,
            gitCommitTargets,
          )]
        : [];
      let activeSessionId: string;
      let configOptions: readonly SessionConfigOption[] | null | undefined;
      let sessionResponse: unknown;
      if (sessionId) {
        const resumed = await connection.agent.request(
            methods.agent.session.resume,
            { sessionId, cwd, mcpServers },
            { cancellationSignal: startupSignal },
          );
        activeSessionId = sessionId;
        configOptions = resumed.configOptions;
        sessionResponse = resumed;
      } else {
        const created = await connection.agent.request(
            methods.agent.session.new,
            { cwd, mcpServers },
            { cancellationSignal: startupSignal },
          );
        activeSessionId = created.sessionId;
        configOptions = created.configOptions;
        sessionResponse = created;
      }
      await selectSessionModel(
        connection,
        activeSessionId,
        model,
        sessionResponse,
        configOptions,
        definition,
        startupSignal,
      );
      const opened: ManagedAcpProcess = {
        definition,
        grantedCapabilities,
        bindingId,
        cwd,
        rootRealPath,
        repositoryRoots: [...repositoryRoots],
        model,
        gitCommitTargets,
        sessionId: activeSessionId,
        child,
        connection,
        completion,
        promptActive: false,
      };
      managed = opened;
      this.#processes.set(bindingId, opened);
      void completion.then(() => {
        if (this.#processes.get(bindingId) === opened) {
          this.#processes.delete(bindingId);
        }
      });
      return opened;
    } catch (error) {
      connection.close(error);
      await terminateProcessTree(child, completion, this.config.acpKillGraceMs);
      throw publicRuntimeError(error, definition);
    }
  }
}
