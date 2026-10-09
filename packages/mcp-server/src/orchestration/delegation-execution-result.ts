/** @input 执行者最终回复（含说明与 Markdown 包装）；@output 完成摘要或经过校验的阶段交接；@pos 交接标记一旦出现，格式错误也不能当作完成。 */
export const EXECUTION_CHECKPOINT_INSTRUCTION = [
  "按可验证的小目标推进，保留已有代码和测试。若剩余工作无法在本次预算内完成，提前停止扩展范围并保存文件。",
  "未完成时用下列格式结束本次调用，不要声称已完成：",
  'COUNCIL_CHECKPOINT\n{"completed":["已做事项"],"validation":["真实运行的检查与结果，未运行须说明"],"remaining":["下次具体步骤与阻断"]}',
  "如果剩余步骤可在当前权限和任务范围内自主继续，在 JSON 增加 canContinue:true；需要用户输入、权限或外部条件时填 canContinue:false。不要为了接续隐瞒阻断。",
  "只有全部完成后才返回普通的改动与测试摘要；Council 将独立审核，摘要本身不代表验收。",
].join("\n");

export class DelegationExecutionCheckpointError extends Error {
  constructor(readonly code: "execution_checkpoint" | "invalid_execution_checkpoint" | "execution_segment_limit" | "execution_time_limit" | "execution_no_progress", message: string) { super(message); }
}

export function parseExecutionHandoff(content: string): { summary: string; canContinue: boolean } | undefined {
  const value = content.trim();
  // CLI 常在协议前加说明或围栏；不能因此把尚未完成的工作送入提交和审核。
  const markers = [...value.matchAll(/\bCOUNCIL_CHECKPOINT\b/gu)];
  const marker = markers[0];
  if (!marker) return undefined;
  let payload = value.slice(marker.index! + "COUNCIL_CHECKPOINT".length).trim();
  if (payload.startsWith("```")) payload = payload.replace(/^```(?:json)?\s*\n/u, "");
  payload = payload.replace(/\n?```\s*$/u, "").trim();
  let parsed: unknown;
  try { parsed = JSON.parse(payload); } catch { /* 下方统一失败关闭。 */ }
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  if (markers.length !== 1 || !record || !["completed", "validation", "remaining"].every(key => Array.isArray(record[key])
    && record[key].length <= 20 && record[key].every((entry: unknown) => typeof entry === "string" && entry.trim() && entry.length <= 1_000))
    || !(record.remaining as string[]).length || !(record.validation as string[]).length || value.length > 8_000
    || (record.canContinue !== undefined && typeof record.canContinue !== "boolean")) {
    throw new DelegationExecutionCheckpointError("invalid_execution_checkpoint", "执行阶段交接格式无效；文件已保留，不能当作完成或进入审核。");
  }
  return { summary: `阶段交接（执行者自述，尚未独立验收）：\n${JSON.stringify({ completed: record.completed, validation: record.validation, remaining: record.remaining })}`,
    canContinue: record.canContinue === true };
}

export function executionHandoff(content: string): string | undefined {
  return parseExecutionHandoff(content)?.summary;
}
