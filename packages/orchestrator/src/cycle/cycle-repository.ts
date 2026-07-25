/**
 * @input  依赖：Council SQLite、收敛 codec、状态机与编排错误
 * @output 导出：cycle 开局/推进/收敛/放弃与阻塞提问开单/回答的事务仓储
 * @pos    收敛协议的持久化边界；所有写入走 state_version CAS，重放一律幂等
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { InvalidRunStateError, StoreConflictError } from "../errors.js";
import {
  nextCycleAction,
  stageAfterAction,
  type CycleAction,
  type CycleStopReason,
  type DebateStage,
} from "./convergence.js";
import {
  decodeBlockingQuestion,
  decodeDiscussionCycle,
  toConvergenceState,
  type BlockingQuestion,
  type BlockingQuestionRow,
  type CycleCursor,
  type DiscussionCycle,
  type DiscussionCycleRow,
  type RecordedTurn,
} from "./cycle-codec.js";
import type { AgentQuestion } from "./verdict.js";

const CYCLE_COLUMNS = `
  id, topic_id, stage, status, participants_json, turns_json,
  round_budget, current_round, resume_stage,
  context_cursor_message_id, context_cursor_created_at,
  proposed_decision_id, state_version, epoch, stop_reason,
  created_at, updated_at, completed_at
`;

const QUESTION_COLUMNS = `
  id, cycle_id, asked_by_actor_id, asked_at_stage, question, rationale,
  options_json, status, question_message_id, answer_message_id,
  created_at, updated_at, resolved_at
`;

export interface StartDiscussionCycleInput {
  topicId: string;
  participants: readonly string[];
  roundBudget: number;
  contextCursor?: CycleCursor;
  now: string;
}

export interface RecordCycleTurnInput {
  cycleId: string;
  expectedVersion: number;
  turn: RecordedTurn;
  /** 阶段推进时重新冻结上下文游标，使同一阶段内所有 Agent 读到相同前缀。 */
  contextCursor?: CycleCursor;
  now: string;
}

export interface OpenBlockingQuestionInput {
  cycleId: string;
  expectedVersion: number;
  askedByActorId: string;
  askedAtStage: DebateStage;
  /**
   * 用户回答后要回到的阶段。默认与提问阶段相同；发言与提问在同一条消息里到达时，
   * 发言可能已经把 cycle 推到了下一阶段，此时必须回到推进后的阶段而不是提问时的阶段。
   */
  resumeStage?: DebateStage;
  question: AgentQuestion;
  questionMessageId: string;
  now: string;
}

export interface AnswerBlockingQuestionInput {
  questionMessageId: string;
  answerMessageId: string;
  now: string;
}

export interface CompleteDiscussionCycleInput {
  cycleId: string;
  expectedVersion: number;
  proposedDecisionId: string;
  now: string;
}

export interface AbandonDiscussionCycleInput {
  cycleId: string;
  expectedVersion: number;
  reason: CycleStopReason;
  now: string;
}

export interface DiscussionCycleView {
  cycle: DiscussionCycle;
  openQuestion?: BlockingQuestion;
  /** 依据当前持久化状态算出的下一步；调用方据此决定召唤谁。 */
  action: CycleAction;
}

function readCycleRow(
  database: DatabaseSync,
  cycleId: string,
): DiscussionCycle {
  const row = database.prepare(`
    SELECT ${CYCLE_COLUMNS} FROM discussion_cycles WHERE id = ?
  `).get(cycleId) as unknown as DiscussionCycleRow | undefined;
  if (!row) {
    throw new InvalidRunStateError("Council 收敛 cycle 不存在。");
  }
  return decodeDiscussionCycle(row);
}

function readOpenQuestion(
  database: DatabaseSync,
  cycleId: string,
): BlockingQuestion | undefined {
  const row = database.prepare(`
    SELECT ${QUESTION_COLUMNS}
    FROM blocking_questions
    WHERE cycle_id = ? AND status = 'open'
  `).get(cycleId) as unknown as BlockingQuestionRow | undefined;
  return row ? decodeBlockingQuestion(row) : undefined;
}

function view(database: DatabaseSync, cycleId: string): DiscussionCycleView {
  const cycle = readCycleRow(database, cycleId);
  const openQuestion = readOpenQuestion(database, cycle.id);
  return {
    cycle,
    ...(openQuestion ? { openQuestion } : {}),
    action: nextCycleAction(toConvergenceState(cycle, openQuestion !== undefined)),
  };
}

/**
 * CAS 更新一行 cycle。返回 0 行说明版本已被其他执行者推进，
 * 调用方必须重新读取而不是重试同一份预期状态。
 */
function casUpdate(
  database: DatabaseSync,
  assignments: string,
  parameters: readonly unknown[],
  cycleId: string,
  expectedVersion: number,
): void {
  const result = database.prepare(`
    UPDATE discussion_cycles
    SET ${assignments}, state_version = state_version + 1
    WHERE id = ? AND state_version = ? AND status = 'active'
  `).run(...(parameters as never[]), cycleId, expectedVersion);
  if (result.changes !== 1) {
    throw new StoreConflictError("Council 收敛状态已被其他执行者推进。");
  }
}

export function startDiscussionCycle(
  database: DatabaseSync,
  input: StartDiscussionCycleInput,
): DiscussionCycleView {
  if (input.participants.length === 0) {
    throw new InvalidRunStateError("Council 收敛名册至少需要一个 Agent。");
  }
  if (new Set(input.participants).size !== input.participants.length) {
    throw new InvalidRunStateError("Council 收敛名册不允许重复 Agent。");
  }
  if (!Number.isSafeInteger(input.roundBudget) || input.roundBudget < 1) {
    throw new InvalidRunStateError("Council 收敛轮次预算必须为正整数。");
  }
  const topic = database.prepare(`
    SELECT status FROM topics WHERE id = ?
  `).get(input.topicId) as unknown as { status?: unknown } | undefined;
  if (!topic) {
    throw new InvalidRunStateError("Council 收敛议题不存在。");
  }
  // 已决议题不该再开新一轮讨论；这与 accepted 决策终结 cycle 的触发器同向。
  if (topic.status !== "open") {
    throw new InvalidRunStateError("Council 收敛只能在开放议题上开局。");
  }
  const id = `cycle_${randomUUID()}`;
  try {
    database.prepare(`
      INSERT INTO discussion_cycles (
        id, topic_id, stage, status, participants_json, turns_json,
        round_budget, current_round, resume_stage,
        context_cursor_message_id, context_cursor_created_at,
        proposed_decision_id, state_version, epoch, stop_reason,
        created_at, updated_at, completed_at
      ) VALUES (
        ?, ?, 'proposal', 'active', ?, '[]',
        ?, 1, NULL,
        ?, ?,
        NULL, 1, 0, NULL,
        ?, ?, NULL
      )
    `).run(
      id,
      input.topicId,
      JSON.stringify(input.participants),
      input.roundBudget,
      input.contextCursor?.messageId ?? null,
      input.contextCursor?.createdAt ?? null,
      input.now,
      input.now,
    );
  } catch (error) {
    if (error instanceof Error && /UNIQUE/iu.test(error.message)) {
      throw new StoreConflictError("Council 该议题已有进行中的讨论。");
    }
    throw error;
  }
  return view(database, id);
}

export function readActiveDiscussionCycle(
  database: DatabaseSync,
  topicId: string,
): DiscussionCycleView | undefined {
  const row = database.prepare(`
    SELECT ${CYCLE_COLUMNS}
    FROM discussion_cycles
    WHERE topic_id = ? AND status = 'active'
  `).get(topicId) as unknown as DiscussionCycleRow | undefined;
  return row ? view(database, decodeDiscussionCycle(row).id) : undefined;
}

/**
 * 该议题上是否还有没跑完的编排 Run。
 *
 * 驱动器据此决定要不要召唤下一位：Run 停在审批门时并没有提交发言，
 * 状态机看到的仍是"轮到同一个人"，不挡一下就会给同一阶段再开一个 Run。
 * 判定口径与 `idx_orchestration_runs_one_active_topic` 的部分索引保持一致。
 */
export function hasActiveOrchestrationRun(
  database: DatabaseSync,
  topicId: string,
): boolean {
  const row = database.prepare(`
    SELECT 1 AS present
    FROM orchestration_runs
    WHERE topic_id = ?
      AND status IN ('idle', 'running', 'waiting_agent', 'waiting_user')
    LIMIT 1
  `).get(topicId) as unknown as { present: number } | undefined;
  return row !== undefined;
}

/**
 * 记录一次发言并把 cycle 推到状态机指定的下一个阶段。
 * 重放同一条消息是幂等的：turns 已包含该 messageId 时直接返回当前视图。
 */
export function recordCycleTurn(
  database: DatabaseSync,
  input: RecordCycleTurnInput,
): DiscussionCycleView {
  const current = readCycleRow(database, input.cycleId);
  if (current.turns.some((turn) => turn.messageId === input.turn.messageId)) {
    return view(database, input.cycleId);
  }
  if (current.status !== "active") {
    throw new InvalidRunStateError("Council 收敛已结束，不能再记录发言。");
  }
  const turns = [...current.turns, input.turn];
  const action = nextCycleAction(
    toConvergenceState({ ...current, turns }, false),
  );
  // 只有还要继续说话的动作才改阶段。`done` / `abandon` 是终止判定，
  // 必须原地保留阶段，让重新读取时算出同一个终止动作——而终态本身
  // 只能由 completeDiscussionCycle / abandonDiscussionCycle 带着结论或原因写入。
  const stage = action.kind === "invoke" || action.kind === "converge"
    ? stageAfterAction(action)
    : current.stage;
  const round = action.kind === "invoke" ? action.round : current.currentRound;
  // 冻结游标只在阶段切换时重钉。同一阶段内重钉会让后发言的评审读到前一位的评审意见，
  // 独立复审就退化成接龙——评审必须各自面对同一份材料。
  const cursor = stage !== current.stage
    ? input.contextCursor ?? current.contextCursor
    : current.contextCursor;
  casUpdate(
    database,
    `turns_json = ?, stage = ?, resume_stage = NULL, current_round = ?,
     context_cursor_message_id = ?, context_cursor_created_at = ?,
     updated_at = ?`,
    [
      JSON.stringify(turns),
      // `converge` / `done` 会把 stage 推到 synthesis / completed，
      // 但 completed 必须走 completeDiscussionCycle 才能带上 proposed 决策。
      stage === "completed" ? "synthesis" : stage,
      round,
      cursor?.messageId ?? null,
      cursor?.createdAt ?? null,
      input.now,
    ],
    input.cycleId,
    input.expectedVersion,
  );
  return view(database, input.cycleId);
}

/**
 * 开单并把 cycle 挂起。以提问消息 id 为幂等键：取消或重启后重放同一条提问，
 * 拿回的是同一张单子，而不是把用户再问一遍。
 */
export function openBlockingQuestion(
  database: DatabaseSync,
  input: OpenBlockingQuestionInput,
): DiscussionCycleView {
  const existing = database.prepare(`
    SELECT ${QUESTION_COLUMNS}
    FROM blocking_questions
    WHERE question_message_id = ?
  `).get(input.questionMessageId) as unknown as BlockingQuestionRow | undefined;
  if (existing) {
    const decoded = decodeBlockingQuestion(existing);
    if (decoded.cycleId !== input.cycleId) {
      throw new InvalidRunStateError("Council 阻塞提问消息已属于其他讨论。");
    }
    return view(database, input.cycleId);
  }
  const current = readCycleRow(database, input.cycleId);
  if (current.status !== "active") {
    throw new InvalidRunStateError("Council 收敛已结束，不能再提问。");
  }
  database.prepare(`
    INSERT INTO blocking_questions (
      id, cycle_id, asked_by_actor_id, asked_at_stage, question, rationale,
      options_json, status, question_message_id, answer_message_id,
      created_at, updated_at, resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL, ?, ?, NULL)
  `).run(
    `question_${randomUUID()}`,
    input.cycleId,
    input.askedByActorId,
    input.askedAtStage,
    input.question.question,
    input.question.rationale,
    JSON.stringify(input.question.options),
    input.questionMessageId,
    input.now,
    input.now,
  );
  casUpdate(
    database,
    `stage = 'awaiting_user', resume_stage = ?, updated_at = ?`,
    [input.resumeStage ?? input.askedAtStage, input.now],
    input.cycleId,
    input.expectedVersion,
  );
  return view(database, input.cycleId);
}

/** 回答必须是一条公开消息；答完立刻回到冻结的回归阶段。 */
export function answerBlockingQuestion(
  database: DatabaseSync,
  input: AnswerBlockingQuestionInput,
): DiscussionCycleView {
  const row = database.prepare(`
    SELECT ${QUESTION_COLUMNS}
    FROM blocking_questions
    WHERE question_message_id = ?
  `).get(input.questionMessageId) as unknown as BlockingQuestionRow | undefined;
  if (!row) {
    throw new InvalidRunStateError("Council 阻塞提问不存在。");
  }
  const question = decodeBlockingQuestion(row);
  if (question.status !== "open") {
    // 重放已回答的提问不报错：恢复路径必须能重复执行。
    return view(database, question.cycleId);
  }
  const cycle = readCycleRow(database, question.cycleId);
  if (cycle.resumeStage === undefined) {
    throw new InvalidRunStateError("Council 收敛挂起状态缺少回归阶段。");
  }
  database.prepare(`
    UPDATE blocking_questions
    SET status = 'answered', answer_message_id = ?, resolved_at = ?, updated_at = ?
    WHERE id = ? AND status = 'open'
  `).run(input.answerMessageId, input.now, input.now, question.id);
  casUpdate(
    database,
    `stage = ?, resume_stage = NULL, updated_at = ?`,
    [cycle.resumeStage, input.now],
    cycle.id,
    cycle.stateVersion,
  );
  return view(database, cycle.id);
}

export function completeDiscussionCycle(
  database: DatabaseSync,
  input: CompleteDiscussionCycleInput,
): DiscussionCycle {
  casUpdate(
    database,
    `status = 'completed', stage = 'completed', resume_stage = NULL,
     proposed_decision_id = ?, stop_reason = 'converged',
     updated_at = ?, completed_at = ?`,
    [input.proposedDecisionId, input.now, input.now],
    input.cycleId,
    input.expectedVersion,
  );
  return readCycleRow(database, input.cycleId);
}

export function abandonDiscussionCycle(
  database: DatabaseSync,
  input: AbandonDiscussionCycleInput,
): DiscussionCycle {
  database.prepare(`
    UPDATE blocking_questions
    SET status = 'withdrawn', resolved_at = ?, updated_at = ?
    WHERE cycle_id = ? AND status = 'open'
  `).run(input.now, input.now, input.cycleId);
  casUpdate(
    database,
    `status = 'abandoned', resume_stage = NULL, stop_reason = ?,
     epoch = epoch + 1, updated_at = ?, completed_at = ?`,
    [input.reason, input.now, input.now],
    input.cycleId,
    input.expectedVersion,
  );
  return readCycleRow(database, input.cycleId);
}
