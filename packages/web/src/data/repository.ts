/**
 * @input  依赖：Council Web 领域类型
 * @output 导出：含显式选题能力与只读议题详情加载的 CouncilRepository 数据访问接口
 * @pos    mock 与 HTTP/SSE 数据实现的稳定可替换边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type {
  CreateTopicInput,
  PublishMessageInput,
  TopicDetail,
  WorkspaceSnapshot,
} from "../types/council";

export type WorkspaceListener = (snapshot: WorkspaceSnapshot) => void;

export interface CouncilRepository {
  loadWorkspace(): Promise<WorkspaceSnapshot>;
  selectTopic(topicId: string): Promise<WorkspaceSnapshot>;
  createTopic(input: CreateTopicInput): Promise<WorkspaceSnapshot>;
  publishMessage(input: PublishMessageInput): Promise<WorkspaceSnapshot>;
  acceptDecision(topicId: string): Promise<WorkspaceSnapshot>;
  /** 只读加载完整议题详情；不改变 activeTopicId，不触发订阅快照 */
  loadTopicDetail(topicId: string): Promise<TopicDetail>;
  subscribe(listener: WorkspaceListener): () => void;
}
