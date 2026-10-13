/**
 * @input  依赖：mock-pipelines 夹具与行构造器、workspace-mapper 行映射、council-brief 校验、http-client 的 CouncilApiError
 * @output 导出：MockPipelineRepository（内存流水线状态机，带定时器推进与本地变更通知）及其构造参数
 * @pos    mock 模式流水线仓储：不依赖后端即可演示完整状态机——
 *         创建 → brief running →（约 600ms）waiting_human + draftBrief → 确认 → image running →（约 1s）completed →
 *         review 第 1 轮 revise（revisionCount=1）→ 重新出图 → review 第 2 轮 pass → select waiting_human →
 *         选 final →（app-mockup）prototype running →（约 1s）completed；其他模板选 final 即完成。
 *         失败阶段 resume 只重跑该阶段；cancel 置当前阶段 skipped（error.code=cancelled）+ 文档 status=cancelled；
 *         delete 从内存移除不在运行的流水线（运行中 409，与服务端一致）。
 *         每次推进（含定时器）都递增父任务 version；写操作版本不符、阶段不可操作、已取消时抛 409（CouncilApiError），
 *         与 http 模式走同一条前端冲突提示路径；从讨论消息派活需要服务端读已存消息，mock 一律 400 并给出说明
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { ApiWorkItem } from "../api-types";
import { CouncilApiError } from "../http-client";
import { validateCouncilBrief } from "../tasks/council-brief";
import { mapWorkItem } from "../workspace-mapper";
import {
  createMockPipelineFixtures,
  mockPipelineChild,
  mockPipelineDraftBrief,
  mockPipelineTask,
  mockPipelineTitle,
  MOCK_PIPELINE_OUTPUT_ASSET_IDS,
  type MockPipelineRecord,
} from "./mock-pipelines";
import type { PipelineRepository } from "./pipeline-repository";
import type { WorkItemStatus } from "../../types/council";
import {
  PIPELINE_TEMPLATE_STAGES,
  PIPELINE_TEMPLATES,
  type CouncilPipelineDocument,
  type CreatePipelineInput,
  type PipelineDetail,
  type PipelineDispatchResult,
  type PipelineListResult,
  type PipelineStage,
  type PipelineStageId,
  type PipelineSummary,
} from "../../types/pipelines";

/** 契约：参考资产最多 8 个、final 选 1～3 张（Web 交互约束）。 */
const MAX_REFERENCE_ASSETS = 8;
const MAX_FINAL_ASSETS = 3;

export interface MockPipelineRepositoryOptions {
  /** 各阶段模拟耗时（毫秒）；默认 brief 600、image 1000、review 600、prototype 1000。 */
  delays?: Partial<Record<"brief" | "image" | "review" | "prototype", number>>;
}

const DEFAULT_DELAYS = { brief: 600, image: 1000, review: 600, prototype: 1000 };

function conflict(message: string): CouncilApiError {
  return new CouncilApiError(message, 409);
}

function badRequest(message: string): CouncilApiError {
  return new CouncilApiError(message, 400);
}

export class MockPipelineRepository implements PipelineRepository {
  readonly #records: MockPipelineRecord[];
  readonly #delays: typeof DEFAULT_DELAYS;
  readonly #listeners = new Set<() => void>();
  /** 每条流水线当前挂着的定时器；取消时一并清掉，避免取消后状态机继续前进。 */
  readonly #timers = new Map<string, Set<ReturnType<typeof setTimeout>>>();

  constructor(options: MockPipelineRepositoryOptions = {}) {
    this.#records = createMockPipelineFixtures();
    this.#delays = { ...DEFAULT_DELAYS, ...options.delays };
  }

  watchLocalChanges(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  async listPipelines(): Promise<PipelineListResult> {
    const items = [...this.#records]
      .sort((left, right) => right.document.updatedAt.localeCompare(left.document.updatedAt))
      .map((record) => this.#summary(record));
    return { items };
  }

  async getPipeline(pipelineId: string): Promise<PipelineDetail> {
    return this.#detail(this.#require(pipelineId));
  }

  async createPipeline(input: CreatePipelineInput): Promise<PipelineDetail> {
    if (!PIPELINE_TEMPLATES.includes(input.template)) throw badRequest("不支持的流水线模板。");
    const goal = input.goal.trim();
    if (!goal) throw badRequest("目标不能为空。");
    const references = input.referenceAssetIds ?? [];
    if (references.length > MAX_REFERENCE_ASSETS) throw badRequest("参考资产最多 8 个。");
    const title = mockPipelineTitle(input.template, goal);
    if (this.#records.some((record) => record.task.title.toLowerCase() === title.toLowerCase())) {
      throw conflict("同一项目下已存在同名任务。");
    }
    const now = new Date().toISOString();
    const constraints = (input.constraints ?? []).map((entry) => entry.trim()).filter(Boolean);
    const document: CouncilPipelineDocument = {
      schemaVersion: 1,
      template: input.template,
      request: {
        goal,
        ...(constraints.length > 0 ? { constraints } : {}),
        ...(references.length > 0 ? { referenceAssetIds: [...references] } : {}),
      },
      agents: {
        brief: input.agents?.brief ?? "claude",
        image: input.agents?.image ?? "codex",
        ...(input.template === "app-mockup"
          ? { prototype: input.agents?.prototype ?? { executor: input.agents?.image ?? "codex", supervisor: "claude" } }
          : {}),
      },
      stages: PIPELINE_TEMPLATE_STAGES[input.template].map((id): PipelineStage =>
        id === "brief" ? { id, status: "running", startedAt: now } : { id, status: "pending" }),
      currentStageId: "brief",
      reviews: [],
      revisionCount: 0,
      updatedAt: now,
    };
    const record: MockPipelineRecord = {
      task: mockPipelineTask({
        id: `work_item_${crypto.randomUUID()}`,
        title,
        details: goal,
        status: "in_progress",
        version: 1,
        createdAt: now,
        updatedAt: now,
        document,
      }),
      document,
      children: [],
      outputAssetIds: [],
    };
    this.#records.push(record);
    this.#runBrief(record);
    return this.#detail(record);
  }

  // 派活要由服务端从已存消息重新解析，演示数据没有这条链路。
  async dispatchPipeline(_topicId: string, _messageId: string): Promise<PipelineDispatchResult> {
    throw badRequest("演示模式不能从讨论消息派活，请连接本地 Agent 服务后再试。");
  }

  async confirmBrief(pipelineId: string, brief: Record<string, unknown>, expectedVersion: number): Promise<PipelineDetail> {
    const record = this.#writable(pipelineId, expectedVersion);
    const stage = this.#stage(record, "brief");
    if (record.document.currentStageId !== "brief" || stage.status !== "waiting_human") {
      throw conflict("当前阶段不能确认简报。");
    }
    if (!validateCouncilBrief(brief).brief) throw badRequest("简报不符合 council-brief 格式。");
    record.document.brief = structuredClone(brief);
    this.#finishStage(record, stage);
    this.#startImage(record);
    this.#touch(record);
    return this.#detail(record);
  }

  async selectFinal(pipelineId: string, assetIds: string[], expectedVersion: number): Promise<PipelineDetail> {
    const record = this.#writable(pipelineId, expectedVersion);
    const stage = this.#stage(record, "select");
    if (record.document.currentStageId !== "select" || stage.status !== "waiting_human") {
      throw conflict("当前阶段不能选定最终稿。");
    }
    const unique = [...new Set(assetIds)];
    if (unique.length === 0 || unique.length > MAX_FINAL_ASSETS) throw badRequest("请选择 1 到 3 张最终稿。");
    if (unique.some((id) => !record.outputAssetIds.includes(id))) {
      throw badRequest("最终稿必须来自本流水线的图像产物。");
    }
    record.document.finalAssetIds = unique;
    this.#finishStage(record, stage);
    if (PIPELINE_TEMPLATE_STAGES[record.document.template].includes("prototype")) {
      this.#startPrototype(record);
    }
    this.#touch(record);
    return this.#detail(record);
  }

  async resumePipeline(pipelineId: string, expectedVersion: number): Promise<PipelineDetail> {
    const record = this.#writable(pipelineId, expectedVersion);
    const stage = this.#stage(record, record.document.currentStageId);
    if (stage.status !== "failed") throw conflict("只有失败的阶段可以恢复。");
    delete stage.error;
    delete stage.endedAt;
    // 只重跑当前阶段：已入库资产（outputAssetIds）原样保留。
    switch (stage.id) {
      case "brief":
        this.#setRunning(stage);
        this.#runBrief(record);
        break;
      case "image":
        this.#startImage(record);
        break;
      case "review":
        this.#setRunning(stage);
        this.#runReview(record);
        break;
      case "prototype":
        this.#startPrototype(record);
        break;
      default:
        throw conflict("当前阶段不能恢复。");
    }
    this.#touch(record);
    return this.#detail(record);
  }

  async cancelPipeline(pipelineId: string, expectedVersion: number): Promise<PipelineDetail> {
    const record = this.#writable(pipelineId, expectedVersion);
    if (this.#isFinished(record)) throw conflict("流水线已结束，无法取消。");
    this.#clearTimers(record.task.id);
    const stage = this.#stage(record, record.document.currentStageId);
    stage.status = "skipped";
    stage.endedAt = new Date().toISOString();
    stage.error = { code: "cancelled", message: "流水线已取消。" };
    record.document.status = "cancelled";
    this.#touch(record);
    return this.#detail(record);
  }

  async deletePipeline(pipelineId: string, expectedVersion: number): Promise<void> {
    const record = this.#require(pipelineId);
    if (record.task.version !== expectedVersion) throw conflict("实施项已被更新，请刷新后重试。");
    const current = this.#stage(record, record.document.currentStageId);
    if (record.document.status !== "cancelled" && current.status === "running") {
      throw conflict("流水线还在运行，请先取消再删除。");
    }
    this.#clearTimers(pipelineId);
    this.#records.splice(this.#records.indexOf(record), 1);
    for (const listener of this.#listeners) listener();
  }

  // ---- 阶段推进 ----

  #runBrief(record: MockPipelineRecord): void {
    this.#later(record, this.#delays.brief, () => {
      const stage = this.#stage(record, "brief");
      const { template, request } = record.document;
      record.document.draftBrief = mockPipelineDraftBrief(
        template, request.goal, request.constraints, request.referenceAssetIds,
      );
      stage.status = "waiting_human";
    });
  }

  /** 进入 image：为本轮新建图像子任务（brief 即确认后的 council-brief）。 */
  #startImage(record: MockPipelineRecord): void {
    const stage = this.#stage(record, "image");
    const round = record.children.filter((child) => child.kind === "image").length + 1;
    const now = new Date().toISOString();
    const child = mockPipelineChild(record.task, {
      id: `work_item_${crypto.randomUUID()}`,
      kind: "image",
      title: round === 1 ? "图像生成（第 1 轮）" : `图像修改（第 ${String(round)} 轮）`,
      status: "in_progress",
      at: now,
      ...(record.document.brief ? { brief: record.document.brief } : {}),
    });
    record.children.push(child);
    record.document.currentStageId = "image";
    stage.workItemId = child.id;
    stage.delegationId = `delegation_${crypto.randomUUID()}`;
    this.#setRunning(stage);
    this.#later(record, this.#delays.image, () => {
      this.#finishChild(child, "completed");
      for (const assetId of MOCK_PIPELINE_OUTPUT_ASSET_IDS) {
        if (!record.outputAssetIds.includes(assetId)) record.outputAssetIds.push(assetId);
      }
      this.#finishStage(record, stage);
      const review = this.#stage(record, "review");
      record.document.currentStageId = "review";
      this.#setRunning(review);
      this.#runReview(record);
    });
  }

  /** 第 1 轮固定 revise 一项（演示 Lead 复盘派回重画），之后 pass。 */
  #runReview(record: MockPipelineRecord): void {
    this.#later(record, this.#delays.review, () => {
      const stage = this.#stage(record, "review");
      const round = record.document.reviews.length + 1;
      if (record.document.revisionCount === 0) {
        record.document.reviews.push({
          round,
          verdict: "revise",
          items: [{
            assetId: "asset_mock_empty_dark",
            deliverableId: "screen-dark",
            ok: false,
            issue: "深色版对比度不足",
            change: "提高正文与背景对比度",
          }],
        });
        record.document.revisionCount += 1;
        // 回到 image 重画；review 退回 pending 等下一轮。
        stage.status = "pending";
        delete stage.startedAt;
        delete stage.endedAt;
        this.#startImage(record);
        return;
      }
      record.document.reviews.push({
        round,
        verdict: "pass",
        items: [{ assetId: "asset_mock_empty_dark", deliverableId: "screen-dark", ok: true }],
      });
      this.#finishStage(record, stage);
      const select = this.#stage(record, "select");
      record.document.currentStageId = "select";
      select.status = "waiting_human";
      select.startedAt = new Date().toISOString();
    });
  }

  #startPrototype(record: MockPipelineRecord): void {
    const stage = this.#stage(record, "prototype");
    const child = mockPipelineChild(record.task, {
      id: `work_item_${crypto.randomUUID()}`,
      kind: "prototype",
      title: "可点击原型",
      status: "in_progress",
      at: new Date().toISOString(),
    });
    record.children.push(child);
    record.document.currentStageId = "prototype";
    stage.workItemId = child.id;
    stage.delegationId = `delegation_${crypto.randomUUID()}`;
    this.#setRunning(stage);
    this.#later(record, this.#delays.prototype, () => {
      this.#finishChild(child, "completed");
      this.#finishStage(record, stage);
    });
  }

  // ---- 内部工具 ----

  #setRunning(stage: PipelineStage): void {
    stage.status = "running";
    stage.startedAt = new Date().toISOString();
    delete stage.endedAt;
    delete stage.error;
  }

  #finishStage(record: MockPipelineRecord, stage: PipelineStage): void {
    stage.status = "completed";
    stage.endedAt = new Date().toISOString();
    record.document.currentStageId = stage.id;
  }

  #finishChild(child: ApiWorkItem, status: WorkItemStatus): void {
    const now = new Date().toISOString();
    child.status = status;
    child.version += 1;
    child.updatedAt = now;
    if (status === "completed") child.completedAt = now;
  }

  /** 定时推进：执行后递增版本并通知订阅者；取消会清掉尚未触发的定时器。 */
  #later(record: MockPipelineRecord, delay: number, step: () => void): void {
    const id = record.task.id;
    const timers = this.#timers.get(id) ?? new Set();
    this.#timers.set(id, timers);
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (record.document.status === "cancelled") return;
      step();
      this.#touch(record);
      for (const listener of this.#listeners) listener();
    }, delay);
    timers.add(timer);
  }

  #clearTimers(pipelineId: string): void {
    for (const timer of this.#timers.get(pipelineId) ?? []) clearTimeout(timer);
    this.#timers.delete(pipelineId);
  }

  #touch(record: MockPipelineRecord): void {
    const now = new Date().toISOString();
    record.document.updatedAt = now;
    record.task.version += 1;
    record.task.updatedAt = now;
    record.task.status = this.#deriveTaskStatus(record);
    if (record.task.status === "completed") record.task.completedAt = now;
    else delete record.task.completedAt;
  }

  /** 父任务状态：全部完成 → completed；失败/取消 → blocked；等人 → pending；其余 → in_progress。 */
  #deriveTaskStatus(record: MockPipelineRecord): WorkItemStatus {
    if (this.#isCompleted(record)) return "completed";
    if (record.document.status === "cancelled") return "blocked";
    const current = this.#stage(record, record.document.currentStageId);
    if (current.status === "failed") return "blocked";
    if (current.status === "waiting_human") return "pending";
    return "in_progress";
  }

  #isCompleted(record: MockPipelineRecord): boolean {
    return record.document.stages.every((stage) => stage.status === "completed" || stage.status === "skipped")
      && record.document.status !== "cancelled";
  }

  #isFinished(record: MockPipelineRecord): boolean {
    return record.document.status === "cancelled" || this.#isCompleted(record);
  }

  #stage(record: MockPipelineRecord, id: PipelineStageId): PipelineStage {
    const stage = record.document.stages.find((entry) => entry.id === id);
    if (!stage) throw conflict("该流水线模板没有这个阶段。");
    return stage;
  }

  #require(pipelineId: string): MockPipelineRecord {
    const record = this.#records.find((entry) => entry.task.id === pipelineId);
    if (!record) throw new CouncilApiError("流水线不存在或已被移除", 404);
    return record;
  }

  #writable(pipelineId: string, expectedVersion: number): MockPipelineRecord {
    const record = this.#require(pipelineId);
    if (record.task.version !== expectedVersion) throw conflict("实施项已被更新，请刷新后重试。");
    if (record.document.status === "cancelled") throw conflict("流水线已取消。");
    return record;
  }

  #summary(record: MockPipelineRecord): PipelineSummary {
    const current = this.#stage(record, record.document.currentStageId);
    return {
      id: record.task.id,
      title: record.task.title,
      template: record.document.template,
      goal: record.document.request.goal,
      currentStageId: current.id,
      currentStageStatus: current.status,
      taskStatus: record.task.status,
      cancelled: record.document.status === "cancelled",
      updatedAt: record.document.updatedAt,
      version: record.task.version,
    };
  }

  #detail(record: MockPipelineRecord): PipelineDetail {
    const task = { ...record.task, brief: structuredClone(record.document) as unknown as Record<string, unknown> };
    return {
      task: mapWorkItem(task),
      document: structuredClone(record.document),
      children: record.children.map((child) => mapWorkItem(structuredClone(child))),
      outputAssetIds: [...record.outputAssetIds],
    };
  }
}
