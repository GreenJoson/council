/** @input 原生 Runtime、当前阶段与私有委派仓储；@output 持久进度、会话与准确终止原因；@pos 仅只读瞬态失败重试，写入与预算暂停不自动重放。 */
import { setTimeout as retryDelay } from "node:timers/promises";
import type { AgentPermissionProfile } from "../agent-execution-policy.js";
import type { ClaudeRuntime } from "../claude-runtime.js";
import type { CodexRuntime } from "../codex-runtime.js";
import type { AgentDefinition, ProviderProfile } from "../model-router-store.js";
import type { NativeRuntimeProgress } from "../native-runtime-progress.js";
import { checkpointProgress, type DelegationPhase } from "./delegation-checkpoint.js";
import { delegationFailureCode } from "./delegation-recovery.js";
import type { WorkItemDelegationStore } from "./work-item-delegation-store.js";

export interface DelegationRuntimeInput {
  delegationId: string;
  stage: Exclude<DelegationPhase, "commit">;
  transportAttempt?: number;
  agent: AgentDefinition;
  prompt: string;
  cwd: string;
  sessionId?: string;
  permissionProfile: AgentPermissionProfile;
  signal: AbortSignal;
}
interface Dependencies {
  claude: ClaudeRuntime;
  codex: CodexRuntime;
  store: WorkItemDelegationStore;
  provider: ProviderProfile;
  maxAttempts: number;
  retryDelayMs: number;
  record: (id: string, kind: string, data: Record<string, string | number>) => void;
  failureMessage: (error: unknown) => string;
}
export async function runDelegationRuntimeStage(input: DelegationRuntimeInput, deps: Dependencies): Promise<{ content: string; sessionId?: string }> {
  const { delegationId: id, stage } = input;
  const now = new Date().toISOString();
  const initial = deps.store.getPrivate(id);
  if (!initial) throw new Error("任务委派不存在。");
  deps.store.update(id, { checkpoint: { ...initial.checkpoint, version: 1,
    progress: { phase: stage, phaseStartedAt: now, lastActivityAt: now } }, now });
  let observed: NativeRuntimeProgress = { toolCalls: 0 };
  let savedSession: string | undefined;
  const onProgress = (progress: NativeRuntimeProgress) => {
    observed = progress;
    const current = deps.store.getPrivate(id);
    // 迟到事件不能覆盖取消或终结状态。
    if (!current || input.signal.aborted || ["failed", "cancelled", "approved"].includes(current.status)) return;
    const stamp = new Date().toISOString();
    deps.store.update(id, {
      checkpoint: { ...current.checkpoint, version: 1,
        progress: checkpointProgress(stage, current.checkpoint?.progress, progress, stamp) },
      ...(progress.sessionId ? stage === "execution" ? { executorSessionId: progress.sessionId } : { supervisorSessionId: progress.sessionId } : {}), now: stamp,
    });
    if (progress.sessionId && savedSession !== progress.sessionId) {
      savedSession = progress.sessionId;
      deps.record(id, "session.checkpoint", { stage, sessionSaved: 1 });
    }
  };
  const startedAt = Date.now();
  deps.record(id, `${stage}.started`, { agentId: input.agent.id, model: input.agent.model,
    agentRevision: input.agent.configRevision, providerRevision: deps.provider.configRevision,
    permission: input.permissionProfile, transportAttempt: input.transportAttempt ?? 1 });
  try {
    const common = { prompt: input.prompt, cwd: input.cwd, signal: input.signal,
      permissionProfile: input.permissionProfile, onProgress,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.agent.model ? { model: input.agent.model } : {}) };
    const result = deps.provider.protocol === "claude-cli"
      ? await deps.claude.generate({ ...common, purpose: stage }) : await deps.codex.generate(common);
    // 兼容未在初始化事件提供 session 的旧 CLI。
    onProgress({ ...observed, ...(result.sessionId ? { sessionId: result.sessionId } : {}), stopReason: "success" });
    deps.record(id, `${stage}.completed`, { summary: result.content, elapsedMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    const code = delegationFailureCode(error);
    onProgress({ ...observed, stopReason: code });
    deps.record(id, `${stage}.failed`, { summary: deps.failureMessage(error), failureCode: code,
      elapsedMs: Date.now() - startedAt, toolCalls: observed.toolCalls,
      ...(observed.turnsUsed !== undefined ? { turnsUsed: observed.turnsUsed } : {}),
      ...(observed.turnLimit !== undefined ? { turnLimit: observed.turnLimit } : {}) });
    const attempt = input.transportAttempt ?? 1;
    if (input.permissionProfile === "read_only" && code === "transient_failure" && attempt < deps.maxAttempts && !input.signal.aborted) {
      await retryDelay(deps.retryDelayMs, undefined, { signal: input.signal });
      const { sessionId: _session, ...fresh } = input;
      return runDelegationRuntimeStage({ ...fresh, transportAttempt: attempt + 1 }, deps);
    }
    throw error;
  }
}
