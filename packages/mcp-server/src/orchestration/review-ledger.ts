/**
 * @input  依赖：CouncilDatabase 实施项读写、圆桌发言记录与结构化尾块解析
 * @output 导出：把审核发现落成任务树、把复审判定回写状态的账本同步器
 * @pos    「审核意见」与「可认领任务」之间唯一的搬运处；重复执行不产生新写入
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  parseAgentReply,
  type OpenFindingBrief,
  type RecordedTurn,
} from "council-orchestrator";
import type { CouncilDatabase } from "../database.js";
import { CouncilConflictError, CouncilValidationError } from "../errors.js";
import { logger } from "../logger.js";
import type { WorkItem } from "../types.js";

/** 与 work_items.title 上限一致；兜底条目由 verdict summary 生成，必须先截断再入库。 */
const MAX_TITLE_CHARS = 200;

export interface SyncCycleLedgerInput {
  topicId: string;
  cycleId: string;
  turns: readonly RecordedTurn[];
}

export interface ReviewLedgerWriter {
  /** 幂等同步：录入尚未落账的发现，并把复审判定写回条目状态。 */
  syncCycleLedger(input: SyncCycleLedgerInput): void;
  /** 复审时摆在评审面前的未关闭清单。 */
  readOpenFindings(topicId: string, cycleId: string): readonly OpenFindingBrief[];
}

function truncateTitle(text: string): string {
  return text.length <= MAX_TITLE_CHARS
    ? text
    : `${text.slice(0, MAX_TITLE_CHARS - 1)}…`;
}

/**
 * 每条发言一个批次父级。
 *
 * 按「轮次 + 发言人」而不是按轮次合并：两位评审各自报出同名问题时，
 * 合并会撞上 `(topic_id, parent_key, title)` 唯一索引，而分开挂既不冲突，
 * 又能在账本上看清哪条是谁提的。这个父级同时是幂等标记——它存在就说明
 * 这条发言已经录过账，不必再录一次。
 */
function batchTitleOf(turn: RecordedTurn): string {
  return `审核发现 · R${String(turn.round)} · ${turn.agentId}`;
}

function isLeaf(items: readonly WorkItem[], workItemId: string): boolean {
  return !items.some((item) => item.parentId === workItemId);
}

export function createReviewLedgerWriter(
  database: CouncilDatabase,
): ReviewLedgerWriter {
  function ingestTurn(
    input: SyncCycleLedgerInput,
    turn: RecordedTurn,
    existing: readonly WorkItem[],
  ): boolean {
    if (existing.some((item) => item.sourceMessageId === turn.messageId)) {
      return false;
    }
    const message = database.getMessage(turn.messageId);
    const reply = parseAgentReply(message.content);
    const findings = reply.findings ?? [];
    const items = findings.map((finding) => ({
      title: truncateTitle(finding.title),
      details: [
        finding.location ? `位置：${finding.location}` : undefined,
        `证据：${finding.evidence}`,
        finding.suggestion ? `建议：${finding.suggestion}` : undefined,
      ].filter((line): line is string => line !== undefined).join("\n\n"),
      severity: finding.severity,
      sourceMessageId: turn.messageId,
    }));
    // 复审里的 blocking 已经被 still_broken 判定解释过了，不必再补一条兜底；
    // 否则每复审一轮都会凭空多出一条重复的「还差一条」，清单永远关不完。
    const explainedByReReview = (reply.reviewResults ?? []).some(
      (result) => result.verdict === "still_broken",
    );
    // 失败关闭：尾块写坏了、或者判了 blocking 却既没列出可修条目、
    // 也没有任何一条判定说明为什么拦着，都补一条阻断条目。
    // 否则一次格式错误就能让审核悄悄「通过」。
    // 反过来 council-review-result 解析失败不必补条目：解析不了就没有条目被关闭，
    // 未关闭清单原样留着，本身已经是失败关闭。
    if (
      items.length === 0
      && (reply.findingsMalformed
        || (turn.stance === "blocking"
          && reply.findings === undefined
          && !explainedByReReview))
    ) {
      items.push({
        title: truncateTitle(
          reply.findingsMalformed
            ? `审核发现尾块格式非法，需人工确认（${turn.agentId} R${String(turn.round)}）`
            : reply.verdict.summary,
        ),
        details: reply.findingsMalformed
          ? `${turn.agentId} 在第 ${String(turn.round)} 轮给出的 council-findings 尾块无法解析，`
            + "系统无法确定它到底审出了什么，按阻断处理。请人工阅读原始发言后拆条或关闭。"
          : `评审立场：${reply.verdict.summary}`,
        severity: "blocking" as const,
        sourceMessageId: turn.messageId,
      });
    }
    if (items.length === 0) {
      // 审过、没问题：不建空批次。空父级会变成一条永远关不掉的叶子任务，
      // 把「12 / 15」拖成一个没人能补完的分母。
      return false;
    }
    const [batch] = database.createWorkItemsAsActor({
      topicId: input.topicId,
      origin: "review_finding",
      sourceCycleId: input.cycleId,
      reviewRound: turn.round,
      items: [{
        title: batchTitleOf(turn),
        details: `第 ${String(turn.round)} 轮审核，由 ${turn.agentId} 提出，共 ${String(items.length)} 条。`,
        // 父级严重度只是分类标签：完成度与收敛判定都只数叶子，不会被它影响。
        severity: items.some((item) => item.severity === "blocking")
          ? "blocking"
          : "non_blocking",
        sourceMessageId: turn.messageId,
      }],
      actorId: message.actorId,
    });
    if (!batch) {
      throw new Error("审核批次创建失败。");
    }
    database.createWorkItemsAsActor({
      topicId: input.topicId,
      parentId: batch.id,
      origin: "review_finding",
      sourceCycleId: input.cycleId,
      reviewRound: turn.round,
      items,
      actorId: message.actorId,
    });
    return true;
  }

  function applyReviewResults(
    input: SyncCycleLedgerInput,
    turn: RecordedTurn,
    existing: readonly WorkItem[],
  ): boolean {
    const message = database.getMessage(turn.messageId);
    const results = parseAgentReply(message.content).reviewResults ?? [];
    let changed = false;
    for (const result of results) {
      const target = existing.find((item) => item.id === result.workItemId);
      // 只认本轮圆桌自己产出的叶子条目：判定权不该外溢到用户手工拆的交付项，
      // 也不该落到批次父级上（它的状态由子条目派生）。
      if (
        !target
        || target.origin !== "review_finding"
        || target.sourceCycleId !== input.cycleId
        || !isLeaf(existing, target.id)
      ) {
        continue;
      }
      const desired = result.verdict === "fixed" ? "completed" : "blocked";
      // 状态已经一致就不写：复审判定会随每次推进重复读到，
      // 无条件回写会让 version 无限增长，乐观锁从此永远撞车。
      if (target.status === desired) {
        continue;
      }
      try {
        database.updateWorkItemAsActor({
          topicId: input.topicId,
          workItemId: target.id,
          status: desired,
          expectedVersion: target.version,
          statusNote: `复审（R${String(turn.round)} · ${turn.agentId}）：${result.note}`,
          actorId: message.actorId,
        });
        changed = true;
      } catch (error: unknown) {
        if (error instanceof CouncilConflictError || error instanceof CouncilValidationError) {
          logger.warn(
            "orchestration",
            `复审判定未能写回实施项 ${target.id}：${error.message}`,
          );
          continue;
        }
        throw error;
      }
    }
    return changed;
  }

  return {
    syncCycleLedger(input: SyncCycleLedgerInput): void {
      let existing = database.listWorkItems({ topicId: input.topicId });
      for (const turn of input.turns) {
        // 先落发现再应用判定：同一条发言可以既关掉旧条目又报出新问题，
        // 顺序反了会让新条目带着上一轮的判定入库。
        if (ingestTurn(input, turn, existing)) {
          existing = database.listWorkItems({ topicId: input.topicId });
        }
        if (applyReviewResults(input, turn, existing)) {
          existing = database.listWorkItems({ topicId: input.topicId });
        }
      }
    },

    readOpenFindings(
      topicId: string,
      cycleId: string,
    ): readonly OpenFindingBrief[] {
      const items = database.listWorkItems({
        topicId,
        origin: "review_finding",
      });
      return items
        .filter((item) =>
          item.sourceCycleId === cycleId
          && item.status !== "completed"
          && item.severity !== undefined
          && isLeaf(items, item.id))
        .map((item) => ({
          workItemId: item.id,
          title: item.title,
          severity: item.severity === "blocking" ? "blocking" : "non_blocking",
        }));
    },
  };
}
