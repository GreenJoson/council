/** @input 当前议题、叶子任务和上下文预算；@output 完整任务/约束/已接受结论、可节选背景及完整指纹；@pos 不让长背景挤掉执行范围，关键材料超限时拒绝派发。 */
import { createHash } from "node:crypto";
import { CouncilValidationError } from "../errors.js";
import type { TopicDetail, WorkItem } from "../types.js";

export function delegationTaskContext(detail: Pick<TopicDetail, "topic" | "decisions">, item: WorkItem, maxChars: number): {
  context: string; contextFingerprint: string;
} {
  const accepted = detail.decisions.filter(decision => decision.status === "accepted");
  const required = [
    `议题：${detail.topic.title}`,
    `当前实施项：${item.title}\n${item.details || "无补充说明"}`,
    detail.topic.constraints.length ? `约束：\n${detail.topic.constraints.map(value => `- ${value}`).join("\n")}` : "约束：无额外约束",
    accepted.length ? `已接受决策：\n${accepted.map(decision => `- ${decision.title}\n  结论：${decision.decision}`).join("\n")}` : "已接受决策：无",
  ].join("\n\n");
  if (required.length > maxChars) {
    throw new CouncilValidationError("任务正文、约束与已接受决策超过上下文上限，请缩小任务或提高 COUNCIL_MAX_CONTEXT_CHARS；已停止委派，未删减关键要求。");
  }
  const background = [`当前问题：${detail.topic.question}`,
    ...accepted.map(decision => `决策理由（${decision.title}）：${decision.rationale}`)].join("\n\n");
  const full = `${required}\n\n${background}`;
  const contextFingerprint = createHash("sha256").update(full).digest("hex");
  if (full.length <= maxChars) return { context: full, contextFingerprint };
  const notice = "\n\n[背景与决策理由已节选；执行范围以上方完整任务、约束与已接受结论为准。]";
  const available = maxChars - required.length - notice.length;
  // 预算不足以放背景时仍保留所有强制要求，不再从末尾截断它们。
  return { context: available >= 2 ? `${required}${notice}\n\n${background.slice(0, available - 2)}` : required, contextFingerprint };
}
