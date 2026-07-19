/**
 * @input  依赖：无
 * @output 导出：编排配置、状态、并发、lease、超时与 Agent 调用错误
 * @pos    调用方可稳定判定的错误边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

export class OrchestrationConfigError extends Error {
  override readonly name = "OrchestrationConfigError";
}

export class InvalidRunStateError extends Error {
  override readonly name: string = "InvalidRunStateError";
}

/** 公开控制面可安全返回的非法状态转换；不得用于快照或 codec 损坏。 */
export class RunStateConflictError extends InvalidRunStateError {
  override readonly name = "RunStateConflictError";
}

/** 运行标识不存在；与损坏的持久化快照严格区分。 */
export class RunNotFoundError extends InvalidRunStateError {
  override readonly name = "RunNotFoundError";
}

export class RunBusyError extends Error {
  override readonly name = "RunBusyError";
}

export class StoreConflictError extends Error {
  override readonly name: string = "StoreConflictError";
}

export class LeaseConflictError extends StoreConflictError {
  override readonly name = "LeaseConflictError";
}

export class LeaseLostError extends StoreConflictError {
  override readonly name = "LeaseLostError";
}

export class AgentInvocationError extends Error {
  override readonly name: string = "AgentInvocationError";

  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export class AgentTimeoutError extends AgentInvocationError {
  override readonly name = "AgentTimeoutError";

  constructor() {
    super("Agent 调用超过本轮配置的超时时间。", true);
  }
}

export class AgentCleanupTimeoutError extends AgentInvocationError {
  override readonly name = "AgentCleanupTimeoutError";

  constructor() {
    super("Agent 在取消后未能于清理期限内退出；禁止自动重试。", false);
  }
}

export class InvocationCancelledError extends Error {
  override readonly name = "InvocationCancelledError";

  constructor() {
    super("编排运行已取消。已触发 Agent 的迟到回复不会被提交。");
  }
}
