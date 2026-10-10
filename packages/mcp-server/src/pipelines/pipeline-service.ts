/**
 * @input  依赖：CouncilDatabase（父任务/子任务/资产）、PipelineStateStore 与 PipelineDriver（锁与阶段推进）、
 *         Agent 候选目录（默认 Agent 选择）、委派端口、模板与文档协议、参考图校验
 * @output 导出：PipelineService（create/list/get/confirmBrief/selectFinal/resume/cancel 与生命周期）、
 *         PipelineSummary、PipelineDetail、CreatePipelineInput、PipelineAgentCatalog
 * @pos    流水线用例层：校验人工输入（版本、阶段可操作性、brief 模板约束、终稿归属与数量上限、Agent 可用性）后交给驱动器推进；
 *         HTTP 路由与（经回环 HTTP 的）MCP 工具只做协议适配
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { MAX_IMAGE_INPUT_ASSETS, MAX_TITLE_CHARS } from "../constants.js";
import type { CouncilDatabase } from "../database.js";
import { CouncilConflictError, CouncilValidationError } from "../errors.js";
import { validateInputImageAssets } from "../orchestration/delegation-task-resolver.js";
import type { AgentCandidate } from "../orchestration/product-service.js";
import { normalizeProjectPath } from "../project-path.js";
import type { WorkItem } from "../types.js";
import {
  PipelineDriver,
  type PipelineAgentPort,
  type PipelineDelegationPort,
} from "./pipeline-driver.js";
import {
  createPipelineDocument,
  currentStage,
  isPipelineFinished,
  parsePipelineBrief,
  PIPELINE_DOCUMENT_LIMITS,
  PipelineProtocolError,
  stageOf,
  withStage,
  type PipelineAgents,
  type PipelineDocument,
  type PipelineStageStatus,
} from "./pipeline-document.js";
import { PipelineStateStore, type PipelineSnapshot } from "./pipeline-state.js";
import { pipelineTemplate, type PipelineStageId, type PipelineTemplateId } from "./templates.js";

export interface PipelineAgentCatalog {
  listAgentCandidates(): Promise<AgentCandidate[]>;
}

export interface PipelineSummary {
  id: string;
  title: string;
  template: PipelineTemplateId;
  goal: string;
  currentStageId: PipelineStageId;
  currentStageStatus: PipelineStageStatus;
  taskStatus: WorkItem["status"];
  updatedAt: string;
  version: number;
}

export interface PipelineDetail {
  task: WorkItem;
  document: PipelineDocument;
  children: WorkItem[];
  outputAssetIds: string[];
}

export interface CreatePipelineInput {
  projectPath: string;
  template: PipelineTemplateId;
  goal: string;
  constraints?: readonly string[];
  referenceAssetIds?: readonly string[];
  agents?: {
    brief?: string;
    image?: string;
    prototype?: { executor?: string; supervisor?: string };
  };
  actorId: string;
}

const FINAL_NOTE = "已在流水线中选定终稿";
const MAX_PIPELINE_REVISIONS = 31;

const AGENT_HINTS = {
  brief: "流水线需要一个已启用、已填写模型且可用的 Claude CLI Agent 撰写 brief 与复盘；请在设置中启用 Claude CLI、填写模型并登录后重试，或在 agents.brief 指定可用 Agent。",
  image: "流水线需要一个通过生图探针的 Codex CLI Agent（本机 ChatGPT 登录）；请在设置中启用并检测 Codex 后重试，或在 agents.image 指定。",
  prototype: "原型阶段需要可用的执行与监督 Agent；请在 agents.prototype 指定或启用 Claude CLI / Codex CLI Agent。",
} as const;

function isImageCapable(agent: AgentCandidate): boolean {
  return agent.protocol === "codex-cli"
    && agent.available
    && agent.runtimeCapabilities.includes("image_generate")
    && (agent.executionRole === "executor" || agent.executionRole === "hybrid");
}

function isClaude(agent: AgentCandidate): boolean {
  return agent.protocol === "claude-cli" && agent.available;
}

function byAliasFirst(alias: string) {
  return (left: AgentCandidate, right: AgentCandidate): number =>
    Number(right.mentionAlias === alias) - Number(left.mentionAlias === alias);
}

export class PipelineService {
  readonly #database: CouncilDatabase;
  readonly #store: PipelineStateStore;
  readonly #driver: PipelineDriver;
  readonly #catalog: PipelineAgentCatalog;
  readonly #maxStages: number;

  constructor(deps: {
    database: CouncilDatabase;
    agents: PipelineAgentPort & PipelineAgentCatalog;
    delegations: PipelineDelegationPort;
    limits: { maxStages: number; maxRevisions: number };
  }) {
    this.#database = deps.database;
    this.#store = new PipelineStateStore(deps.database);
    this.#catalog = deps.agents;
    this.#maxStages = deps.limits.maxStages;
    this.#driver = new PipelineDriver({
      store: this.#store,
      agents: deps.agents,
      delegations: deps.delegations,
      // 文档 reviews 最多 32 条（修订轮数 + 1），上限据此收紧。
      maxRevisions: Math.min(deps.limits.maxRevisions, MAX_PIPELINE_REVISIONS),
    });
  }

  async initialize(): Promise<void> {
    await this.#driver.initialize();
  }

  shutdown(): void {
    this.#driver.shutdown();
  }

  close(): void {
    this.#database.close();
  }

  // ┌───────────────────────────────────────────────────────────┐
  // │ 读取                                                      │
  // └───────────────────────────────────────────────────────────┘

  list(projectPath: string): PipelineSummary[] {
    const project = normalizeProjectPath(projectPath);
    if (!project) throw new CouncilValidationError("project 必须是项目路径。");
    return this.#database
      .listTasks({ projectPath: project, kind: "pipeline", source: "direct" })
      .flatMap((task): PipelineSummary[] => {
        try {
          const { document } = this.#store.load(task.id);
          const stage = currentStage(document);
          return [{
            id: task.id,
            title: task.title,
            template: document.template,
            goal: document.request.goal,
            currentStageId: stage.id,
            currentStageStatus: stage.status,
            taskStatus: task.status,
            updatedAt: task.updatedAt,
            version: task.version,
          }];
        } catch {
          // 文档损坏的父任务不进列表，详情接口会给出 409 说明。
          return [];
        }
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  get(pipelineId: string): PipelineDetail {
    return this.#detail(this.#store.load(pipelineId));
  }

  #detail(snapshot: PipelineSnapshot): PipelineDetail {
    const children = this.#store.children(snapshot.task);
    return {
      task: snapshot.task,
      document: snapshot.document,
      children,
      outputAssetIds: this.#store.pipelineOutputAssetIds(snapshot.task, children),
    };
  }

  // ┌───────────────────────────────────────────────────────────┐
  // │ 创建                                                      │
  // └───────────────────────────────────────────────────────────┘

  async create(input: CreatePipelineInput): Promise<PipelineDetail> {
    const projectPath = normalizeProjectPath(input.projectPath);
    if (!projectPath) throw new CouncilValidationError("流水线必须绑定项目路径。");
    const template = pipelineTemplate(input.template);
    if (template.stages.length > this.#maxStages) {
      throw new CouncilValidationError(
        `模板 ${template.id} 有 ${String(template.stages.length)} 个阶段，超过 COUNCIL_PIPELINE_MAX_STAGES=${String(this.#maxStages)}。`);
    }
    const goal = input.goal.trim();
    if (!goal) throw new CouncilValidationError("流水线目标不能为空。");
    if (goal.length > PIPELINE_DOCUMENT_LIMITS.maxGoal) {
      throw new CouncilValidationError(`流水线目标不能超过 ${String(PIPELINE_DOCUMENT_LIMITS.maxGoal)} 字。`);
    }
    const referenceAssetIds = [...(input.referenceAssetIds ?? [])];
    validateInputImageAssets(this.#database, { projectPath, inputAssetIds: referenceAssetIds, label: "流水线参考图" });
    const agents = await this.#resolveAgents(input.agents, template.requiresPrototype);
    const constraints = (input.constraints ?? []).map((item) => item.trim()).filter(Boolean);
    let document: PipelineDocument;
    try {
      document = createPipelineDocument({
        template: template.id,
        request: {
          goal,
          ...(constraints.length > 0 ? { constraints } : {}),
          ...(referenceAssetIds.length > 0 ? { referenceAssetIds } : {}),
        },
        agents,
        now: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof PipelineProtocolError) throw new CouncilValidationError(error.message);
      throw error;
    }
    const title = `[${template.name}] ${goal}`;
    const task = this.#database.createDirectTaskAsActor({
      projectPath,
      title: title.length <= MAX_TITLE_CHARS ? title : `${title.slice(0, MAX_TITLE_CHARS - 1)}…`,
      details: goal,
      kind: "pipeline",
      priority: 0,
      brief: document as unknown as Record<string, unknown>,
      actorId: input.actorId,
    });
    const snapshot = await this.#store.withLock(task.id, () => this.#driver.startBrief(task.id, input.actorId));
    return this.#detail(snapshot);
  }

  /** 显式指定的 Agent 必须存在且启用；缺省按约定挑选。挑不出来 → 409 + 可执行提示。 */
  async #resolveAgents(
    requested: CreatePipelineInput["agents"],
    requiresPrototype: boolean,
  ): Promise<PipelineAgents> {
    const candidates = await this.#catalog.listAgentCandidates();
    const find = (id: string | undefined, hint: string): AgentCandidate | undefined => {
      if (!id) return undefined;
      const agent = candidates.find((item) => item.id === id);
      if (!agent) throw new CouncilConflictError(`Agent ${id} 不存在或未启用。${hint}`);
      return agent;
    };
    const claudes = candidates.filter(isClaude).sort(byAliasFirst("claude"));
    const brief = find(requested?.brief, AGENT_HINTS.brief) ?? claudes[0];
    if (!brief?.available) throw new CouncilConflictError(AGENT_HINTS.brief);
    const image = find(requested?.image, AGENT_HINTS.image)
      ?? candidates.filter(isImageCapable).sort(byAliasFirst("codex"))[0];
    if (!image) throw new CouncilConflictError(AGENT_HINTS.image);
    const agents: PipelineAgents = { brief: brief.id, image: image.id };
    if (!requiresPrototype) return agents;
    const executor = find(requested?.prototype?.executor, AGENT_HINTS.prototype) ?? image;
    const supervisor = find(requested?.prototype?.supervisor, AGENT_HINTS.prototype)
      ?? claudes.find((item) => item.executionRole === "reviewer" || item.executionRole === "hybrid")
      ?? brief;
    return { ...agents, prototype: { executor: executor.id, supervisor: supervisor.id } };
  }

  // ┌───────────────────────────────────────────────────────────┐
  // │ 人工推进                                                  │
  // └───────────────────────────────────────────────────────────┘

  /** 锁内读取并做通用守卫：版本一致、未取消、未结束。 */
  #guard(pipelineId: string, expectedVersion: number): PipelineSnapshot {
    const snapshot = this.#store.load(pipelineId);
    this.#store.assertVersion(snapshot.task, expectedVersion);
    if (snapshot.document.status === "cancelled") throw new CouncilConflictError("流水线已取消。");
    if (isPipelineFinished(snapshot.document)) throw new CouncilConflictError("流水线已结束。");
    return snapshot;
  }

  async confirmBrief(input: {
    pipelineId: string;
    brief: unknown;
    expectedVersion: number;
    actorId: string;
  }): Promise<PipelineDetail> {
    const snapshot = await this.#store.withLock(input.pipelineId, async () => {
      const { document } = this.#guard(input.pipelineId, input.expectedVersion);
      const stage = currentStage(document);
      if (stage.id !== "brief" || stage.status !== "waiting_human") {
        throw new CouncilConflictError("当前阶段不是等待确认的 brief。");
      }
      let brief;
      try {
        brief = parsePipelineBrief(input.brief, document.template);
      } catch (error) {
        if (error instanceof PipelineProtocolError) throw new CouncilValidationError(error.message);
        throw error;
      }
      await this.#assertImageAgent(document.agents.image);
      const at = new Date().toISOString();
      this.#store.write(input.pipelineId, ({ document: current }) => ({
        ...withStage(current, "brief", {
          status: "completed",
          ...(stage.startedAt ? { startedAt: stage.startedAt } : {}),
          endedAt: at,
        }, at),
        brief,
      }), { actorId: input.actorId, expectedVersion: input.expectedVersion });
      return await this.#driver.startImage(input.pipelineId, input.actorId);
    });
    return this.#detail(snapshot);
  }

  async #assertImageAgent(agentId: string): Promise<void> {
    const agent = (await this.#catalog.listAgentCandidates()).find((item) => item.id === agentId);
    if (!agent?.available || !agent.runtimeCapabilities.includes("image_generate")) {
      throw new CouncilConflictError(AGENT_HINTS.image);
    }
  }

  async selectFinal(input: {
    pipelineId: string;
    assetIds: readonly string[];
    expectedVersion: number;
    actorId: string;
  }): Promise<PipelineDetail> {
    const snapshot = await this.#store.withLock(input.pipelineId, async () => {
      const { task, document } = this.#guard(input.pipelineId, input.expectedVersion);
      const stage = currentStage(document);
      if (stage.id !== "select" || stage.status !== "waiting_human") {
        throw new CouncilConflictError("当前阶段不是等待选定终稿。");
      }
      const assetIds = [...new Set(input.assetIds)];
      const children = this.#store.children(task);
      const outputs = new Set(this.#store.pipelineOutputAssetIds(task, children));
      if (assetIds.length === 0 || assetIds.some((id) => !outputs.has(id))) {
        throw new CouncilValidationError("终稿必须是本流水线图像子任务的产物。");
      }
      const hasPrototype = stageOf(document, "prototype") !== undefined;
      // 终稿会作为原型代码委派的输入图，受单次委派输入图上限约束；无原型阶段时只受文档上限约束。
      if (hasPrototype && assetIds.length > MAX_IMAGE_INPUT_ASSETS) {
        throw new CouncilValidationError(`含原型阶段的流水线最多选定 ${MAX_IMAGE_INPUT_ASSETS} 张终稿。`);
      }
      for (const assetId of assetIds) this.#database.addAssetLink(assetId, "work_item", task.id, "final");
      const at = new Date().toISOString();
      this.#store.write(input.pipelineId, ({ document: current }) => ({
        ...withStage(current, "select", {
          status: "completed",
          ...(stage.startedAt ? { startedAt: stage.startedAt } : {}),
          endedAt: at,
        }, at),
        finalAssetIds: assetIds,
      }), { actorId: input.actorId, expectedVersion: input.expectedVersion });
      // 先建原型子任务再收尾图像子任务：否则父任务会被短暂派生为 completed。
      if (hasPrototype) await this.#driver.startPrototype(input.pipelineId, input.actorId);
      this.#completeImageChildren(children, input.actorId);
      return this.#store.load(input.pipelineId);
    });
    return this.#detail(snapshot);
  }

  /** 选定终稿即人工验收：把仍 in_progress 的图像子任务以 human 身份标为 completed。 */
  #completeImageChildren(children: readonly WorkItem[], actorId: string): void {
    for (const child of children) {
      if (child.kind !== "image") continue;
      const fresh = this.#database.getWorkItem(child.id);
      if (fresh.status !== "in_progress") continue;
      this.#database.updateWorkItemAsActor({
        workItemId: fresh.id,
        status: "completed",
        expectedVersion: fresh.version,
        statusNote: FINAL_NOTE,
        actorId,
      });
    }
  }

  async resume(input: { pipelineId: string; expectedVersion: number; actorId: string }): Promise<PipelineDetail> {
    const snapshot = await this.#store.withLock(input.pipelineId, async () => {
      const { document } = this.#guard(input.pipelineId, input.expectedVersion);
      const stage = currentStage(document);
      if (stage.status !== "failed") throw new CouncilConflictError("只有失败的阶段可以恢复。");
      if (stage.id === "image") await this.#assertImageAgent(document.agents.image);
      return await this.#driver.retryCurrentStage(input.pipelineId, input.actorId);
    });
    return this.#detail(snapshot);
  }

  async cancel(input: { pipelineId: string; expectedVersion: number; actorId: string }): Promise<PipelineDetail> {
    const snapshot = await this.#store.withLock(input.pipelineId, () =>
      this.#driver.cancel(input.pipelineId, input.actorId, input.expectedVersion));
    return this.#detail(snapshot);
  }
}
