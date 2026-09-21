/** @input CLI 白名单进度、冻结指令及历史交接；@output 私有检查点及公开阶段投影；@pos 会话、原始指令与交接不进入公开进度 DTO。 */
import type { NativeRuntimeProgress } from "../native-runtime-progress.js";
import type { DelegationHandoff } from "./delegation-handoff.js";
export type DelegationPhase = "brief" | "execution" | "commit" | "review";
export interface DelegationExecutionProgress {
  phase: DelegationPhase;
  phaseStartedAt: string;
  lastActivityAt: string;
  turnsUsed?: number;
  turnLimit?: number;
  toolCalls?: number;
  lastTool?: string;
  stopReason?: string;
  checkpointAvailable?: boolean;
}
export interface DelegationCheckpoint {
  version: 1;
  progress?: DelegationExecutionProgress;
  brief?: { content: string; fingerprint: string };
  handoff?: DelegationHandoff;
}
export function publicExecutionProgress(checkpoint: DelegationCheckpoint | undefined): DelegationExecutionProgress | undefined {
  if (!checkpoint?.progress) return undefined;
  const { phase, phaseStartedAt, lastActivityAt, turnsUsed, turnLimit, toolCalls, lastTool, stopReason } = checkpoint.progress;
  return { phase, phaseStartedAt, lastActivityAt, turnsUsed, turnLimit, toolCalls, lastTool, stopReason,
    checkpointAvailable: Boolean(checkpoint.brief) };
}
export function checkpointProgress(phase: DelegationPhase, previous: DelegationExecutionProgress | undefined,
  value: NativeRuntimeProgress, now: string): DelegationExecutionProgress {
  return { phase, phaseStartedAt: previous?.phase === phase ? previous.phaseStartedAt : now, lastActivityAt: now,
    toolCalls: value.toolCalls, ...(value.turnsUsed !== undefined ? { turnsUsed: value.turnsUsed } : {}),
    ...(value.turnLimit !== undefined ? { turnLimit: value.turnLimit } : {}),
    ...(value.lastTool ? { lastTool: value.lastTool } : {}), ...(value.stopReason ? { stopReason: value.stopReason } : {}) };
}
