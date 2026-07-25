/**
 * @input  依赖：Council SQLite 上的 discussion_cycles、blocking_questions、decisions 与 messages
 * @output 导出：圆桌运行度量——轮次、墙钟耗时、提问次数与决策一致性核对
 * @pos    只读报表；不新建任何存储，全部从既有落库状态推算，因此永远不会与真相分叉
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { DatabaseSync } from "node:sqlite";
import { stripProtocolTrailers } from "council-orchestrator";

export interface CycleCountMetrics {
  /** 开过的圆桌总数（含仍在进行的）。 */
  total: number;
  /** 收敛并产出 proposed 决策的。 */
  converged: number;
  /** 预算耗尽或被取消而放弃的。 */
  abandoned: number;
  active: number;
  /** 此刻停在等用户回答的。 */
  awaitingUser: number;
}

export interface DistributionMetrics {
  count: number;
  mean: number;
  median: number;
  max: number;
}

export interface DecisionConsistencyMetrics {
  /** 有 proposed 决策、可以核对的圆桌数。 */
  checked: number;
  /** 决策正文与最终 synthesis 不一致的圆桌 id；非空即为一次真实的数据背离。 */
  divergedCycleIds: string[];
}

export interface CycleMetrics {
  cycles: CycleCountMetrics;
  /** 已结束圆桌走过的轮数分布。 */
  rounds: DistributionMetrics;
  /** 从开局到结束的墙钟耗时分布（毫秒）。 */
  wallClockMs: DistributionMetrics;
  questions: {
    total: number;
    open: number;
    /** 平均每个圆桌打断用户几次；这个数越大说明议题给的约束越不够。 */
    perCycle: number;
  };
  decisionConsistency: DecisionConsistencyMetrics;
}

interface CycleRow {
  id: string;
  status: string;
  stage: string;
  turns_json: string;
  current_round: number;
  proposed_decision_id: string | null;
  created_at: string;
  completed_at: string | null;
}

interface CountRow {
  count: number;
}

function distribution(values: readonly number[]): DistributionMetrics {
  if (values.length === 0) {
    return { count: 0, mean: 0, median: 0, max: 0 };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0;
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    mean: Math.round(total / sorted.length),
    median: Math.round(median),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

/** 从 turns_json 里取最后一次 synthesis 的消息 id；解析不了就当没有，不猜。 */
function lastSynthesisMessageId(turnsJson: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(turnsJson) as unknown;
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  for (let index = parsed.length - 1; index >= 0; index -= 1) {
    const turn = parsed[index] as Record<string, unknown> | undefined;
    if (turn?.stage === "synthesis" && typeof turn.messageId === "string") {
      return turn.messageId;
    }
  }
  return undefined;
}

/**
 * 核对「决策正文 == 最终 synthesis 正文」这条不变量是否还成立。
 *
 * 这不是重复写入时的校验——写入那一刻当然一致。它要抓的是事后被改写：
 * 决策一旦和讨论对不上，"照着决策执行"就失去了依据。
 */
function checkConsistency(
  database: DatabaseSync,
  rows: readonly CycleRow[],
): DecisionConsistencyMetrics {
  const readDecision = database.prepare("SELECT decision FROM decisions WHERE id = ?");
  const readMessage = database.prepare("SELECT content FROM messages WHERE id = ?");
  const diverged: string[] = [];
  let checked = 0;
  for (const row of rows) {
    if (!row.proposed_decision_id) {
      continue;
    }
    const messageId = lastSynthesisMessageId(row.turns_json);
    if (!messageId) {
      diverged.push(row.id);
      continue;
    }
    const decision = readDecision.get(row.proposed_decision_id) as
      | { decision: string }
      | undefined;
    const message = readMessage.get(messageId) as { content: string } | undefined;
    if (!decision || !message) {
      diverged.push(row.id);
      continue;
    }
    checked += 1;
    if (decision.decision !== stripProtocolTrailers(message.content)) {
      diverged.push(row.id);
    }
  }
  return { checked, divergedCycleIds: diverged };
}

function elapsedMs(from: string, to: string): number | undefined {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return undefined;
  }
  return end - start;
}

export function computeCycleMetrics(database: DatabaseSync): CycleMetrics {
  const rows = database.prepare(`
    SELECT id, status, stage, turns_json, current_round,
           proposed_decision_id, created_at, completed_at
    FROM discussion_cycles
  `).all() as unknown as CycleRow[];

  const counts: CycleCountMetrics = {
    total: rows.length,
    converged: 0,
    abandoned: 0,
    active: 0,
    awaitingUser: 0,
  };
  const rounds: number[] = [];
  const durations: number[] = [];
  for (const row of rows) {
    if (row.status === "completed") {
      counts.converged += 1;
    } else if (row.status === "abandoned") {
      counts.abandoned += 1;
    } else {
      counts.active += 1;
      if (row.stage === "awaiting_user") {
        counts.awaitingUser += 1;
      }
    }
    if (row.status === "active") {
      continue;
    }
    rounds.push(row.current_round);
    const duration = row.completed_at
      ? elapsedMs(row.created_at, row.completed_at)
      : undefined;
    if (duration !== undefined) {
      durations.push(duration);
    }
  }

  const questionTotal = (database
    .prepare("SELECT COUNT(*) AS count FROM blocking_questions")
    .get() as unknown as CountRow).count;
  const questionOpen = (database
    .prepare("SELECT COUNT(*) AS count FROM blocking_questions WHERE status = 'open'")
    .get() as unknown as CountRow).count;

  return {
    cycles: counts,
    rounds: distribution(rounds),
    wallClockMs: distribution(durations),
    questions: {
      total: questionTotal,
      open: questionOpen,
      perCycle: rows.length === 0
        ? 0
        : Math.round((questionTotal / rows.length) * 100) / 100,
    },
    decisionConsistency: checkConsistency(database, rows),
  };
}
