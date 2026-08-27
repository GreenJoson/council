/**
 * @input  依赖：消息类型枚举与 Agent 立场分级
 * @output 导出：辩论四段协议与审核账本两种收敛口径的纯状态机、下一步动作与停止原因
 * @pos    圆桌"什么时候该谁说话、什么时候该停"的唯一判定处；无 IO、无时间、无随机
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { MessageKind } from "../types.js";
import type { VerdictStance } from "./verdict.js";

/** 讨论阶段——`awaiting_user` / `completed` 是容器状态，不是发言阶段。 */
export const DEBATE_STAGES = [
  "proposal",
  "critique",
  "rebuttal",
  "synthesis",
] as const;

export const CYCLE_STAGES = [
  ...DEBATE_STAGES,
  "awaiting_user",
  "completed",
] as const;

export const CYCLE_STOP_REASONS = [
  "converged",
  "round_budget_exhausted",
  "decision_accepted",
  "cancelled",
] as const;

export type DebateStage = (typeof DEBATE_STAGES)[number];
export type CycleStage = (typeof CYCLE_STAGES)[number];
export type CycleStopReason = (typeof CYCLE_STOP_REASONS)[number];

/** 一次已完成的发言；状态机只依赖这些字段，不看正文。 */
export interface CycleTurn {
  agentId: string;
  stage: DebateStage;
  round: number;
  stance: VerdictStance;
}

/**
 * 审核账本。存在时本轮圆桌的收敛条件从「没人再反对」换成「未关闭的阻断发现归零」——
 * 代码审查要的是问题被修掉，不是有人被说服。
 */
export interface ReviewLedger {
  openBlockingFindings: number;
}

export interface ConvergenceState {
  stage: CycleStage;
  /** 仅在 `awaiting_user` 时存在，指向用户回答后要回到的发言阶段。 */
  resumeStage?: DebateStage;
  currentRound: number;
  roundBudget: number;
  /** 开局冻结的名册；首位是提案人，其余按此顺序轮流评审。 */
  participants: readonly string[];
  turns: readonly CycleTurn[];
  hasOpenQuestion: boolean;
  /** 只有 fix_review 圆桌带账本；辩论圆桌没有可修的清单，仍按立场收敛。 */
  reviewLedger?: ReviewLedger;
}

export type CycleAction =
  | {
    kind: "invoke";
    agentId: string;
    stage: DebateStage;
    messageKind: MessageKind;
    round: number;
  }
  | { kind: "await_user" }
  /**
   * 停下等外部 Agent 修复未关闭的发现。与 `await_user` 同为容器状态，
   * 但等的是代码而不是回答，UI 与驱动器据此显示不同的下一步。
   */
  | { kind: "await_fix"; openBlockingFindings: number }
  | { kind: "converge" }
  | { kind: "abandon"; reason: CycleStopReason }
  | { kind: "done" };

export class ConvergenceStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConvergenceStateError";
  }
}

function assertState(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new ConvergenceStateError(message);
  }
}

function proposerOf(state: ConvergenceState): string {
  const proposer = state.participants[0];
  assertState(proposer !== undefined, "收敛名册为空，无法确定提案人。");
  return proposer;
}

function criticsOf(state: ConvergenceState): readonly string[] {
  return state.participants.slice(1);
}

function spokeIn(
  state: ConvergenceState,
  stage: DebateStage,
  round: number,
): ReadonlySet<string> {
  return new Set(
    state.turns
      .filter((turn) => turn.stage === stage && turn.round === round)
      .map((turn) => turn.agentId),
  );
}

function hasBlockingCritique(state: ConvergenceState, round: number): boolean {
  return state.turns.some((turn) =>
    turn.stage === "critique"
    && turn.round === round
    && turn.stance === "blocking");
}

/**
 * 账本判定：还有未关闭的阻断发现就停下等修复，归零才收敛。
 * 这里不看轮次预算——预算约束的是「Agent 自己能吵几轮」，
 * 而每一次复审都由外部显式提交修复触发，不存在自动空转。
 */
function reviewLedgerAction(ledger: ReviewLedger): CycleAction {
  return ledger.openBlockingFindings > 0
    ? { kind: "await_fix", openBlockingFindings: ledger.openBlockingFindings }
    : { kind: "converge" };
}

/** 阶段与它产出的公开消息类型一一对应，不额外映射。 */
function messageKindOf(stage: DebateStage): MessageKind {
  return stage;
}

/**
 * 决定下一步动作。纯函数：同样的状态永远得到同样的动作，
 * 因此中断后重放、崩溃后恢复都会落在同一个分支上。
 */
export function nextCycleAction(state: ConvergenceState): CycleAction {
  assertState(state.roundBudget > 0, "轮次预算必须为正。");
  assertState(state.currentRound >= 1, "当前轮次必须从 1 开始。");
  assertState(
    state.currentRound <= state.roundBudget,
    "当前轮次不能超过轮次预算。",
  );
  assertState(state.participants.length >= 1, "收敛名册至少需要一个 Agent。");
  assertState(
    new Set(state.participants).size === state.participants.length,
    "收敛名册不允许重复 Agent。",
  );

  if (state.stage === "completed") {
    return { kind: "done" };
  }
  // 未答问题优先于一切推进：用户没回答之前，任何一段都可能建立在错误前提上。
  if (state.hasOpenQuestion) {
    return { kind: "await_user" };
  }
  if (state.stage === "awaiting_user") {
    assertState(
      state.resumeStage !== undefined,
      "awaiting_user 必须记录回归阶段。",
    );
    return nextCycleAction({ ...state, stage: state.resumeStage, resumeStage: undefined });
  }

  const proposer = proposerOf(state);
  const critics = criticsOf(state);
  const round = state.currentRound;

  if (state.stage === "proposal") {
    if (!spokeIn(state, "proposal", round).has(proposer)) {
      return {
        kind: "invoke",
        agentId: proposer,
        stage: "proposal",
        messageKind: messageKindOf("proposal"),
        round,
      };
    }
    // 只有提案人时没有互审可言，直接由它自己收敛成结论；
    // 但审核圆桌仍要等清单归零，否则单人主审能一边报出阻断问题一边宣布通过。
    return critics.length === 0
      ? (state.reviewLedger
        ? reviewLedgerAction(state.reviewLedger)
        : { kind: "converge" })
      : nextCycleAction({ ...state, stage: "critique" });
  }

  if (state.stage === "critique") {
    const spoken = spokeIn(state, "critique", round);
    const pending = critics.find((critic) => !spoken.has(critic));
    if (pending !== undefined) {
      return {
        kind: "invoke",
        agentId: pending,
        stage: "critique",
        messageKind: messageKindOf("critique"),
        round,
      };
    }
    // 全体评审到齐后才判定。
    if (state.reviewLedger) {
      // 审核圆桌不走反驳：口头回应改不了 diff，只有真的修掉才算数。
      return reviewLedgerAction(state.reviewLedger);
    }
    // 辩论圆桌：只要还有 blocking，就必须让提案人正面回应。
    return hasBlockingCritique(state, round)
      ? nextCycleAction({ ...state, stage: "rebuttal" })
      : { kind: "converge" };
  }

  if (state.stage === "rebuttal") {
    if (!spokeIn(state, "rebuttal", round).has(proposer)) {
      return {
        kind: "invoke",
        agentId: proposer,
        stage: "rebuttal",
        messageKind: messageKindOf("rebuttal"),
        round,
      };
    }
    // 反驳完不能由提案人自己宣布分歧已解决——必须让评审再看一轮。
    // 预算用尽仍有 blocking 时放弃，而不是把没人认可的方案写成结论。
    if (round >= state.roundBudget) {
      return { kind: "abandon", reason: "round_budget_exhausted" };
    }
    return nextCycleAction({
      ...state,
      stage: "critique",
      currentRound: round + 1,
    });
  }

  if (!spokeIn(state, "synthesis", round).has(proposer)) {
    return {
      kind: "invoke",
      agentId: proposer,
      stage: "synthesis",
      messageKind: messageKindOf("synthesis"),
      round,
    };
  }
  return { kind: "done" };
}

/**
 * 把动作落回下一个持久化阶段。`invoke` 保持在动作声明的阶段，
 * `converge` 进入 synthesis，其余进入容器状态。
 */
export function stageAfterAction(action: CycleAction): CycleStage {
  switch (action.kind) {
    case "invoke":
      return action.stage;
    case "converge":
      return "synthesis";
    case "await_user":
    case "await_fix":
      return "awaiting_user";
    default:
      return "completed";
  }
}
