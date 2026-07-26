/**
 * @input  依赖：Council SQLite、收敛仓储与结构化尾块解析
 * @output 导出：在轮次提交事务内记录 cycle 发言与阻塞提问
 * @pos    公开消息与收敛状态之间的原子边界；两者必须同生共死，否则 run 与 cycle 会失步
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { DatabaseSync } from "node:sqlite";
import {
  openBlockingQuestion,
  readActiveDiscussionCycle,
  recordCycleTurn,
} from "./cycle-repository.js";
import type { DiscussionCycleView } from "./cycle-repository.js";
import { parseAgentReply } from "./verdict.js";
import type { MessageKind } from "../types.js";

export interface CommitCycleTurnInput {
  topicId: string;
  /** 本轮计划的 Agent；必须与 cycle 期待的下一位发言人一致才算数。 */
  agentId: string;
  messageKind: MessageKind;
  messageId: string;
  actorId: string;
  content: string;
  now: string;
}

export interface CommittedCycleTurn {
  view: DiscussionCycleView;
  /** Agent 没按协议给出立场尾块；调用方应当记为协议违例。 */
  verdictMissing: boolean;
}

/**
 * 若该议题正等着这位 Agent 说话，就把这条刚落库的公开消息记成一次发言。
 *
 * 立场在这里解析而不是由调用方传入：解析结果必须和消息写在同一个事务里，
 * 中间任何一次崩溃都不能留下"消息已公开但发言没记上"的状态——那会让
 * 自动交接永远停在同一个人身上。
 *
 * 匹配不上时静默跳过：同一议题上的手动 @ 召唤不属于当前 cycle 的推进。
 * 议题级"单一活动 run"唯一索引保证这里不会误判成另一个执行者的轮次。
 */
export function commitCycleTurn(
  database: DatabaseSync,
  input: CommitCycleTurnInput,
): CommittedCycleTurn | undefined {
  const current = readActiveDiscussionCycle(database, input.topicId);
  if (!current) {
    return undefined;
  }
  const { action } = current;
  if (
    action.kind !== "invoke"
    || action.agentId !== input.agentId
    || action.messageKind !== input.messageKind
  ) {
    return undefined;
  }
  const reply = parseAgentReply(input.content);
  const cursor = { messageId: input.messageId, createdAt: input.now };
  let view = recordCycleTurn(database, {
    cycleId: current.cycle.id,
    expectedVersion: current.cycle.stateVersion,
    turn: {
      agentId: action.agentId,
      stage: action.stage,
      round: action.round,
      stance: reply.verdict.stance,
      messageId: input.messageId,
      ...(reply.fix ? { commitRef: reply.fix.commit } : {}),
      verdictDeclared: reply.verdictDeclared,
    },
    contextCursor: cursor,
    now: input.now,
  });
  if (reply.question) {
    view = openBlockingQuestion(database, {
      cycleId: current.cycle.id,
      expectedVersion: view.cycle.stateVersion,
      askedByActorId: input.actorId,
      askedAtStage: action.stage,
      // 这一条消息既是发言又是提问，发言可能已经把 cycle 推到下一阶段；
      // 回答后要回到推进后的阶段，否则会把刚说完的那一段重来一遍。
      ...(view.cycle.stage !== "awaiting_user" && view.cycle.stage !== "completed"
        ? { resumeStage: view.cycle.stage }
        : {}),
      question: reply.question,
      questionMessageId: input.messageId,
      now: input.now,
    });
  }
  return { view, verdictMissing: !reply.verdictDeclared };
}
