/**
 * @input  依赖：自动轮次领域类型
 * @output 导出：OrchestrationRepository 运行、AI 实施计划、可选接续权限与持久会话数据访问契约
 * @pos    将运行状态与 TopicDetail 解耦的前端持久化边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { WorkAttention } from "./work-attention";
import type { RuntimeAuditPage, RuntimeAuditQuery } from "./runtime-audit";

import type {
  AnswerCycleQuestionInput,
  SubmitFixesInput,
  ApproveOrchestrationRunInput,
  CreateOrchestrationRunInput,
  GenerateWorkItemsInput,
  GenerateWorkItemsResult,
  OrchestrationRun,
  OrchestrationSnapshot,
  RuntimeBinding,
  StartCycleInput,
  StartWorkItemDelegationInput,
  StartWorkItemDelegationBatchInput,
  WorkItemDelegation,
} from "../types/orchestration";
import type {
  AgentConnectionTest,
  AgentDefinition,
  CreateAgentInput,
  CreateProviderInput,
  ModelRouterSnapshot,
  ProviderProfile,
  UpdateAgentInput,
  UpdateProviderInput,
} from "../types/model-router";

export type OrchestrationListener = (snapshot: OrchestrationSnapshot) => void;

export interface OrchestrationRepository {
  resumeWorkItemDelegation(id: string, expectedVersion: number, requestedPermission?: WorkItemDelegation["permissionProfile"]): Promise<WorkItemDelegation>;
  listWorkAttention(topicId: string): Promise<WorkAttention[]>;
  listRuntimeAudit(input: RuntimeAuditQuery): Promise<RuntimeAuditPage>;
  loadCapabilities(): Promise<OrchestrationSnapshot>;
  selectTopic(topicId: string): Promise<OrchestrationSnapshot>;
  getRun(runId: string): Promise<OrchestrationRun>;
  createRun(input: CreateOrchestrationRunInput): Promise<OrchestrationRun>;
  generateWorkItems(input: GenerateWorkItemsInput): Promise<GenerateWorkItemsResult>;
  startRun(runId: string): Promise<OrchestrationSnapshot>;
  approveRun(input: ApproveOrchestrationRunInput): Promise<OrchestrationSnapshot>;
  /** 开始圆桌：冻结名册后由编排层自动交接，用户此后只在被提问时介入。 */
  startCycle(input: StartCycleInput): Promise<OrchestrationSnapshot>;
  answerCycleQuestion(input: AnswerCycleQuestionInput): Promise<OrchestrationSnapshot>;
  /** 提交一批修复并开一轮复审；条目是否关闭仍由复审判定，不由提交方宣布。 */
  submitFixes(input: SubmitFixesInput): Promise<OrchestrationSnapshot>;
  /** 放弃当前圆桌；Run 失败卡住时用它解锁议题。 */
  abandonCycle(topicId: string): Promise<OrchestrationSnapshot>;
  cancelRun(runId: string): Promise<OrchestrationSnapshot>;
  recoverRun(runId: string): Promise<OrchestrationSnapshot>;
  closeRuntimeBinding(bindingId: string): Promise<RuntimeBinding>;
  reopenRuntimeBinding(bindingId: string): Promise<RuntimeBinding>;
  getModelRouter(): Promise<ModelRouterSnapshot>;
  createProvider(input: CreateProviderInput): Promise<ProviderProfile>;
  updateProvider(input: UpdateProviderInput): Promise<ProviderProfile>;
  removeProvider(providerId: string): Promise<ProviderProfile>;
  createAgent(input: CreateAgentInput): Promise<AgentDefinition>;
  updateAgent(input: UpdateAgentInput): Promise<AgentDefinition>;
  removeAgent(agentId: string): Promise<AgentDefinition>;
  testAgent(agentId: string): Promise<AgentConnectionTest>;
  listWorkItemDelegations(topicId: string): Promise<WorkItemDelegation[]>;
  startWorkItemDelegation(input: StartWorkItemDelegationInput): Promise<WorkItemDelegation>;
  startWorkItemDelegationBatch(input: StartWorkItemDelegationBatchInput): Promise<WorkItemDelegation[]>;
  cancelWorkItemDelegation(delegationId: string): Promise<WorkItemDelegation>;
  subscribe(listener: OrchestrationListener): () => void;
}
