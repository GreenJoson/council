/** @input 执行者最终回复；@output 完成摘要或主动阶段交接；@pos 未完成不能进入提交/验收，模型自述不是验证通过证据。 */
export const EXECUTION_CHECKPOINT_INSTRUCTION = [
  "按可验证的小目标推进，保留已有代码和测试。若剩余工作无法在本次预算内完成，提前停止扩展范围并保存文件。",
  "未完成时用下列格式结束本次调用，不要声称已完成：",
  'COUNCIL_CHECKPOINT\n{"completed":["已做事项"],"validation":["真实运行的检查与结果，未运行须说明"],"remaining":["下次具体步骤与阻断"]}',
  "只有全部完成后才返回普通的改动与测试摘要；Council 将独立审核，摘要本身不代表验收。",
].join("\n");

export class DelegationExecutionCheckpointError extends Error {
  constructor(readonly code: "execution_checkpoint" | "invalid_execution_checkpoint", message: string) { super(message); }
}

export function executionHandoff(content: string): string | undefined {
  const value = content.trim();
  if (!value.startsWith("COUNCIL_CHECKPOINT")) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value.slice("COUNCIL_CHECKPOINT".length).trim()); } catch { /* 下方统一失败关闭。 */ }
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  if (!record || !["completed", "validation", "remaining"].every(key => Array.isArray(record[key])
    && record[key].length <= 20 && record[key].every((entry: unknown) => typeof entry === "string" && entry.trim() && entry.length <= 1_000))
    || !(record.remaining as string[]).length || !(record.validation as string[]).length || value.length > 8_000) {
    throw new DelegationExecutionCheckpointError("invalid_execution_checkpoint", "执行阶段交接格式无效；文件已保留，不能当作完成或进入审核。");
  }
  return `阶段交接（执行者自述，尚未独立验收）：\n${JSON.stringify({ completed: record.completed, validation: record.validation, remaining: record.remaining })}`;
}
