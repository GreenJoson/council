/**
 * @input  依赖：自动轮次领域类型
 * @output 导出：OrchestrationRepository 运行与持久会话数据访问契约
 * @pos    将运行状态与 TopicDetail 解耦的前端持久化边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type {
  ApproveOrchestrationRunInput,
  CreateOrchestrationRunInput,
  OrchestrationRun,
  OrchestrationSnapshot,
  RuntimeBinding,
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
  loadCapabilities(): Promise<OrchestrationSnapshot>;
  selectTopic(topicId: string): Promise<OrchestrationSnapshot>;
  getRun(runId: string): Promise<OrchestrationRun>;
  createRun(input: CreateOrchestrationRunInput): Promise<OrchestrationRun>;
  startRun(runId: string): Promise<OrchestrationSnapshot>;
  approveRun(input: ApproveOrchestrationRunInput): Promise<OrchestrationSnapshot>;
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
  subscribe(listener: OrchestrationListener): () => void;
}
