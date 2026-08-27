/**
 * @input  依赖：Council SQLite、收敛 codec、状态机与编排错误
 * @output 导出：可复用提案查询、cycle 开局/推进/收敛/放弃、阻塞提问与审核账本复审事务仓储
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
  type ReviewLedger,
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
import {
  parseAgentReply,
  parseCommitTargetsFromEvidence,
} from "./verdict.js";
import type { AgentFixTarget } from "./verdict.js";
import type {
  DiscussionCycleKind,
  FrozenCycleRequirements,
  RuntimeCapabilitySnapshot,
} from "./runtime-capabilities.js";

const CYCLE_COLUMNS = `
  id, topic_id, stage, status, participants_json,
  cycle_kind, requirements_json, capability_snapshot_json, turns_json,
  round_budget, current_round, resume_stage,
  context_cursor_message_id, context_cursor_created_at,
  proposed_decision_id, state_version, epoch, stop_reason,
  outcome_json,
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
  kind: DiscussionCycleKind;
  requirements: FrozenCycleRequirements;
  runtimeCapabilities: readonly RuntimeCapabilitySnapshot[];
  roundBudget: number;
  /** 复用提案人已经公开的 proposal/开场 brief；仓储会再次校验作者、类型与 commit。 */
  seedProposalMessageId?: string;
  /** 议题由本轮提案人创建时，直接把议题正文冻结为首轮提案，不再次召唤发起人。 */
  seedFromTopic?: boolean;
  contextCursor?: CycleCursor;
  now: string;
}

export interface ReusableProposalMessage {
  messageId: string;
  actorId: string;
  kind: "brief" | "proposal";
  createdAt: string;
  commitRef?: string;
  commitTargets?: readonly AgentFixTarget[];
}

export interface TopicProposalSeed {
  topicId: string;
  actorId: string;
  createdAt: string;
  commitTargets?: readonly AgentFixTarget[];
}

interface ReusableProposalRow {
  id: unknown;
  author_actor_id: unknown;
  kind: unknown;
  content: unknown;
  created_at: unknown;
  topic_created_by_actor_id: unknown;
}

interface TopicProposalSeedRow {
  id: unknown;
  question: unknown;
  created_by_actor_id: unknown;
  created_at: unknown;
  latest_creator_content: unknown;
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

export interface ResumeAfterFixesInput {
  cycleId: string;
  expectedVersion: number;
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
  outcome?: DiscussionCycle["outcome"];
  now: string;
}

export interface DiscussionCycleView {
  cycle: DiscussionCycle;
  openQuestion?: BlockingQuestion;
  /** 仅 fix_review：未关闭的阻断发现数，UI 与驱动器据此说明「还差几条」。 */
  reviewLedger?: ReviewLedger;
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

/**
 * 本轮审核还有几条未关闭的阻断发现。
 *
 * 只数叶子：审核批次是父条目，状态由子条目派生，把它也数进来清单永远归不了零。
 * 只数本 cycle 产出的发现：同议题上一轮遗留的问题不该悄悄拦住这一轮的收敛，
 * 那会让用户看到一个「没人提过异议却过不去」的圆桌。
 */
function readOpenBlockingFindings(
  database: DatabaseSync,
  cycleId: string,
): number {
  const row = database.prepare(`
    SELECT COUNT(*) AS value
    FROM work_items AS item
    WHERE item.source_cycle_id = ?
      AND item.origin = 'review_finding'
      AND item.severity = 'blocking'
      AND item.status <> 'completed'
      AND NOT EXISTS (
        SELECT 1 FROM work_items AS child WHERE child.parent_id = item.id
      )
  `).get(cycleId) as unknown as { value: unknown } | undefined;
  return typeof row?.value === "number" ? row.value : 0;
}

function view(database: DatabaseSync, cycleId: string): DiscussionCycleView {
  const cycle = readCycleRow(database, cycleId);
  const openQuestion = readOpenQuestion(database, cycle.id);
  // 只有修复互审带账本；辩论圆桌没有可修的清单，仍按立场收敛。
  const reviewLedger = cycle.kind === "fix_review"
    ? { openBlockingFindings: readOpenBlockingFindings(database, cycle.id) }
    : undefined;
  return {
    cycle,
    ...(openQuestion ? { openQuestion } : {}),
    ...(reviewLedger ? { reviewLedger } : {}),
    action: cycle.status === "active"
      ? nextCycleAction({
        ...toConvergenceState(cycle, openQuestion !== undefined),
        ...(reviewLedger ? { reviewLedger } : {}),
      })
      : { kind: "done" },
  };
}

function decodeReusableProposal(
  row: ReusableProposalRow,
  expectedActorId: string,
): ReusableProposalMessage {
  if (
    typeof row.id !== "string"
    || typeof row.author_actor_id !== "string"
    || typeof row.kind !== "string"
    || typeof row.content !== "string"
    || typeof row.created_at !== "string"
    || typeof row.topic_created_by_actor_id !== "string"
    || row.author_actor_id !== expectedActorId
    || (row.kind !== "proposal"
      && !(row.kind === "brief" && row.topic_created_by_actor_id === expectedActorId))
  ) {
    throw new InvalidRunStateError("Council 已有提案消息不满足作者或类型约束。");
  }
  const fix = parseAgentReply(row.content).fix;
  return {
    messageId: row.id,
    actorId: row.author_actor_id,
    kind: row.kind,
    createdAt: row.created_at,
    ...(fix
      ? {
          commitRef: fix.targets[0]!.commit,
          commitTargets: fix.targets,
        }
      : {}),
  };
}

/**
 * 找到 selected proposer 最近一次可复用的公开提案。
 *
 * `brief` 只有在该 Agent 同时是议题创建者时才算开场提案；普通补充说明不能靠
 * 作者相同就被提升为 proposal。最终写入 cycle 前还会按 messageId 重新校验。
 */
export function findReusableProposalMessage(
  database: DatabaseSync,
  topicId: string,
  proposerActorId: string,
): ReusableProposalMessage | undefined {
  const row = database.prepare(`
    SELECT messages.id, messages.author_actor_id, messages.kind,
           messages.content, messages.created_at,
           topics.created_by_actor_id AS topic_created_by_actor_id
    FROM messages
    INNER JOIN topics ON topics.id = messages.topic_id
    WHERE messages.topic_id = ?
      AND messages.author_actor_id = ?
      AND (
        messages.kind = 'proposal'
        OR (
          messages.kind = 'brief'
          AND topics.created_by_actor_id = messages.author_actor_id
        )
      )
    ORDER BY messages.created_at DESC, messages.rowid DESC
    LIMIT 1
  `).get(topicId, proposerActorId) as unknown as ReusableProposalRow | undefined;
  return row ? decodeReusableProposal(row, proposerActorId) : undefined;
}

/**
 * 议题正文由创建者公开，天然就是首轮提案。发起人后续最近一次 proposal/brief
 * 仅用于补充或覆盖 commit 证据，不改变提案归属。
 */
export function readTopicProposalSeed(
  database: DatabaseSync,
  topicId: string,
): TopicProposalSeed | undefined {
  const row = database.prepare(`
    SELECT topics.id, topics.question, topics.created_by_actor_id, topics.created_at,
      (
        SELECT messages.content
        FROM messages
        WHERE messages.topic_id = topics.id
          AND messages.author_actor_id = topics.created_by_actor_id
          AND messages.kind IN ('brief', 'proposal')
        ORDER BY messages.created_at DESC, messages.rowid DESC
        LIMIT 1
      ) AS latest_creator_content
    FROM topics
    WHERE topics.id = ?
  `).get(topicId) as unknown as TopicProposalSeedRow | undefined;
  if (!row) {
    return undefined;
  }
  if (
    typeof row.id !== "string"
    || typeof row.question !== "string"
    || typeof row.created_by_actor_id !== "string"
    || typeof row.created_at !== "string"
    || (row.latest_creator_content !== null
      && typeof row.latest_creator_content !== "string")
  ) {
    throw new InvalidRunStateError("Council 议题提案种子损坏。");
  }
  const commitTargets = parseCommitTargetsFromEvidence([
    row.question,
    ...(typeof row.latest_creator_content === "string"
      ? [row.latest_creator_content]
      : []),
  ]);
  return {
    topicId: row.id,
    actorId: row.created_by_actor_id,
    createdAt: row.created_at,
    ...(commitTargets.length > 0 ? { commitTargets } : {}),
  };
}

function readReusableProposalMessage(
  database: DatabaseSync,
  input: {
    topicId: string;
    proposerActorId: string;
    messageId: string;
  },
): ReusableProposalMessage {
  const row = database.prepare(`
    SELECT messages.id, messages.author_actor_id, messages.kind,
           messages.content, messages.created_at,
           topics.created_by_actor_id AS topic_created_by_actor_id
    FROM messages
    INNER JOIN topics ON topics.id = messages.topic_id
    WHERE messages.id = ? AND messages.topic_id = ?
  `).get(input.messageId, input.topicId) as unknown as ReusableProposalRow | undefined;
  if (!row) {
    throw new InvalidRunStateError("Council 要复用的已有提案不存在或不属于当前议题。");
  }
  return decodeReusableProposal(row, input.proposerActorId);
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
  const snapshotAdapterIds = input.runtimeCapabilities.map(
    (snapshot) => snapshot.adapterId,
  );
  const requirementAdapterIds = Object.keys(input.requirements.byParticipant);
  if (
    input.requirements.cycleKind !== input.kind
    || input.runtimeCapabilities.length !== input.participants.length
    || new Set(snapshotAdapterIds).size !== snapshotAdapterIds.length
    || input.participants.some((participant) => !snapshotAdapterIds.includes(participant))
    || requirementAdapterIds.length !== input.participants.length
    || input.participants.some(
      (participant) => !requirementAdapterIds.includes(participant),
    )
  ) {
    throw new InvalidRunStateError("Council 收敛能力与需求快照不完整。");
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
  const proposerAgentId = input.participants[0];
  const proposerActorId = input.runtimeCapabilities.find(
    (snapshot) => snapshot.adapterId === proposerAgentId,
  )?.actorId;
  if (!proposerAgentId || !proposerActorId) {
    throw new InvalidRunStateError("Council 收敛缺少提案人的冻结 Actor 身份。");
  }
  const seed = input.seedProposalMessageId
    ? readReusableProposalMessage(database, {
        topicId: input.topicId,
        proposerActorId,
        messageId: input.seedProposalMessageId,
      })
    : undefined;
  if (input.seedProposalMessageId && input.seedFromTopic) {
    throw new InvalidRunStateError("Council 首轮提案不能同时复用议题和消息。");
  }
  const topicSeed = input.seedFromTopic
    ? readTopicProposalSeed(database, input.topicId)
    : undefined;
  if (input.seedFromTopic && topicSeed?.actorId !== proposerActorId) {
    throw new InvalidRunStateError("Council 议题发起人与本轮提案人不一致。");
  }
  const seededCommitTargets = seed?.commitTargets ?? topicSeed?.commitTargets;
  if (
    input.kind === "fix_review"
    && (seed || topicSeed)
    && !seededCommitTargets?.length
  ) {
    throw new InvalidRunStateError(
      "议题与发起人说明中没有可验证的仓库/commit，不能开始 Commit 互审。",
    );
  }
  const hasSeed = Boolean(seed || topicSeed);
  const initialTurns: RecordedTurn[] = hasSeed
    ? [{
        agentId: proposerAgentId,
        stage: "proposal",
        round: 1,
        stance: "agree",
        messageId: seed?.messageId ?? topicSeed!.topicId,
        ...(seededCommitTargets?.[0]
          ? { commitRef: seededCommitTargets[0].commit }
          : {}),
        ...(seededCommitTargets ? { commitTargets: seededCommitTargets } : {}),
      }]
    : [];
  const id = `cycle_${randomUUID()}`;
  try {
    database.prepare(`
      INSERT INTO discussion_cycles (
        id, topic_id, stage, status, participants_json,
        cycle_kind, requirements_json, capability_snapshot_json, turns_json,
        round_budget, current_round, resume_stage,
        context_cursor_message_id, context_cursor_created_at,
        proposed_decision_id, state_version, epoch, stop_reason,
        created_at, updated_at, completed_at
      ) VALUES (
        ?, ?, ?, 'active', ?,
        ?, ?, ?, ?,
        ?, 1, NULL,
        ?, ?,
        NULL, 1, 0, NULL,
        ?, ?, NULL
      )
    `).run(
      id,
      input.topicId,
      hasSeed ? "critique" : "proposal",
      JSON.stringify(input.participants),
      input.kind,
      JSON.stringify(input.requirements),
      JSON.stringify(input.runtimeCapabilities),
      JSON.stringify(initialTurns),
      input.roundBudget,
      input.contextCursor?.messageId ?? seed?.messageId ?? null,
      input.contextCursor?.createdAt ?? seed?.createdAt ?? null,
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

export function readLatestDiscussionCycle(
  database: DatabaseSync,
  topicId: string,
): DiscussionCycleView | undefined {
  const row = database.prepare(`
    SELECT ${CYCLE_COLUMNS}
    FROM discussion_cycles
    WHERE topic_id = ?
    ORDER BY updated_at DESC, rowid DESC
    LIMIT 1
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
  // 审核圆桌必须带账本进状态机：不带的话它会退回辩论路径，
  // 把「有人判了 blocking」当成要提案人口头反驳——而口头反驳改不了 diff。
  const reviewLedger = current.kind === "fix_review"
    ? { openBlockingFindings: readOpenBlockingFindings(database, current.id) }
    : undefined;
  const action = nextCycleAction({
    ...toConvergenceState({ ...current, turns }, false),
    ...(reviewLedger ? { reviewLedger } : {}),
  });
  // 只有还要继续说话的动作才改阶段。`done` / `abandon` 是终止判定，
  // 必须原地保留阶段，让重新读取时算出同一个终止动作——而终态本身
  // 只能由 completeDiscussionCycle / abandonDiscussionCycle 带着结论或原因写入。
  //
  // 修复互审的 `converge` 同样不在这里落地：这条发言里的审核发现要等本次事务
  // 提交之后才录进账本，此刻读到的清单必然是旧的。就地推进到 synthesis，
  // 等于用「上一轮的问题数」宣布这一轮通过。收敛判定交给对完账的驱动器。
  const stage = action.kind === "invoke"
      || (action.kind === "converge" && current.kind !== "fix_review")
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

/**
 * 外部 Agent 提交了一批修复，开一轮复审。
 *
 * 轮次预算跟着抬高而不是拦住：预算约束的是「Agent 自己能吵几轮」，
 * 而每一次复审都由外部显式提交触发，不存在自动空转。真要停下来，
 * 用户放弃圆桌即可——把一个还在推进的修复循环判成"预算耗尽"没有任何意义。
 */
export function resumeDiscussionCycleAfterFixes(
  database: DatabaseSync,
  input: ResumeAfterFixesInput,
): DiscussionCycleView {
  const current = readCycleRow(database, input.cycleId);
  if (current.status !== "active") {
    throw new InvalidRunStateError("Council 圆桌已结束，不能再提交复审。");
  }
  if (current.kind !== "fix_review") {
    throw new InvalidRunStateError("只有修复互审圆桌可以提交修复并复审。");
  }
  casUpdate(
    database,
    `current_round = current_round + 1,
     round_budget = MAX(round_budget, current_round + 1),
     stage = COALESCE(resume_stage, stage), resume_stage = NULL,
     updated_at = ?`,
    [input.now],
    input.cycleId,
    input.expectedVersion,
  );
  return view(database, input.cycleId);
}

/**
 * 议题上最新一次自述的修复目标。
 *
 * 复审必须读新 diff：修复提交后并没有新的 Agent 发言携带 commit，
 * 只能回到公开消息里取最后一次 `council-fix` 自述。倒序扫描后即止，
 * 因此永远拿到的是最新一次提交，而不是开局那一份。
 */
export function readLatestFixTargets(
  database: DatabaseSync,
  topicId: string,
  limit = 50,
): readonly AgentFixTarget[] {
  const rows = database.prepare(`
    SELECT content FROM messages
    WHERE topic_id = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT ?
  `).all(topicId, limit) as unknown as { content: unknown }[];
  for (const row of rows) {
    if (typeof row.content !== "string") {
      continue;
    }
    const fix = parseAgentReply(row.content).fix;
    if (fix) {
      return fix.targets;
    }
  }
  return [];
}

/**
 * 账本归零，进入收敛陈述。
 *
 * 只有修复互审会走到这里：辩论圆桌的收敛在发言提交事务里就地完成，
 * 而审核发现要等提交之后才录进账本，收敛必须推迟到对完账再判。
 */
export function convergeDiscussionCycle(
  database: DatabaseSync,
  input: { cycleId: string; expectedVersion: number; now: string },
): DiscussionCycleView {
  const current = readCycleRow(database, input.cycleId);
  if (current.status !== "active") {
    throw new InvalidRunStateError("Council 圆桌已结束，不能再进入收敛。");
  }
  if (current.stage !== "synthesis") {
    casUpdate(
      database,
      `stage = 'synthesis', resume_stage = NULL, updated_at = ?`,
      [input.now],
      input.cycleId,
      input.expectedVersion,
    );
  }
  return view(database, input.cycleId);
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
     outcome_json = ?, epoch = epoch + 1, updated_at = ?, completed_at = ?`,
    [
      input.reason,
      input.outcome ? JSON.stringify(input.outcome) : null,
      input.now,
      input.now,
    ],
    input.cycleId,
    input.expectedVersion,
  );
  return readCycleRow(database, input.cycleId);
}
