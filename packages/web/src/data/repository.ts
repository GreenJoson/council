/**
 * @input  依赖：Council Web 领域类型
 * @output 导出：含议题关闭、决策包逐项/批量接受、人工 Accepted、实施项树写入/认领与详情加载的 CouncilRepository 接口
 * @pos    mock 与 HTTP/SSE 数据实现的稳定可替换边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type {
  AddWorkItemsInput,
  ClaimWorkItemInput,
  CreateTopicInput,
  PublishMessageInput,
  RecordManualDecisionInput,
  TopicDetail,
  UpdateWorkItemInput,
  WorkspaceSnapshot,
} from "../types/council";

export type WorkspaceListener = (snapshot: WorkspaceSnapshot) => void;

export interface CouncilRepository {
  loadWorkspace(): Promise<WorkspaceSnapshot>;
  selectTopic(topicId: string): Promise<WorkspaceSnapshot>;
  createTopic(input: CreateTopicInput): Promise<WorkspaceSnapshot>;
  /** 归档议题但保留全部讨论、决策和任务历史。 */
  closeTopic(topicId: string): Promise<WorkspaceSnapshot>;
  publishMessage(input: PublishMessageInput): Promise<WorkspaceSnapshot>;
  acceptDecisions(topicId: string, decisionIds: string[]): Promise<WorkspaceSnapshot>;
  /** 用户直接记录 accepted 并结束议题；不得创建 Agent Run。 */
  recordManualDecision(input: RecordManualDecisionInput): Promise<WorkspaceSnapshot>;
  addWorkItems(input: AddWorkItemsInput): Promise<WorkspaceSnapshot>;
  updateWorkItem(input: UpdateWorkItemInput): Promise<WorkspaceSnapshot>;
  /** 认领一条叶子任务：写上执行者并置为进行中，界面据此显示「谁在做哪一条」。 */
  claimWorkItem(input: ClaimWorkItemInput): Promise<WorkspaceSnapshot>;
  /** 只读加载完整议题详情；不改变 activeTopicId，不触发订阅快照 */
  loadTopicDetail(topicId: string): Promise<TopicDetail>;
  subscribe(listener: WorkspaceListener): () => void;
}
