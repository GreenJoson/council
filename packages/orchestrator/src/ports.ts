/**
 * @input  依赖：编排运行、共享消息与 Agent 调用类型
 * @output 导出：含分页、lease fencing 的 CouncilStore 和 AgentAdapter 抽象端口
 * @pos    隔离消息自动传播与 Agent 自动触发的架构边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type {
  AgentInvocation,
  AgentInvocationOptions,
  AgentResult,
  ApproveGateInput,
  ApproveGateResult,
  CouncilTopicContext,
  ClaimRunLeaseInput,
  CreateRunInput,
  ListRunsForTopicInput,
  ListRestartCandidatesInput,
  OrchestrationRun,
  PaginatedRuns,
  RenewRunLeaseInput,
  RoundCommitInput,
  RoundCommitResult,
  RunLease,
} from "./types.js";

/** 主动触发一个 Agent；实现可以调用模型，也可以桥接前台人工会话。 */
export interface AgentAdapter {
  readonly adapterId: string;
  invoke(input: AgentInvocation, options: AgentInvocationOptions): Promise<AgentResult>;
}

/**
 * 共享状态与消息传播端口。`commitRound` 必须在一个事务中检查运行版本、
 * 插入公开消息并更新运行状态，防止取消或并发恢复后写入过期回复。
 * `approveGate` 必须先按 approvalId 检查重放，再原子校验 gate/version；
 * 重放返回 applied=false，不能把旧批准应用到当前的新确认门。
 * Agent 执行产生的状态更新必须使用 lease 版本；claim/renew/release 不得触发内容 revision。
 */
export interface CouncilStore {
  createRun(input: CreateRunInput): Promise<OrchestrationRun>;
  getRun(runId: string): Promise<OrchestrationRun>;
  listRunsForTopic(input: ListRunsForTopicInput): Promise<PaginatedRuns>;
  /** 只分页返回 running/waiting_agent；实现必须按稳定顺序覆盖所有议题。 */
  listRestartCandidates(input: ListRestartCandidatesInput): Promise<PaginatedRuns>;
  /** 仅供 begin/recover/approve 等控制面转换；Agent 执行路径必须使用 fenced 版本。 */
  replaceRun(
    run: OrchestrationRun,
    expectedVersion: number,
  ): Promise<OrchestrationRun>;
  replaceRunWithLease(
    run: OrchestrationRun,
    expectedVersion: number,
    lease: RunLease,
  ): Promise<OrchestrationRun>;
  cancelRun(runId: string): Promise<OrchestrationRun>;
  approveGate(input: ApproveGateInput): Promise<ApproveGateResult>;
  getTopicContext(topicId: string): Promise<CouncilTopicContext>;
  commitRound(input: RoundCommitInput): Promise<RoundCommitResult>;
  claimRunLease(input: ClaimRunLeaseInput): Promise<RunLease>;
  renewRunLease(input: RenewRunLeaseInput): Promise<RunLease>;
  releaseRunLease(lease: RunLease): Promise<boolean>;
}
