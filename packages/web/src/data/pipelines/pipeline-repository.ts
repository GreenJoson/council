/**
 * @input  依赖：types/pipelines 的列表项、详情与新建入参
 * @output 导出：PipelineRepository 流水线列表/详情/新建/确认 brief/选定 final/恢复/取消契约
 * @pos    流水线领域的前端数据边界；http/desktop/mock 三套实现由 create-pipeline-repository.ts 选择
 *
 * 刷新约定：与 TaskRepository 一致，真实实现不提供 subscribe。服务端 SSE 只有 council.changed {revision}，
 * 内容仓储与编排仓储已各自持有连接并按 revision 分流：流水线父/子任务行写入递增 content revision
 * （内容仓储随之发布新快照），委派变化递增 orchestration revision（编排快照 revision 前进）。
 * 调用方（hook 层）在这两个信号变化时重读 listPipelines/getPipeline；自身写操作返回最新 PipelineDetail，
 * 调用方据此就地更新。
 *
 * 唯一例外是 watchLocalChanges：只有 mock 实现提供。mock 的阶段推进由内存定时器驱动，不会推进任何
 * revision，没有这条本地信号页面就看不到状态机前进；http/desktop 不实现它，也不该实现。
 *
 * 版本：所有写操作带父任务 version（expectedVersion）；父任务版本会因子任务状态变化被服务端递增，
 * 冲突时 reject（服务端 409），调用方提示后重读。
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type {
  CreatePipelineInput,
  PipelineDetail,
  PipelineListResult,
} from "../../types/pipelines";

export interface PipelineRepository {
  /** 当前项目的流水线，按 updatedAt 降序；桌面离线时 items 为空并带 limitation。 */
  listPipelines(): Promise<PipelineListResult>;
  getPipeline(pipelineId: string): Promise<PipelineDetail>;
  /** 同项目重名 409；创建后服务端立即异步跑 brief 阶段。 */
  createPipeline(input: CreatePipelineInput): Promise<PipelineDetail>;
  /** brief 阶段 waiting_human 时确认（可修改的）brief；brief 无效 400。 */
  confirmBrief(pipelineId: string, brief: Record<string, unknown>, expectedVersion: number): Promise<PipelineDetail>;
  /** select 阶段 waiting_human 时选定 final；assetIds 必须是本流水线图像子任务的 output。 */
  selectFinal(pipelineId: string, assetIds: string[], expectedVersion: number): Promise<PipelineDetail>;
  /** 只重跑当前 failed 阶段，已入库资产不动。 */
  resumePipeline(pipelineId: string, expectedVersion: number): Promise<PipelineDetail>;
  cancelPipeline(pipelineId: string, expectedVersion: number): Promise<PipelineDetail>;
  /** 仅 mock：内存状态机推进时通知调用方重读；返回退订函数。 */
  watchLocalChanges?(listener: () => void): () => void;
}
