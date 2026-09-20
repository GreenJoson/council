/** @input 待处理摘要响应；@output 严格解析的同项目聚合；@pos 不从文字猜测任务状态。 */
export interface WorkAttention {
  topicId: string;
  title: string;
  decisions: number;
  acceptance: number;
  blocked: number;
  failures: number;
  questions: number;
}
export function parseWorkAttention(value: unknown): WorkAttention[] {
  if (!Array.isArray(value)) throw new Error("待处理列表格式无效");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.topicId !== "string" || typeof entry.title !== "string"
      || ["decisions", "acceptance", "blocked", "failures", "questions"].some((key) => !Number.isSafeInteger(entry[key]) || entry[key] < 0)) {
      throw new Error("待处理条目格式无效");
    }
    return entry as WorkAttention;
  });
}
