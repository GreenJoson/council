/**
 * @input  依赖：discussion_cycles / blocking_questions 行与收敛协议枚举
 * @output 导出：严格行解码、DiscussionCycle / BlockingQuestion 类型与收敛状态投影
 * @pos    SQLite 行与收敛状态机之间的唯一解码边界；任何越界字段一律显式失败
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { InvalidRunStateError } from "../errors.js";
import {
  CYCLE_STAGES,
  CYCLE_STOP_REASONS,
  DEBATE_STAGES,
  type ConvergenceState,
  type CycleStage,
  type CycleStopReason,
  type CycleTurn,
  type DebateStage,
} from "./convergence.js";
import { VERDICT_STANCES, type VerdictStance } from "./verdict.js";

export const BLOCKING_QUESTION_STATUSES = [
  "open",
  "answered",
  "withdrawn",
] as const;

export const CYCLE_STATUSES = ["active", "completed", "abandoned"] as const;

export type BlockingQuestionStatus = (typeof BLOCKING_QUESTION_STATUSES)[number];
export type CycleStatus = (typeof CYCLE_STATUSES)[number];

/** 已完成发言，附带公开消息 id，使状态可以回溯到公开记录。 */
export interface RecordedTurn extends CycleTurn {
  messageId: string;
}

export interface CycleCursor {
  messageId: string;
  createdAt: string;
}

export interface DiscussionCycle {
  id: string;
  topicId: string;
  stage: CycleStage;
  status: CycleStatus;
  participants: readonly string[];
  turns: readonly RecordedTurn[];
  roundBudget: number;
  currentRound: number;
  resumeStage?: DebateStage;
  contextCursor?: CycleCursor;
  proposedDecisionId?: string;
  stateVersion: number;
  epoch: number;
  stopReason?: CycleStopReason;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface BlockingQuestion {
  id: string;
  cycleId: string;
  askedByActorId: string;
  askedAtStage: DebateStage;
  question: string;
  rationale: string;
  options: readonly string[];
  status: BlockingQuestionStatus;
  questionMessageId: string;
  answerMessageId?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface DiscussionCycleRow {
  id: unknown;
  topic_id: unknown;
  stage: unknown;
  status: unknown;
  participants_json: unknown;
  turns_json: unknown;
  round_budget: unknown;
  current_round: unknown;
  resume_stage: unknown;
  context_cursor_message_id: unknown;
  context_cursor_created_at: unknown;
  proposed_decision_id: unknown;
  state_version: unknown;
  epoch: unknown;
  stop_reason: unknown;
  created_at: unknown;
  updated_at: unknown;
  completed_at: unknown;
}

export interface BlockingQuestionRow {
  id: unknown;
  cycle_id: unknown;
  asked_by_actor_id: unknown;
  asked_at_stage: unknown;
  question: unknown;
  rationale: unknown;
  options_json: unknown;
  status: unknown;
  question_message_id: unknown;
  answer_message_id: unknown;
  created_at: unknown;
  updated_at: unknown;
  resolved_at: unknown;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new InvalidRunStateError(`Council 收敛 ${label} 无效。`);
  }
  return value;
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return text(value, label);
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new InvalidRunStateError(`Council 收敛 ${label} 无效。`);
  }
  return value;
}

function member<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new InvalidRunStateError(`Council 收敛 ${label} 无效。`);
  }
  return found;
}

function jsonArray(value: unknown, label: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text(value, label)) as unknown;
  } catch {
    throw new InvalidRunStateError(`Council 收敛 ${label} 不是有效 JSON。`);
  }
  if (!Array.isArray(parsed)) {
    throw new InvalidRunStateError(`Council 收敛 ${label} 必须是数组。`);
  }
  return parsed;
}

function stringArray(value: unknown, label: string): string[] {
  return jsonArray(value, label).map((item) => text(item, label));
}

function decodeTurn(value: unknown, label: string): RecordedTurn {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidRunStateError(`Council 收敛 ${label} 必须是对象。`);
  }
  const record = value as Record<string, unknown>;
  return {
    agentId: text(record.agentId, `${label}.agentId`),
    stage: member(record.stage, DEBATE_STAGES, `${label}.stage`) as DebateStage,
    round: positiveInteger(record.round, `${label}.round`),
    stance: member(
      record.stance,
      VERDICT_STANCES,
      `${label}.stance`,
    ) as VerdictStance,
    messageId: text(record.messageId, `${label}.messageId`),
  };
}

export function decodeDiscussionCycle(row: DiscussionCycleRow): DiscussionCycle {
  const stage = member(row.stage, CYCLE_STAGES, "stage");
  const resumeStage = row.resume_stage === null || row.resume_stage === undefined
    ? undefined
    : member(row.resume_stage, DEBATE_STAGES, "resume_stage");
  if ((stage === "awaiting_user") !== (resumeStage !== undefined)) {
    throw new InvalidRunStateError("Council 收敛挂起阶段与回归阶段不一致。");
  }
  const cursorMessageId = optionalText(
    row.context_cursor_message_id,
    "context_cursor_message_id",
  );
  const cursorCreatedAt = optionalText(
    row.context_cursor_created_at,
    "context_cursor_created_at",
  );
  if ((cursorMessageId === undefined) !== (cursorCreatedAt === undefined)) {
    throw new InvalidRunStateError("Council 收敛冻结游标不完整。");
  }
  const participants = stringArray(row.participants_json, "participants_json");
  if (participants.length === 0) {
    throw new InvalidRunStateError("Council 收敛名册不能为空。");
  }
  if (new Set(participants).size !== participants.length) {
    throw new InvalidRunStateError("Council 收敛名册不允许重复 Agent。");
  }
  const roundBudget = positiveInteger(row.round_budget, "round_budget");
  const currentRound = positiveInteger(row.current_round, "current_round");
  if (roundBudget < 1 || currentRound < 1 || currentRound > roundBudget) {
    throw new InvalidRunStateError("Council 收敛轮次超出预算。");
  }
  const turns = jsonArray(row.turns_json, "turns_json").map((item, index) =>
    decodeTurn(item, `turns_json[${String(index)}]`));
  // 发言必须来自冻结名册：名册被改过而 turns 留下了旧成员时，
  // "所有评审都发言了"会算错，宁可在读取时就失败。
  for (const turn of turns) {
    if (!participants.includes(turn.agentId)) {
      throw new InvalidRunStateError("Council 收敛发言不在冻结名册内。");
    }
    if (turn.round > currentRound) {
      throw new InvalidRunStateError("Council 收敛发言轮次超出当前轮次。");
    }
  }
  return {
    id: text(row.id, "id"),
    topicId: text(row.topic_id, "topic_id"),
    stage,
    status: member(row.status, CYCLE_STATUSES, "status"),
    participants,
    turns,
    roundBudget,
    currentRound,
    ...(resumeStage ? { resumeStage } : {}),
    ...(cursorMessageId !== undefined && cursorCreatedAt !== undefined
      ? { contextCursor: { messageId: cursorMessageId, createdAt: cursorCreatedAt } }
      : {}),
    ...(optionalText(row.proposed_decision_id, "proposed_decision_id") !== undefined
      ? { proposedDecisionId: text(row.proposed_decision_id, "proposed_decision_id") }
      : {}),
    stateVersion: positiveInteger(row.state_version, "state_version"),
    epoch: positiveInteger(row.epoch, "epoch"),
    ...(row.stop_reason === null || row.stop_reason === undefined
      ? {}
      : { stopReason: member(row.stop_reason, CYCLE_STOP_REASONS, "stop_reason") }),
    createdAt: text(row.created_at, "created_at"),
    updatedAt: text(row.updated_at, "updated_at"),
    ...(optionalText(row.completed_at, "completed_at") !== undefined
      ? { completedAt: text(row.completed_at, "completed_at") }
      : {}),
  };
}

export function decodeBlockingQuestion(row: BlockingQuestionRow): BlockingQuestion {
  const status = member(row.status, BLOCKING_QUESTION_STATUSES, "question.status");
  const answerMessageId = optionalText(row.answer_message_id, "answer_message_id");
  if ((status === "answered") !== (answerMessageId !== undefined)) {
    throw new InvalidRunStateError("Council 阻塞提问回答状态与回答消息不一致。");
  }
  return {
    id: text(row.id, "question.id"),
    cycleId: text(row.cycle_id, "question.cycle_id"),
    askedByActorId: text(row.asked_by_actor_id, "question.asked_by_actor_id"),
    askedAtStage: member(row.asked_at_stage, DEBATE_STAGES, "question.asked_at_stage"),
    question: text(row.question, "question.question"),
    rationale: text(row.rationale, "question.rationale"),
    options: stringArray(row.options_json, "question.options_json"),
    status,
    questionMessageId: text(row.question_message_id, "question.question_message_id"),
    ...(answerMessageId !== undefined ? { answerMessageId } : {}),
    createdAt: text(row.created_at, "question.created_at"),
    updatedAt: text(row.updated_at, "question.updated_at"),
    ...(optionalText(row.resolved_at, "question.resolved_at") !== undefined
      ? { resolvedAt: text(row.resolved_at, "question.resolved_at") }
      : {}),
  };
}

/** 把持久化的 cycle 投影成状态机输入；两者的字段刻意保持一一对应。 */
export function toConvergenceState(
  cycle: DiscussionCycle,
  hasOpenQuestion: boolean,
): ConvergenceState {
  return {
    stage: cycle.stage,
    ...(cycle.resumeStage ? { resumeStage: cycle.resumeStage } : {}),
    currentRound: cycle.currentRound,
    roundBudget: cycle.roundBudget,
    participants: cycle.participants,
    turns: cycle.turns,
    hasOpenQuestion,
  };
}
