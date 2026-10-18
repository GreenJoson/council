/**
 * @input  依赖：编排 Run 快照（轮次 blind/requestMessageId/instruction）与议题消息（含原始 createdAt）
 * @output 导出：BLIND_REVIEW_MARKER、BlindAnswerSlot、BlindAnswerGroup、collectBlindAnswerGroups（把同题盲答 Run
 *         与各 Agent 的回答配对）、buildBlindReviewInstructions（一键互评给每位 Agent 的评审指令）
 * @pos    讨论时间线的纯查询层：DiscussionPanel 用它把同一道题的多个回答并排成一组，并决定「让他们互评」
 *         是否已经发起过；不读界面状态，也不发请求
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { CouncilMessage } from "../types/council";
import type { OrchestrationRun, OrchestrationStatus } from "../types/orchestration";

/** 互评指令的固定开头：既让 Agent 知道这轮是评审，也让界面认出「这组本身就是互评」 */
export const BLIND_REVIEW_MARKER = "互评：";

const TERMINAL_STATUSES: readonly OrchestrationStatus[] = ["completed", "failed", "cancelled"];

export interface BlindAnswerSlot {
  adapterId: string;
  actorId: string;
  /** 该 Agent 在这次 Run 里发出的回答；还没答或这轮失败时缺省 */
  message?: CouncilMessage;
}

export interface BlindAnswerGroup {
  run: OrchestrationRun;
  requestMessageId: string;
  /** 这组本身就是互评（指令以 BLIND_REVIEW_MARKER 开头），不再往下给互评入口 */
  isReview: boolean;
  /** 已有别的 Run 的指令点名了这组全部回答——互评已经发起过 */
  hasReview: boolean;
  slots: BlindAnswerSlot[];
}

function isBlindRun(run: OrchestrationRun): string | null {
  const requestMessageId = run.plan[0]?.requestMessageId;
  if (
    run.plan.length < 2
    || !requestMessageId
    || !run.plan.every((round) => round.blind === true && round.requestMessageId === requestMessageId)
  ) {
    return null;
  }
  return requestMessageId;
}

/**
 * 同一议题同一时刻只有一个活动 Run，所以某位 Agent 在 [run.createdAt, run.updatedAt] 内、排在请求消息之后
 * 发的第一条消息就是它这轮的回答；Run 还没结束时不设上界。已被前面组认领的消息不会重复归属。
 */
export function collectBlindAnswerGroups(
  runs: readonly OrchestrationRun[],
  messages: readonly CouncilMessage[],
): BlindAnswerGroup[] {
  const ordered = [...runs].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const claimed = new Set<string>();
  const groups: BlindAnswerGroup[] = [];
  for (const run of ordered) {
    const requestMessageId = isBlindRun(run);
    const requestIndex = requestMessageId
      ? messages.findIndex((message) => message.id === requestMessageId)
      : -1;
    if (!requestMessageId || requestIndex < 0) {
      continue;
    }
    const isOpen = !TERMINAL_STATUSES.includes(run.status);
    const slots = run.plan.map((round): BlindAnswerSlot => {
      const message = messages.find((candidate, index) =>
        index > requestIndex
        && !claimed.has(candidate.id)
        && candidate.actorSnapshot.actorId === round.actorId
        && candidate.createdAt !== undefined
        && candidate.createdAt >= run.createdAt
        && (isOpen || candidate.createdAt <= run.updatedAt));
      if (message) {
        claimed.add(message.id);
      }
      return { adapterId: round.adapterId, actorId: round.actorId, ...(message ? { message } : {}) };
    });
    groups.push({
      run,
      requestMessageId,
      isReview: run.plan.every((round) => round.instruction.startsWith(BLIND_REVIEW_MARKER)),
      hasReview: false,
      slots,
    });
  }
  for (const group of groups) {
    const answerIds = group.slots.flatMap((slot) => (slot.message ? [slot.message.id] : []));
    group.hasReview = answerIds.length > 0 && runs.some((run) =>
      run.id !== group.run.id
      && answerIds.every((id) => run.plan.some((round) => round.instruction.includes(id))));
  }
  return groups;
}

/**
 * 一键互评：每位 Agent 评审「其他人」的回答。指令点名对方的消息 id，
 * 既让 Agent 精确定位要评的那条，也是 collectBlindAnswerGroups 判断「已互评」的依据。
 */
export function buildBlindReviewInstructions(
  group: BlindAnswerGroup,
  labelOf: (adapterId: string) => string,
): Record<string, string> {
  const answered = group.slots.filter((slot) => slot.message);
  return Object.fromEntries(answered.map((slot) => {
    const others = answered
      .filter((other) => other.adapterId !== slot.adapterId)
      .map((other) => `${labelOf(other.adapterId)}（消息 ${other.message?.id ?? ""}）`)
      .join("、");
    return [slot.adapterId, [
      `${BLIND_REVIEW_MARKER}上面这组同题盲答里，你已经交了自己的方案。现在请评审 ${others} 的回答：`,
      "1. 对方最强的一点；",
      "2. 对方最大的问题或风险；",
      "3. 你愿意吸收进自己方案的部分；",
      "4. 两版里你认为哪版更好、为什么——对方更好就直说。",
      "只做评审，不要重写整份方案。",
    ].join("\n")];
  }));
}
