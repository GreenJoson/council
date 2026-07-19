/**
 * @input  依赖：Council Web 领域类型
 * @output 导出：CouncilRepository 数据访问接口
 * @pos    mock 数据和后续本地 HTTP API 的可替换边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type {
  CreateTopicInput,
  PublishMessageInput,
  WorkspaceSnapshot,
} from "../types/council";

export type WorkspaceListener = (snapshot: WorkspaceSnapshot) => void;

export interface CouncilRepository {
  loadWorkspace(): Promise<WorkspaceSnapshot>;
  createTopic(input: CreateTopicInput): Promise<WorkspaceSnapshot>;
  publishMessage(input: PublishMessageInput): Promise<WorkspaceSnapshot>;
  acceptDecision(topicId: string): Promise<WorkspaceSnapshot>;
  subscribe(listener: WorkspaceListener): () => void;
}
