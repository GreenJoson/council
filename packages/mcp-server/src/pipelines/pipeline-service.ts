/**
 * @input  依赖：CouncilDatabase（父任务/子任务/资产、议题与消息）、PipelineStateStore 与 PipelineDriver（锁、阶段推进与选定后的出图子任务收尾）、
 *         Agent 候选目录（默认 Agent 选择）、委派端口、项目内资产导入端口（派活参考图）、模板/文档/派活协议、参考图校验、
 *         原型委派权限档（prototypePermission）
 * @output 导出：PipelineService（create/dispatchFromMessage/list/get/confirmBrief/selectFinal/resume/cancel 与生命周期）、
 *         PipelineSummary、PipelineDetail、CreatePipelineInput、PipelineDispatchResult、PipelineAgentCatalog、PipelineAssetImporter
 * @pos    流水线用例层：校验人工输入（版本、阶段可操作性、brief 模板约束与交付物合计 ≤ 单次生图上限、终稿归属与数量上限、Agent 可用性）后交给驱动器推进；
 *         dispatchFromMessage 从已存讨论消息的 council-dispatch 尾块起流水线：参考图按项目相对路径导入资产库，
 *         人点按钮即视为确认 brief，跳过 brief 阶段直接出图；同一条消息只起一条（已取消的除外），
 *         标题与项目内已有任务重名时自动加「（N）」。
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
import type { PipelinePrototypePermission, WorkItem } from "../types.js";
import { extractPipelineDispatch } from "./dispatch-protocol.js";
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

/** 派活参考图入库：项目内相对路径 → 资产（同内容去重）；越界、符号链接、非白名单类型由实现拒绝。 */
export interface PipelineAssetImporter {
  importFromProject(input: { projectPath: string; relativePath: string; actorId?: string }): Promise<{ asset: { id: string } }>;
}

export interface PipelineDispatchResult {
  pipeline: PipelineDetail;
  /** false：这条消息已经起过（未取消的）流水线，返回的是既有那条。 */
  created: boolean;
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

/** 超长截断加省略号，后缀（重名序号）始终保留在末尾。 */
function clampTitle(base: string, suffix = ""): string {
  const room = MAX_TITLE_CHARS - suffix.length;
  return `${base.length <= room ? base : `${base.slice(0, room - 1)}…`}${suffix}`;
}

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
  readonly #assets: PipelineAssetImporter | undefined;
  readonly #maxStages: number;
  /** 单次图像委派能入库的张数（COUNCIL_CODEX_IMAGE_MAX_OUTPUTS）；人工确认的 brief 合计不得超过。 */
  readonly #maxImageOutputs: number;
  /** 同一条消息的派活串行执行：连点两下只起一条。 */
  readonly #dispatching = new Map<string, Promise<PipelineDispatchResult>>();

  constructor(deps: {
    database: CouncilDatabase;
    agents: PipelineAgentPort & PipelineAgentCatalog;
    delegations: PipelineDelegationPort;
    limits: { maxStages: number; maxRevisions: number; maxImageOutputs: number };
    /** 派活参考图入库；缺省时派活尾块不能带 references（测试夹具不必关心）。 */
    assets?: PipelineAssetImporter;
    /** 原型代码委派请求的权限档；缺省 workspace_write（手工构造的调用方与测试夹具不必关心）。 */
    prototypePermission?: PipelinePrototypePermission;
  }) {
    this.#database = deps.database;
    this.#store = new PipelineStateStore(deps.database);
    this.#catalog = deps.agents;
    this.#assets = deps.assets;
    this.#maxStages = deps.limits.maxStages;
    this.#maxImageOutputs = deps.limits.maxImageOutputs;
    this.#driver = new PipelineDriver({
      store: this.#store,
      agents: deps.agents,
      delegations: deps.delegations,
      // 文档 reviews 最多 32 条（修订轮数 + 1），上限据此收紧。
      maxRevisions: Math.min(deps.limits.maxRevisions, MAX_PIPELINE_REVISIONS),
      maxImageOutputs: deps.limits.maxImageOutputs,
      prototypePermission: deps.prototypePermission ?? "workspace_write",
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
    const task = this.#createTask(projectPath, document, input.actorId);
    const snapshot = await this.#store.withLock(task.id, () => this.#driver.startBrief(task.id, input.actorId));
    return this.#detail(snapshot);
  }

  /**
   * 项目内顶层任务标题不分状态唯一。手工新建撞名照常 409（人能改目标）；
   * 派活的目标是 Agent 写的、人改不了，取消后重派或两条消息目标相同时自动加「（N）」。
   */
  #createTask(projectPath: string, document: PipelineDocument, actorId: string, options?: { numberDuplicates: boolean }): WorkItem {
    const goal = document.request.goal;
    const base = `[${pipelineTemplate(document.template).name}] ${goal}`;
    return this.#database.createDirectTaskAsActor({
      projectPath,
      title: options?.numberDuplicates ? this.#numberedTitle(projectPath, base) : clampTitle(base),
      details: goal,
      kind: "pipeline",
      priority: 0,
      brief: document as unknown as Record<string, unknown>,
      actorId,
    });
  }

  #numberedTitle(projectPath: string, base: string): string {
    const taken = new Set(this.#database.listTasks({ projectPath, source: "direct" })
      .filter((task) => task.parentId === undefined)
      .map((task) => task.title.toLowerCase()));
    let title = clampTitle(base);
    for (let index = 2; taken.has(title.toLowerCase()); index += 1) {
      title = clampTitle(base, `（${String(index)}）`);
    }
    return title;
  }

  // ┌───────────────────────────────────────────────────────────┐
  // │ 从讨论消息派活                                            │
  // └───────────────────────────────────────────────────────────┘

  /**
   * 讨论 Agent 只读，派活方案以 council-dispatch 尾块留在消息里；人点按钮才执行。
   * 一律从数据库里的消息正文重新解析，前端只传 id——卡片上看到的就是要执行的。
   */
  async dispatchFromMessage(input: { topicId: string; messageId: string; actorId: string }): Promise<PipelineDispatchResult> {
    const pending = this.#dispatching.get(input.messageId);
    if (pending) return await pending;
    const run = this.#dispatchFromMessage(input).finally(() => this.#dispatching.delete(input.messageId));
    this.#dispatching.set(input.messageId, run);
    return await run;
  }

  async #dispatchFromMessage(input: { topicId: string; messageId: string; actorId: string }): Promise<PipelineDispatchResult> {
    const topic = this.#database.getTopic(input.topicId);
    const message = this.#database.getMessage(input.messageId);
    if (message.topicId !== topic.id) throw new CouncilValidationError("消息不属于该议题。");
    const projectPath = normalizeProjectPath(topic.projectPath ?? "");
    if (!projectPath) throw new CouncilValidationError("议题没有绑定项目路径，不能起流水线。");
    let dispatch;
    try {
      dispatch = extractPipelineDispatch(message.content, { maxImageOutputs: this.#maxImageOutputs });
    } catch (error) {
      if (error instanceof PipelineProtocolError) throw new CouncilValidationError(error.message);
      throw error;
    }
    const existing = this.#findDispatched(projectPath, message.id);
    if (existing) return { pipeline: existing, created: false };

    const template = pipelineTemplate(dispatch.template);
    if (template.stages.length > this.#maxStages) {
      throw new CouncilValidationError(
        `模板 ${template.id} 有 ${String(template.stages.length)} 个阶段，超过 COUNCIL_PIPELINE_MAX_STAGES=${String(this.#maxStages)}。`);
    }
    // 先挑 Agent 再导入参考图：Agent 不可用时不留下无用的资产。
    const agents = await this.#resolveAgents(undefined, template.requiresPrototype);
    await this.#assertImageAgent(agents.image);
    const imported = await this.#importReferences(projectPath, dispatch.referencePaths, input.actorId);
    const referenceAssetIds = [...new Set([...(dispatch.brief.style?.references ?? []), ...imported])];
    validateInputImageAssets(this.#database, {
      projectPath,
      inputAssetIds: referenceAssetIds,
      label: "派活参考图",
      maxAssets: PIPELINE_DOCUMENT_LIMITS.maxReferences,
    });
    let brief;
    let document: PipelineDocument;
    try {
      brief = parsePipelineBrief({
        ...dispatch.brief,
        ...(referenceAssetIds.length > 0
          ? { style: { ...dispatch.brief.style, references: referenceAssetIds } }
          : {}),
      }, template.id, { maxImageOutputs: this.#maxImageOutputs });
      const constraints = brief.style?.constraints ?? [];
      document = createPipelineDocument({
        template: template.id,
        request: {
          goal: brief.goal,
          ...(constraints.length > 0 ? { constraints } : {}),
          ...(referenceAssetIds.length > 0 ? { referenceAssetIds } : {}),
          source: { topicId: topic.id, messageId: message.id },
        },
        agents,
        now: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof PipelineProtocolError) throw new CouncilValidationError(error.message);
      throw error;
    }
    const task = this.#createTask(projectPath, document, input.actorId, { numberDuplicates: true });
    const confirmedBrief = brief;
    const snapshot = await this.#store.withLock(task.id, async () => {
      // 点按钮即人工确认：brief 阶段直接记为完成，不再让 Claude 重写一遍。
      const at = new Date().toISOString();
      this.#store.write(task.id, ({ document: current }) => ({
        ...withStage(current, "brief", { status: "completed", startedAt: at, endedAt: at }, at),
        brief: confirmedBrief,
      }), { actorId: input.actorId, expectedVersion: task.version });
      return await this.#driver.startImage(task.id, input.actorId);
    });
    return { pipeline: this.#detail(snapshot), created: true };
  }

  /** 同一条消息已起过、且没取消的流水线；文档损坏的跳过。 */
  #findDispatched(projectPath: string, messageId: string): PipelineDetail | undefined {
    for (const task of this.#database.listTasks({ projectPath, kind: "pipeline", source: "direct" })) {
      try {
        const snapshot = this.#store.load(task.id);
        if (snapshot.document.request.source?.messageId === messageId && snapshot.document.status !== "cancelled") {
          return this.#detail(snapshot);
        }
      } catch {
        // 与 list 一致：损坏文档不参与匹配。
      }
    }
    return undefined;
  }

  async #importReferences(projectPath: string, paths: readonly string[], actorId: string): Promise<string[]> {
    if (paths.length === 0) return [];
    if (!this.#assets) throw new CouncilConflictError("当前服务没有接入资产库，派活尾块不能带参考图。");
    const ids: string[] = [];
    for (const relativePath of paths) {
      try {
        const { asset } = await this.#assets.importFromProject({ projectPath, relativePath, actorId });
        ids.push(asset.id);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "导入失败";
        throw new CouncilValidationError(`参考图 ${relativePath} 无法导入：${reason}`);
      }
    }
    return ids;
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
        brief = parsePipelineBrief(input.brief, document.template, { maxImageOutputs: this.#maxImageOutputs });
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
      const at = new Date().toISOString();
      this.#store.write(input.pipelineId, ({ document: current }) => ({
        ...withStage(current, "select", {
          status: "completed",
          ...(stage.startedAt ? { startedAt: stage.startedAt } : {}),
          endedAt: at,
        }, at),
        finalAssetIds: assetIds,
      }), { actorId: input.actorId, expectedVersion: input.expectedVersion });
      // final 链接在文档写入（带版本校验）成功后再加：写入失败时不能在父任务上留下孤立的 final 链接。
      for (const assetId of assetIds) this.#database.addAssetLink(assetId, "work_item", task.id, "final");
      // 先建原型子任务再收尾图像子任务：否则父任务会被短暂派生为 completed。
      if (hasPrototype) await this.#driver.startPrototype(input.pipelineId, input.actorId);
      // 选定终稿即人工验收：仍 in_progress 的出图子任务一并收尾。
      this.#store.completeImageChildren(task, { statusNote: FINAL_NOTE, actorId: input.actorId }, children);
      return this.#store.load(input.pipelineId);
    });
    return this.#detail(snapshot);
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
