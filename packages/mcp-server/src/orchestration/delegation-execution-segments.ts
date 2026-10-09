/** @input 冻结预算、隔离工作区快照与已校验的交接；@output 有界分段执行及持久接续证据；@pos CLI 调用结束与任务完成分离，交接包装不改变接续条件。 */
import { DelegationExecutionCheckpointError, parseExecutionHandoff } from "./delegation-execution-result.js";
import { delegationFailureCode } from "./delegation-recovery.js";
import type { DelegationCheckpoint } from "./delegation-checkpoint.js";

export interface ExecutionBudget {
  limit: number;
  used: number;
  startedAt: string;
  timeoutMs: number;
  unchangedSegments: number;
}
interface Result { content: string; sessionId?: string }

export async function runExecutionSegments(input: {
  maxSegments: number;
  automaticContinuation: boolean;
  timeoutMs: number;
  sessionId?: string;
  signal: AbortSignal;
  read: () => { checkpoint?: DelegationCheckpoint; executorSessionId?: string };
  save: (budget: ExecutionBudget, summary?: string) => void;
  snapshot: () => Promise<string>;
  validate: () => void;
  generate: (sessionId: string | undefined, continuation: string, signal: AbortSignal) => Promise<Result>;
  record: (kind: string, data: Record<string, string | number>) => void;
}): Promise<Result> {
  const saved = input.read().checkpoint?.executionBudget;
  const budget: ExecutionBudget = saved ?? { limit: input.maxSegments, used: 0,
    timeoutMs: input.timeoutMs, startedAt: new Date().toISOString(), unchangedSegments: 0 };
  const deadline = Date.parse(budget.startedAt) + budget.timeoutMs;
  let sessionId = input.sessionId;
  let continuation = "";
  let before = input.automaticContinuation ? await input.snapshot() : "";
  for (;;) {
    input.signal.throwIfAborted();
    input.validate();
    if (budget.used >= budget.limit) throw new DelegationExecutionCheckpointError("execution_segment_limit", "执行接续预算已用尽；代码与阶段记录已保存，请检查后接续。");
    if (Date.now() >= deadline) throw new DelegationExecutionCheckpointError("execution_time_limit", "执行累计时间预算已用尽；代码已保留，请检查后接续。");
    budget.used += 1;
    input.save(budget);
    input.record("execution.segment.started", { segment: budget.used, segmentLimit: budget.limit });
    const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    let result: Result | undefined;
    let exhausted: unknown;
    try {
      result = await input.generate(sessionId, continuation, AbortSignal.any([input.signal, timeout]));
    } catch (error) {
      if (input.signal.aborted) throw error;
      if (timeout.aborted) throw new DelegationExecutionCheckpointError("execution_time_limit", "执行累计时间预算已用尽；代码已保留，请检查后接续。");
      // 认证、权限、额度、断流和未知异常不能自动重放写操作。
      if (delegationFailureCode(error) !== "max_turns_exhausted" || !input.automaticContinuation) throw error;
      exhausted = error;
    }
    input.signal.throwIfAborted();
    input.validate();
    sessionId = result?.sessionId ?? input.read().executorSessionId ?? sessionId;
    const handoff = result ? parseExecutionHandoff(result.content) : undefined;
    const partial = handoff?.summary;
    if (result && !handoff) return { ...result, sessionId };
    if (partial) input.save(budget, partial);
    // 未声明可自主继续的旧交接、等待用户输入的交接保留原来的暂停行为。
    const mayContinue = result && handoff
      ? handoff.canContinue
      : Boolean(exhausted && sessionId);
    input.record("execution.checkpoint", { segment: budget.used, summary: partial ?? "CLI 回合耗尽；已保留文件，准备检查实际进展。" });
    if (!mayContinue || !input.automaticContinuation) {
      if (exhausted) throw exhausted;
      throw new DelegationExecutionCheckpointError("execution_checkpoint", "执行已按阶段保存交接，仍有未完成工作；可检查后接续。");
    }
    const after = await input.snapshot();
    budget.unchangedSegments = after === before ? budget.unchangedSegments + 1 : 0;
    before = after;
    input.save(budget);
    if (budget.used >= budget.limit) throw new DelegationExecutionCheckpointError("execution_segment_limit", "执行接续预算已用尽；代码与阶段记录已保存，请检查后接续。");
    // 强制中断没有可靠交接时须有文件进展；主动交接允许一个只检查不改代码的段。
    if ((exhausted && budget.unchangedSegments > 0) || budget.unchangedSegments >= 2) {
      throw new DelegationExecutionCheckpointError("execution_no_progress", "执行连续未产生可核对的代码进展；已暂停，保留文件和阶段记录，请检查任务范围或阻断。");
    }
    continuation = ["这是同一任务、同一隔离工作区的接续执行。先核对已有代码，继续剩余步骤，不重复已完成工作。",
      partial ?? "上一段达到 CLI 回合上限，没有完整交接；现有文件有变化但尚未验收，必须先检查实际状态。",
      `本次委派剩余执行段数：${budget.limit - budget.used}。需要用户处理的阻断请用 canContinue:false 交接。`].join("\n");
    input.record("execution.continued", { nextSegment: budget.used + 1, segmentLimit: budget.limit });
  }
}
