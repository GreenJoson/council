/**
 * @input  当前议题（v18 起可缺省，非议题任务没有议题）、叶子任务和上下文预算
 * @output 完整任务/约束/已接受结论、可节选背景及完整指纹；委派项目路径解析（议题优先、实施项兜底）；
 *         代码委派输入图的提示词段落（delegationInputAssetsContext，只含相对路径）
 * @pos    不让长背景挤掉执行范围，关键材料超限时拒绝派发；找不到项目路径时拒绝派发
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */
import { createHash } from "node:crypto";
import { CouncilValidationError } from "../errors.js";
import type { TopicDetail, WorkItem } from "../types.js";

type DelegationDetail = Partial<Pick<TopicDetail, "topic">> & Pick<TopicDetail, "decisions">;

/** 议题项沿用议题路径（与 v18 前行为一致）；非议题任务用实施项自身 projectPath。 */
export function delegationProjectPath(detail: Partial<Pick<TopicDetail, "topic">>, item: WorkItem): string {
  const projectPath = detail.topic?.projectPath ?? item.projectPath;
  if (!projectPath) {
    throw new CouncilValidationError("实施项所属议题与实施项本身都没有绑定项目路径，无法派发委派。");
  }
  return projectPath;
}

export function delegationTaskContext(detail: DelegationDetail, item: WorkItem, maxChars: number): {
  context: string; contextFingerprint: string;
} {
  const { topic } = detail;
  const accepted = detail.decisions.filter(decision => decision.status === "accepted");
  const required = [
    // 非议题任务没有议题标题与约束：以任务本身为准，不伪造议题上下文。
    topic ? `议题：${topic.title}` : "议题：无（独立任务）",
    `当前实施项：${item.title}\n${item.details || "无补充说明"}`,
    topic?.constraints.length ? `约束：\n${topic.constraints.map(value => `- ${value}`).join("\n")}` : "约束：无额外约束",
    accepted.length ? `已接受决策：\n${accepted.map(decision => `- ${decision.title}\n  结论：${decision.decision}`).join("\n")}` : "已接受决策：无",
  ].join("\n\n");
  if (required.length > maxChars) {
    throw new CouncilValidationError("任务正文、约束与已接受决策超过上下文上限，请缩小任务或提高 COUNCIL_MAX_CONTEXT_CHARS；已停止委派，未删减关键要求。");
  }
  const background = [...(topic ? [`当前问题：${topic.question}`] : []),
    ...accepted.map(decision => `决策理由（${decision.title}）：${decision.rationale}`)].join("\n\n");
  const full = `${required}\n\n${background}`;
  const contextFingerprint = createHash("sha256").update(full).digest("hex");
  if (full.length <= maxChars) return { context: full, contextFingerprint };
  const notice = "\n\n[背景与决策理由已节选；执行范围以上方完整任务、约束与已接受结论为准。]";
  const available = maxChars - required.length - notice.length;
  // 预算不足以放背景时仍保留所有强制要求，不再从末尾截断它们。
  return { context: available >= 2 ? `${required}${notice}\n\n${background.slice(0, available - 2)}` : required, contextFingerprint };
}

/**
 * 代码委派的输入图（如流水线选定的终稿）说明：只列相对当前工作目录的路径并说明用途，
 * 不出现绝对路径；这些文件位于已写入 exclude 的 `.council/in/`，不会被提交。
 */
export function delegationInputAssetsContext(relativePaths: readonly string[]): string[] {
  if (relativePaths.length === 0) return [];
  return [
    "",
    "输入图（视觉参考，只读，位于不会被提交的 .council/in/ 目录）：",
    ...relativePaths.map((relativePath) => `- ${relativePath}`),
    "请先查看这些图片，以它们为界面与视觉依据实现；不要修改、移动或提交这些文件。",
  ];
}
