/**
 * @input  依赖：Council Web 领域类型
 * @output 导出：含显式选题能力的 CouncilRepository 数据访问接口
 * @pos    mock 与 HTTP/SSE 数据实现的稳定可替换边界
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
  selectTopic(topicId: string): Promise<WorkspaceSnapshot>;
  createTopic(input: CreateTopicInput): Promise<WorkspaceSnapshot>;
  publishMessage(input: PublishMessageInput): Promise<WorkspaceSnapshot>;
  acceptDecision(topicId: string): Promise<WorkspaceSnapshot>;
  subscribe(listener: WorkspaceListener): () => void;
}
