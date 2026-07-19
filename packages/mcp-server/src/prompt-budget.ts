/**
 * @input  依赖：可信前缀、不可信历史、字符预算与调用方错误工厂
 * @output 导出：永不裁可信内容、只保留最近历史的 prompt 预算函数
 * @pos    MCP 兼容层与编排 Agent 共用的 prompt 注入安全边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

export interface TrustedPromptInput {
  trustedPrefix: string;
  transcriptHeader: string;
  transcript: string;
  truncationMarker: string;
  maxChars: number;
  trustedOverflowError: () => Error;
}

export function buildTrustedPrompt(input: TrustedPromptInput): string {
  if (input.trustedPrefix.length > input.maxChars) {
    throw input.trustedOverflowError();
  }
  const remaining = input.maxChars - input.trustedPrefix.length;
  if (remaining < input.transcriptHeader.length) {
    return input.trustedPrefix;
  }
  const transcriptBudget = remaining - input.transcriptHeader.length;
  if (input.transcript.length <= transcriptBudget) {
    return `${input.trustedPrefix}${input.transcriptHeader}${input.transcript}`;
  }
  if (transcriptBudget <= input.truncationMarker.length) {
    return `${input.trustedPrefix}${input.transcriptHeader}`;
  }
  return `${input.trustedPrefix}${input.transcriptHeader}${input.truncationMarker}${input.transcript.slice(
    -(transcriptBudget - input.truncationMarker.length),
  )}`;
}
