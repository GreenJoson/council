/** @input 原生 CLI 的结构化事件；@output 不含正文/参数的执行进度；@pos 会话、回合和工具活动的白名单协议。 */
export interface NativeRuntimeProgress {
  sessionId?: string;
  turnsUsed?: number;
  turnLimit?: number;
  toolCalls: number;
  lastTool?: string;
  stopReason?: string;
}
export type NativeRuntimeProgressListener = (progress: NativeRuntimeProgress) => void;
export interface NativeRuntimeFailure { message: string; diagnosticCode: string; retryable: boolean }
export const nativeSessionId = (value: unknown): string | undefined =>
  typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/u.test(value) ? value : undefined;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export class NativeRuntimeProgressTracker {
  readonly #turns = new Set<string>();
  readonly #tools = new Set<string>();
  #progress: NativeRuntimeProgress;
  constructor(private readonly protocol: "claude" | "codex", private readonly listener?: NativeRuntimeProgressListener, turnLimit?: number) {
    this.#progress = { toolCalls: 0, ...(turnLimit ? { turnLimit } : {}) };
  }
  get snapshot(): NativeRuntimeProgress { return { ...this.#progress }; }
  observe(value: unknown): void {
    if (!record(value)) return;
    const before = JSON.stringify(this.#progress);
    const sessionId = nativeSessionId(value.session_id ?? value.thread_id);
    if (sessionId) this.#progress.sessionId = sessionId;
    if (this.protocol === "claude") {
      if (value.type === "assistant" && record(value.message)) {
        const id = nativeSessionId(value.message.id);
        if (id && !this.#turns.has(id)) {
          this.#turns.add(id); this.#progress.turnsUsed = this.#turns.size;
        }
        if (Array.isArray(value.message.content)) for (const block of value.message.content) {
          if (record(block) && block.type === "tool_use") this.#tool(block.id, block.name);
        }
      }
      if (value.type === "result") {
        if (typeof value.num_turns === "number" && Number.isSafeInteger(value.num_turns) && value.num_turns >= 0) this.#progress.turnsUsed = value.num_turns;
        if (typeof value.subtype === "string" && /^[a-z_]{1,80}$/u.test(value.subtype)) this.#progress.stopReason = value.subtype;
      }
    } else if ((value.type === "item.started" || value.type === "item.completed") && record(value.item)) {
      if (["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(String(value.item.type))) this.#tool(value.item.id, value.item.type);
    } else if (value.type === "turn.completed" || value.type === "turn.failed") {
      this.#progress.stopReason = value.type === "turn.completed" ? "success" : "error_during_execution";
    }
    if (JSON.stringify(this.#progress) !== before) this.listener?.(this.snapshot);
  }
  #tool(id: unknown, name: unknown): void {
    const key = nativeSessionId(id);
    if (!key || this.#tools.has(key)) return;
    this.#tools.add(key); this.#progress.toolCalls = this.#tools.size;
    // 工具名只接收协议标识符；不收命令、文件路径、参数或返回正文。
    if (typeof name === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/u.test(name)) this.#progress.lastTool = name;
  }
}

export function classifyClaudeFailure(value: unknown): NativeRuntimeFailure {
  const result = record(value) ? value : {};
  const parts = [result.result, ...(Array.isArray(result.errors) ? result.errors : [])];
  const text = parts.filter((part): part is string => typeof part === "string").join("\n");
  const failure = (diagnosticCode: string, message: string, retryable = false) => ({ diagnosticCode, message, retryable });
  if (result.subtype === "error_max_turns" || /max(?:imum)?(?: number of)? turns|turn limit|reached[^\n]*turn/iu.test(text))
    return failure("max_turns_exhausted", "Claude 工具回合预算已用尽，执行已暂停；已保留进度，请检查后接续。");
  if (result.subtype === "error_max_budget_usd")
    return failure("budget_exhausted", "Claude 调用预算已用尽，执行已暂停；请调整预算后接续。");
  if (/out of usage credits|usage limit|quota|insufficient credit|hit your (?:session|weekly|monthly|daily) limit|extra usage/iu.test(text))
    return failure("quota_exhausted", "Claude 账号额度已用尽，执行已暂停；请等待额度恢复或调整账号后接续。");
  if (/not logged in|authentication|unauthorized/iu.test(text))
    return failure("authentication_failed", "Claude Code CLI 未登录。请先完成一次 claude auth login；Claude Desktop 手动接力模式不受影响。");
  if (/model.*(?:not found|unavailable|not supported|access)|invalid model/iu.test(text))
    return failure("model_unavailable", "Claude 模型不可用，请在 Council 设置中选择当前账号可用的模型。");
  if (result.subtype === "error_max_structured_output_retries")
    return failure("invalid_result", "Claude 未能生成约定格式的结果，请检查输出要求后接续。");
  if (Array.isArray(result.permission_denials) && result.permission_denials.length)
    return failure("permission_denied", "Claude 工具操作被权限策略拒绝，已保留进度；请检查所需权限与任务范围。");
  if (/overloaded|rate limit|temporar|try again|service unavailable/iu.test(text))
    return failure("transient_failure", "Claude 服务暂时不可用，已保留进度，请稍后接续。", true);
  return failure("request_failed", "Claude Code 执行未成功，已保留进度；请查看失败阶段与执行记录。");
}
