/**
 * @input  依赖：自动轮次领域类型
 * @output 导出：OrchestrationRepository 独立数据访问契约
 * @pos    将运行状态与 TopicDetail 解耦的前端持久化边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type {
  ApproveOrchestrationRunInput,
  CreateOrchestrationRunInput,
  OrchestrationRun,
  OrchestrationSnapshot,
} from "../types/orchestration";

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
  subscribe(listener: OrchestrationListener): () => void;
}
