/**
 * @input  依赖：PipelineStateStore（锁与文档读写）、Agent 端口（一次性只读调用、agentId→actorId）、
 *         委派端口（发起/接续/取消/查询委派、按任务列委派、终态订阅、资产拷入 `.council/in/`）、pipeline-document/prompts、
 *         delegation-image-execution 的 readImageOutputManifest（复盘只看本次图像委派入库的产物）
 * @output 导出：PipelineDriver（阶段推进：brief/review 一次性调用、图像/修订/原型委派派发、委派终态推进、
 *         失败阶段重试、取消、启动对账与停机），以及 PipelineAgentPort / PipelineDelegationPort
 * @pos    流水线状态机的唯一推进者：HTTP 用例只做校验后调用这里；
 *         一次性调用不持锁（锁内置 running → 锁外调用 → 锁内重读，已取消或 startedAt 变了就丢弃结果）；
 *         委派在锁内发起并写回 delegationId，因此终态回调总能在锁后看到对应阶段；
 *         复盘范围 = 图像委派 outputManifest.assetIds（resume 重跑不把上一次失败尝试入库的产物混进本轮），
 *         产物按清单顺序列出（资产表同毫秒入库的顺序会抖动），每张带清单标注的 deliverableId 提示；选定阶段仍可从子任务全部 output 资产里挑；
 *         brief 指令与草稿校验都带单次生图上限 maxImageOutputs（交付物合计超过即 brief_invalid，可 resume 重写）；
 *         原型阶段停在交接类失败（execution_checkpoint 等）或审核类失败（review_revision_limit / review_incomplete）时 resume 走委派接续，保留隔离工作区里的工作与审核意见，不从头重做
 *         原型委派的权限档来自配置 prototypePermission（默认 workspace_write，可放宽为 danger_full_access 让执行者自行起服务验证），
 *         接续不再传该配置值（沿用原委派已求交集的权限），接续发起失败时阶段保留原 delegationId 以便再次接续；
 *         派发在建子任务时失败把 image 阶段记成 failed，重试经 startImage 按文档状态重建首轮或修订简报
 *         修订简报以确认后的原 brief 为基线，只带本轮复盘的改法（不逐轮累加撞协议上限，goal 前缀不嵌套）；
 *         本轮 brief 里有交付物没有任何产物（执行者跳过卡住的生图调用）时，复盘结论按 revise 记录并在 missing 里列出，
 *         下一轮修订补做这些交付物；修订轮数用尽则照常进入选定、由人决定；
 *         新一轮出图派发后以 human 身份收尾被接手的旧出图子任务（委派通过后它们停在 in_progress 等人工验收，
 *         不收尾父任务会一直显示进行中），启动对账先对每条未取消流水线补做这一步再判断是否已结束；
 *         阶段失败说明优先取 AgentInvocationError.publicMessage（额度用尽等可处理的原因）
 *         非 Git 项目的原型在独立 Demo 工作区里做，通过后经 exportDemo 导出到项目 council-demos/ 并记进 document.demo；
 *         导出失败阶段记 demo_export_failed，委派仍是 approved，resume 只重新导出、不重跑原型
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { AgentInvocationError, OrchestrationConfigError, type CouncilTopicContext } from "council-orchestrator";
import { CouncilConflictError, CouncilNotFoundError } from "../errors.js";
import { logger } from "../logger.js";
import { readImageOutputManifest } from "../orchestration/delegation-image-execution.js";
import type { StartWorkItemDelegationInput } from "../orchestration/work-item-delegation-manager.js";
import type { WorkItemDelegation } from "../orchestration/work-item-delegation-store.js";
import type { PipelinePrototypePermission, WorkItem } from "../types.js";
import { parseCouncilBrief, type CouncilBrief } from "./brief-protocol.js";
import {
  buildRevisionBrief,
  currentStage,
  extractCouncilBrief,
  isPipelineFinished,
  parseCouncilReview,
  PipelineProtocolError,
  stageOf,
  withStage,
  type PipelineDocument,
  type PipelineStage,
} from "./pipeline-document.js";
import {
  renderBriefInstruction,
  renderPrototypeDetails,
  renderReviewInstruction,
} from "./pipeline-prompts.js";
import type { PipelineSnapshot, PipelineStateStore } from "./pipeline-state.js";
import type { PipelineStageId } from "./templates.js";

// ┌─────────────────────────────────────────────────────────────┐
// │ 端口与常量                                                  │
// └─────────────────────────────────────────────────────────────┘

export interface PipelineAgentPort {
  invokeOneShot(input: {
    adapterId: string;
    instruction: string;
    context: CouncilTopicContext;
    contextMessage: string;
    invocationPrefix: string;
    purpose: string;
    signal?: AbortSignal;
  }): Promise<{ actorId: string; content: string }>;
  /** Agent 定义上的 actorId；Agent 已删除时 undefined（写入回落到 human）。 */
  actorIdOf(agentId: string): string | undefined;
}

export interface PipelineDelegationPort {
  start(input: StartWorkItemDelegationInput): Promise<WorkItemDelegation>;
  /** 从停在交接点的代码委派接续（新委派带 resumedFromId）；图像委派不支持。 */
  resume(
    id: string,
    expectedVersion: number,
    requestedPermission?: WorkItemDelegation["permissionProfile"],
  ): Promise<WorkItemDelegation>;
  cancel(id: string): WorkItemDelegation;
  get(id: string): WorkItemDelegation | undefined;
  /** 某个任务上的全部委派；删除流水线前确认没有活动委派。 */
  listForWorkItem(workItemId: string): WorkItemDelegation[];
  onSettled(listener: (delegation: WorkItemDelegation) => void | Promise<void>): () => void;
  /** 已通过的原型委派若在独立 Demo 工作区（非 Git 项目），导出到项目 council-demos/；Git 项目返回 undefined。 */
  exportDemo(delegationId: string, name: string): Promise<{ path: string; fileCount: number } | undefined>;
  stageProjectInputs(
    root: string,
    assetIds: readonly string[],
    signal: AbortSignal,
  ): Promise<Array<{ assetId: string; relativePath: string }>>;
}

type OneShotStage = "brief" | "review";

const TERMINAL_DELEGATION = new Set<WorkItemDelegation["status"]>(["approved", "failed", "cancelled"]);
/**
 * 图像委派一律 workspace_write（只写 `.council/out`）；原型默认也是这一档，可经配置放宽为 danger_full_access
 * 让执行者自行起服务与浏览器验证，实际权限仍与执行 Agent 的权限档取交集。
 */
const IMAGE_DELEGATION_PERMISSION = "workspace_write" as const;
/**
 * 代码委派把工作存在隔离工作区后停下的失败码：重试时接续而不是重新委派。
 * 审核类失败（修订轮次用尽、审核未确认补查）同样保留了提交与审核意见，接续时执行者按上次审核继续改，不从头重做。
 */
const CHECKPOINT_FAILURES = new Set([
  "execution_checkpoint",
  "execution_time_limit",
  "execution_segment_limit",
  "execution_no_progress",
  "review_revision_limit",
  "review_incomplete",
]);
const MAX_ERROR_MESSAGE = 1_000;
const HUMAN = "human";

function now(): string {
  return new Date().toISOString();
}

/**
 * 阶段失败说明：Agent 调用错误优先用适配器脱敏后的 publicMessage（如额度用尽、登录失效），
 * message 里只有「内部原因未公开」之类的泛化说明，界面看不出该怎么处理。
 */
function errorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof AgentInvocationError && error.publicMessage
    ? error.publicMessage
    : error instanceof Error ? error.message : String(error);
  const text = raw.trim() || fallback;
  return text.length <= MAX_ERROR_MESSAGE ? text : `${text.slice(0, MAX_ERROR_MESSAGE - 1)}…`;
}

/** Agent 调用失败码：不可用/不存在 → agent_unavailable；协议尾块问题 → 协议码；其余 → agent_failed。 */
function oneShotErrorCode(error: unknown): string {
  if (error instanceof PipelineProtocolError) return error.code;
  if (error instanceof OrchestrationConfigError) return "agent_unavailable";
  return "agent_failed";
}

/** 委派发起失败码：Agent 配置问题 → agent_unavailable；其余（任务状态、资产校验等）→ delegation_rejected。 */
function startErrorCode(error: unknown): string {
  return error instanceof OrchestrationConfigError ? "agent_unavailable" : "delegation_rejected";
}

function stageFields(stage: PipelineStage): Omit<PipelineStage, "id"> {
  const { id: _id, ...rest } = stage;
  return rest;
}

// ┌─────────────────────────────────────────────────────────────┐
// │ 驱动器                                                      │
// └─────────────────────────────────────────────────────────────┘

export class PipelineDriver {
  readonly #store: PipelineStateStore;
  readonly #agents: PipelineAgentPort;
  readonly #delegations: PipelineDelegationPort;
  readonly #maxRevisions: number;
  /** 单次图像委派能入库的张数；brief 指令告知模型，草稿与人工确认都按它校验。 */
  readonly #maxImageOutputs: number;
  /** 原型代码委派请求的权限档（COUNCIL_PIPELINE_PROTOTYPE_PERMISSION）。 */
  readonly #prototypePermission: PipelinePrototypePermission;
  /** pipelineId → 正在进行的一次性调用；取消与停机时中止。 */
  readonly #inflight = new Map<string, AbortController>();
  #unsubscribe: (() => void) | undefined;
  #closed = false;

  constructor(deps: {
    store: PipelineStateStore;
    agents: PipelineAgentPort;
    delegations: PipelineDelegationPort;
    maxRevisions: number;
    maxImageOutputs: number;
    prototypePermission: PipelinePrototypePermission;
  }) {
    this.#store = deps.store;
    this.#agents = deps.agents;
    this.#delegations = deps.delegations;
    this.#maxRevisions = deps.maxRevisions;
    this.#maxImageOutputs = deps.maxImageOutputs;
    this.#prototypePermission = deps.prototypePermission;
  }

  /** 订阅委派终态并做一次启动对账；须在委派管理器初始化（含恢复）之后调用。 */
  async initialize(): Promise<void> {
    this.#unsubscribe ??= this.#delegations.onSettled(async (delegation) => {
      await this.#handleSettled(delegation);
    });
    await this.#reconcile();
  }

  /** 停机：不再写文档，中止一次性调用；阶段保持 running，下次启动对账标为 interrupted。 */
  shutdown(): void {
    this.#closed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    for (const controller of this.#inflight.values()) controller.abort(new Error("服务停止。"));
    this.#inflight.clear();
  }

  #actor(agentId: string | undefined): string {
    return (agentId && this.#agents.actorIdOf(agentId)) || HUMAN;
  }

  // ---- 以下公开方法：调用方须持有该流水线的锁（store.withLock） ----

  /** 置 brief 阶段 running 并在锁外发起一次性调用。 */
  startBrief(pipelineId: string, actorId: string): PipelineSnapshot {
    return this.#launchOneShot(pipelineId, "brief", actorId);
  }

  /**
   * 图像阶段尚无子任务时按文档状态派发：首轮用确认后的 brief 与请求参考图；最近一次复盘为 revise 且已计入
   * 修订轮数（修订派发在建子任务时失败、重试走到这里）则重建修订简报，不能退回原 brief 把改法丢掉。
   */
  async startImage(pipelineId: string, actorId: string): Promise<PipelineSnapshot> {
    const { document } = this.#store.load(pipelineId);
    if (!document.brief) throw new CouncilConflictError("流水线尚未确认 brief。");
    const lastReview = document.reviews[document.reviews.length - 1];
    if (lastReview?.verdict === "revise" && document.revisionCount > 0) {
      const revision = buildRevisionBrief(document.brief, lastReview);
      return await this.#dispatchImage(pipelineId, {
        brief: revision.brief,
        inputAssetIds: revision.inputAssetIds,
        title: `生图修订 第${String(document.revisionCount)}轮`,
        actorId,
      });
    }
    return await this.#dispatchImage(pipelineId, {
      brief: document.brief,
      inputAssetIds: document.request.referenceAssetIds ?? [],
      title: "生图 第1轮",
      actorId,
    });
  }

  /** 选定终稿后的原型阶段：建原型子任务并发起 kind=code 委派（completionPolicy human）。 */
  async startPrototype(pipelineId: string, actorId: string): Promise<PipelineSnapshot> {
    const { task, document } = this.#store.load(pipelineId);
    if (!document.brief || !document.agents.prototype || !task.projectPath) {
      throw new CouncilConflictError("流水线缺少原型阶段所需的 brief 或 Agent。");
    }
    const child = this.#store.database.createPipelineChildAsActor({
      parentId: pipelineId,
      projectPath: task.projectPath,
      title: "原型实现",
      details: renderPrototypeDetails(document.request.goal, document.brief),
      kind: "prototype",
      actorId,
    });
    return await this.#startStageDelegation(pipelineId, "prototype", child.id, actorId, document.finalAssetIds ?? []);
  }

  /**
   * 只重跑当前 failed 阶段：brief/review 重新调用；image 为原子任务重新委派，已入库资产不动；
   * prototype 停在交接点时接续上一次委派（保留工作区里的代码），其余失败重新委派。
   */
  async retryCurrentStage(pipelineId: string, actorId: string): Promise<PipelineSnapshot> {
    const { document } = this.#store.load(pipelineId);
    const stage = currentStage(document);
    if (stage.status !== "failed") throw new CouncilConflictError("当前阶段没有失败，无需重试。");
    if (stage.id === "brief" || stage.id === "review") return this.#launchOneShot(pipelineId, stage.id, actorId);
    if (stage.id === "image") {
      if (!stage.workItemId) return await this.startImage(pipelineId, actorId);
      const previous = stage.delegationId ? this.#delegations.get(stage.delegationId) : undefined;
      const inputs = previous?.inputAssetIds ?? this.#imageInputsFallback(document);
      return await this.#startStageDelegation(pipelineId, "image", stage.workItemId, actorId, inputs);
    }
    if (stage.id === "prototype") {
      if (!stage.workItemId) return await this.startPrototype(pipelineId, actorId);
      const previous = stage.delegationId ? this.#delegations.get(stage.delegationId) : undefined;
      // 原型已通过、只是 Demo 没导出成功：重新导出即可，不重跑。
      if (previous?.status === "approved") {
        await this.#completePrototype(pipelineId, stage, previous, actorId);
        return this.#store.load(pipelineId);
      }
      const resumable = previous?.kind === "code" && previous.status === "failed"
        && CHECKPOINT_FAILURES.has(previous.failureCode ?? "");
      return await this.#startStageDelegation(
        pipelineId, "prototype", stage.workItemId, actorId, document.finalAssetIds ?? [],
        resumable ? previous.id : undefined);
    }
    throw new CouncilConflictError("当前阶段不可重试。");
  }

  /** 取消：中止一次性调用与运行中的委派；当前阶段 skipped（error.code=cancelled），后续阶段保持 pending。 */
  cancel(pipelineId: string, actorId: string, expectedVersion: number): PipelineSnapshot {
    const { task, document } = this.#store.load(pipelineId);
    this.#store.assertVersion(task, expectedVersion);
    if (document.status === "cancelled") throw new CouncilConflictError("流水线已取消。");
    if (isPipelineFinished(document)) throw new CouncilConflictError("流水线已结束，无法取消。");
    this.#inflight.get(pipelineId)?.abort(new Error("流水线已取消。"));
    this.#inflight.delete(pipelineId);
    const stage = currentStage(document);
    const delegation = stage.delegationId ? this.#delegations.get(stage.delegationId) : undefined;
    if (delegation && !TERMINAL_DELEGATION.has(delegation.status)) {
      try {
        this.#delegations.cancel(delegation.id);
      } catch (error) {
        logger.warn("pipeline", `取消流水线委派失败：${pipelineId}`, error);
      }
    }
    const at = now();
    return this.#store.write(pipelineId, ({ document: current }) => ({
      ...withStage(current, current.currentStageId, {
        ...stageFields(currentStage(current)),
        status: "skipped",
        endedAt: at,
        error: { code: "cancelled", message: "流水线已取消。" },
      }, at),
      status: "cancelled",
    }), { actorId, expectedVersion });
  }

  // ┌───────────────────────────────────────────────────────────┐
  // │ 一次性调用（brief / review）                              │
  // └───────────────────────────────────────────────────────────┘

  #launchOneShot(pipelineId: string, stageId: OneShotStage, actorId: string): PipelineSnapshot {
    const startedAt = now();
    const snapshot = this.#store.write(pipelineId, ({ document }) => ({
      ...withStage(document, stageId, { status: "running", startedAt }, startedAt),
      currentStageId: stageId,
    }), { actorId });
    void this.#runOneShot(pipelineId, stageId, startedAt).catch((error: unknown) => {
      // 取消后被删除的流水线：调用结果没有地方写，丢弃即可。
      if (error instanceof CouncilNotFoundError) return;
      logger.error("pipeline", `流水线一次性调用收尾失败：${pipelineId}`, error);
    });
    return snapshot;
  }

  async #runOneShot(pipelineId: string, stageId: OneShotStage, startedAt: string): Promise<void> {
    const controller = new AbortController();
    this.#inflight.get(pipelineId)?.abort(new Error("被新的调用取代。"));
    this.#inflight.set(pipelineId, controller);
    let outcome: { ok: true; actorId: string; content: string; review?: ReviewInputs }
      | { ok: false; code: string; message: string };
    try {
      const { task, document } = this.#store.load(pipelineId);
      if (!task.projectPath) throw new CouncilConflictError("流水线缺少项目路径。");
      const review = stageId === "review" ? this.#reviewInputs(task, document) : undefined;
      const staged = await this.#delegations.stageProjectInputs(
        task.projectPath,
        review ? review.assetIds : document.request.referenceAssetIds ?? [],
        controller.signal,
      );
      const round = document.reviews.length + 1;
      const instruction = review
        ? renderReviewInstruction({
          round,
          request: document.request,
          brief: review.brief,
          outputs: staged.map((item) => {
            const prompt = review.prompts.get(item.assetId);
            const deliverableId = review.deliverableIds.get(item.assetId);
            return { ...item, ...(prompt ? { prompt } : {}), ...(deliverableId ? { deliverableId } : {}) };
          }),
        })
        : renderBriefInstruction({
          template: document.template,
          request: document.request,
          references: staged,
          maxImageOutputs: this.#maxImageOutputs,
        });
      const context: CouncilTopicContext = {
        topicId: task.id,
        title: task.title,
        question: document.request.goal,
        constraints: document.request.constraints ?? [],
        projectPath: task.projectPath,
        messages: [],
      };
      const result = await this.#agents.invokeOneShot({
        adapterId: document.agents.brief,
        instruction,
        context,
        contextMessage: review
          ? `设计流水线「${task.title}」第 ${String(round)} 轮复盘：只读查看产物并输出 council-review。`
          : `设计流水线「${task.title}」brief 撰写：只读整理需求并输出 council-brief。`,
        invocationPrefix: `pipeline_${stageId}`,
        purpose: stageId === "brief" ? "流水线 brief" : "流水线复盘",
        signal: controller.signal,
      });
      outcome = { ok: true, actorId: result.actorId, content: result.content, ...(review ? { review } : {}) };
    } catch (error) {
      outcome = { ok: false, code: oneShotErrorCode(error), message: errorMessage(error, "Agent 调用失败。") };
    } finally {
      if (this.#inflight.get(pipelineId) === controller) this.#inflight.delete(pipelineId);
    }
    if (this.#closed) return;
    await this.#store.withLock(pipelineId, async () => {
      const { document } = this.#store.load(pipelineId);
      const stage = stageOf(document, stageId);
      if (document.status === "cancelled" || stage?.status !== "running" || stage.startedAt !== startedAt) return;
      if (!outcome.ok) {
        this.#failStage(pipelineId, stageId, outcome.code, outcome.message, HUMAN);
        return;
      }
      if (stageId === "brief") {
        this.#applyBrief(pipelineId, outcome.content, outcome.actorId);
        return;
      }
      if (outcome.review) await this.#applyReview(pipelineId, outcome.content, outcome.review, outcome.actorId);
    });
  }

  #applyBrief(pipelineId: string, content: string, actorId: string): void {
    const { document } = this.#store.load(pipelineId);
    let brief: CouncilBrief;
    try {
      brief = extractCouncilBrief(content, document.template, { maxImageOutputs: this.#maxImageOutputs });
    } catch (error) {
      this.#failStage(pipelineId, "brief", oneShotErrorCode(error), errorMessage(error, "brief 无效。"), actorId);
      return;
    }
    const at = now();
    this.#store.write(pipelineId, ({ document: current }) => ({
      ...withStage(current, "brief", {
        status: "waiting_human",
        ...(stageOf(current, "brief")?.startedAt ? { startedAt: stageOf(current, "brief")?.startedAt } : {}),
      }, at),
      draftBrief: brief,
    }), { actorId });
  }

  /**
   * 复盘输入：当前图像子任务的 brief 与本次委派入库的 output 资产。
   * resume 对同一子任务重新委派，而上一次失败尝试（清单无效）已入库的产物仍挂在子任务上：
   * 只按委派 outputManifest.assetIds 圈定本轮，复盘才不会对着不属于本轮 brief 的图给结论；
   * 没有清单记录（旧委派）时退回子任务全部 output 资产。
   */
  #reviewInputs(task: WorkItem, document: PipelineDocument): ReviewInputs {
    const imageStage = stageOf(document, "image");
    if (!imageStage?.workItemId || !task.projectPath) {
      throw new PipelineProtocolError("review_invalid", "没有可复盘的图像子任务。");
    }
    const child = this.#store.database.getWorkItem(imageStage.workItemId);
    const brief = parseCouncilBrief(child.brief);
    const linked = this.#store.outputAssets(task.projectPath, child.id);
    const manifest = imageStage.delegationId
      ? readImageOutputManifest(this.#delegations.get(imageStage.delegationId)?.outputManifest)
      : undefined;
    // 按清单顺序（同交付物声明顺序）列给复盘者：资产表按入库时间倒序、同一毫秒入库的几张再按 id 排，顺序会抖动。
    const byId = new Map(linked.map((asset) => [asset.id, asset] as const));
    const assets = manifest ? manifest.assetIds.flatMap((id) => byId.get(id) ?? []) : linked;
    if (assets.length === 0) throw new PipelineProtocolError("review_invalid", "本轮没有可复盘的产物。");
    return {
      childId: child.id,
      brief,
      assetIds: assets.map((asset) => asset.id),
      prompts: new Map(assets.flatMap((asset) => asset.prompt ? [[asset.id, asset.prompt] as const] : [])),
      deliverableIds: manifest?.deliverableIds ?? new Map<string, string>(),
    };
  }

  async #applyReview(pipelineId: string, content: string, inputs: ReviewInputs, actorId: string): Promise<void> {
    let review;
    try {
      review = parseCouncilReview(content, { brief: inputs.brief, assetIds: inputs.assetIds });
    } catch (error) {
      this.#failStage(pipelineId, "review", oneShotErrorCode(error), errorMessage(error, "复盘无效。"), actorId);
      return;
    }
    const at = now();
    const { document } = this.#store.load(pipelineId);
    const round = document.reviews.length + 1;
    // 复盘者只对着产物逐张下结论，看不到「这张根本没出」：按清单标注与复盘条目算出本轮 brief 里没有产物的交付物，
    // 有缺失就不能算通过，记进 missing 让下一轮修订补做（startImage 重建修订简报时也从记录里读回）。
    const covered = new Set([...inputs.deliverableIds.values(), ...review.items.map((item) => item.deliverableId)]);
    const missing = inputs.brief.deliverables.map((item) => item.id).filter((id) => !covered.has(id));
    const verdict = missing.length > 0 ? "revise" : review.verdict;
    const record = { round, verdict, items: review.items, ...(missing.length > 0 ? { missing } : {}) };
    const exhausted = verdict === "revise" && document.revisionCount >= this.#maxRevisions;
    if (verdict === "pass" || exhausted) {
      this.#store.write(pipelineId, ({ document: current }) => {
        const reviewStage = stageOf(current, "review");
        const next = withStage(current, "review", {
          status: "completed",
          ...(reviewStage?.startedAt ? { startedAt: reviewStage.startedAt } : {}),
          endedAt: at,
        }, at);
        return {
          ...withStage(next, "select", { status: "waiting_human", startedAt: at }, at),
          currentStageId: "select",
          reviews: [...current.reviews, record],
          ...(exhausted
            ? { notice: `已达修订上限（${String(this.#maxRevisions)} 轮），复盘仍有不合格或缺少产物的交付物，请人工挑选终稿。` }
            : {}),
        };
      }, { actorId });
      return;
    }
    const revisionCount = document.revisionCount + 1;
    // 以确认后的原 brief 为基线，而不是上一轮修订简报：否则每轮改法都累加进 constraints，撞到协议上限后
    // 最新一轮的改法会被整轮丢弃，goal 的「【修订】…原目标：」前缀也会层层嵌套。
    const revision = buildRevisionBrief(document.brief ?? inputs.brief, record);
    this.#store.write(pipelineId, ({ document: current }) => ({
      ...withStage(current, "review", { status: "pending" }, at),
      reviews: [...current.reviews, record],
      revisionCount,
    }), { actorId });
    await this.#dispatchImage(pipelineId, {
      brief: revision.brief,
      inputAssetIds: revision.inputAssetIds,
      title: `生图修订 第${String(revisionCount)}轮`,
      actorId,
    });
  }

  // ┌───────────────────────────────────────────────────────────┐
  // │ 委派派发与终态                                            │
  // └───────────────────────────────────────────────────────────┘

  async #dispatchImage(
    pipelineId: string,
    input: { brief: CouncilBrief; inputAssetIds: readonly string[]; title: string; actorId: string },
  ): Promise<PipelineSnapshot> {
    const { task } = this.#store.load(pipelineId);
    if (!task.projectPath) throw new CouncilConflictError("流水线缺少项目路径。");
    let child: WorkItem;
    try {
      child = this.#store.database.createPipelineChildAsActor({
        parentId: pipelineId,
        projectPath: task.projectPath,
        title: input.title,
        details: input.brief.goal,
        kind: "image",
        brief: { ...input.brief },
        actorId: input.actorId,
      });
    } catch (error) {
      // 调用方先把上一阶段写成 completed/pending 才派发：建子任务失败（actor 停用、标题重复等）若不记成
      // image 失败，流水线会停在既不能确认简报也不能重试的状态；记失败后重试经 startImage 重新建子任务。
      const at = now();
      logger.warn("pipeline", `流水线 image 阶段创建子任务失败：${pipelineId}`, error);
      return this.#store.write(pipelineId, ({ document: current }) => ({
        ...withStage(current, "image", {
          status: "failed",
          startedAt: at,
          endedAt: at,
          error: { code: startErrorCode(error), message: errorMessage(error, "图像子任务创建失败。") },
        }, at),
        currentStageId: "image",
      }), { actorId: input.actorId });
    }
    const snapshot = await this.#startStageDelegation(pipelineId, "image", child.id, input.actorId, input.inputAssetIds);
    return this.#retireSupersededImages(pipelineId) > 0 ? this.#store.load(pipelineId) : snapshot;
  }

  /**
   * 收尾被接手的出图轮：image 阶段当前指向的子任务是在办轮，其余仍 in_progress 的出图子任务以 human 身份标完成，
   * 产物与链接不动，选定终稿时照样能挑。失败只记日志——下一轮已经派出，不能因收尾失败把复盘判成失败；
   * 漏掉的由下次启动对账补上。
   */
  #retireSupersededImages(pipelineId: string): number {
    try {
      const { task, document } = this.#store.load(pipelineId);
      const currentId = stageOf(document, "image")?.workItemId;
      if (document.status === "cancelled" || !currentId) return 0;
      const title = this.#store.database.getWorkItem(currentId).title;
      return this.#store.completeImageChildren(task, {
        keepWorkItemId: currentId,
        statusNote: `已由「${title}」接手，本轮产物保留在资产库，可在选定终稿时挑选。`,
        actorId: HUMAN,
      });
    } catch (error) {
      logger.warn("pipeline", `流水线收尾旧出图子任务失败：${pipelineId}`, error);
      return 0;
    }
  }

  /**
   * 为子任务发起（或重新发起）委派并把阶段置 running；发起失败则阶段 failed（可 resume）。
   * 传入 resumeFromId 时改为接续该委派（沿用其 kind 与输入图），只用于停在交接点的原型代码委派。
   */
  async #startStageDelegation(
    pipelineId: string,
    stageId: "image" | "prototype",
    childId: string,
    actorId: string,
    inputAssetIds: readonly string[],
    resumeFromId?: string,
  ): Promise<PipelineSnapshot> {
    const { document } = this.#store.load(pipelineId);
    const startedAt = now();
    try {
      const child = this.#store.database.getWorkItem(childId);
      const permission = stageId === "image" ? IMAGE_DELEGATION_PERMISSION : this.#prototypePermission;
      const base = {
        workItemId: childId,
        expectedVersion: child.version,
        requestedPermission: permission,
        inputAssetIds: [...inputAssetIds],
      };
      const prototype = document.agents.prototype;
      // 接续不再传配置里的原型权限：首次发起已按执行者上限求过交集，再传配置值会被判「超过上限」而失败；
      // 传 undefined 由委派管理器沿用原委派权限。
      const delegation = resumeFromId
        ? await this.#delegations.resume(resumeFromId, child.version)
        : await this.#delegations.start(stageId === "image"
          ? { ...base, kind: "image", executorAgentId: document.agents.image }
          : {
            ...base,
            kind: "code",
            executorAgentId: prototype?.executor ?? document.agents.image,
            supervisorAgentId: prototype?.supervisor ?? document.agents.brief,
            completionPolicy: "human",
          });
      return this.#store.write(pipelineId, ({ document: current }) => ({
        ...withStage(current, stageId, {
          status: "running", workItemId: childId, delegationId: delegation.id, startedAt,
        }, startedAt),
        currentStageId: stageId,
      }), { actorId });
    } catch (error) {
      const at = now();
      logger.warn("pipeline", `流水线 ${stageId} 阶段发起委派失败：${pipelineId}`, error);
      return this.#store.write(pipelineId, ({ document: current }) => ({
        ...withStage(current, stageId, {
          status: "failed",
          workItemId: childId,
          // 接续失败时保留原委派 id：下次重试仍能从交接点接续，而不是新开委派丢掉工作区里的检查点。
          ...(resumeFromId ? { delegationId: resumeFromId } : {}),
          startedAt,
          endedAt: at,
          error: { code: startErrorCode(error), message: errorMessage(error, "委派发起失败。") },
        }, at),
        currentStageId: stageId,
      }), { actorId });
    }
  }

  async #handleSettled(delegation: WorkItemDelegation): Promise<void> {
    if (this.#closed) return;
    let child: WorkItem;
    try {
      child = this.#store.database.getWorkItem(delegation.workItemId);
    } catch {
      return;
    }
    if (child.source !== "pipeline" || !child.parentId) return;
    const pipelineId = child.parentId;
    try {
      await this.#store.withLock(pipelineId, async () => {
        await this.#applySettled(pipelineId, delegation);
      });
    } catch (error) {
      logger.error("pipeline", `流水线推进失败：${pipelineId}`, error);
    }
  }

  /** 锁内：委派终态推进对应阶段；阶段已不再指向该委派（被重试或取消）就忽略。 */
  async #applySettled(pipelineId: string, delegation: WorkItemDelegation): Promise<void> {
    const { document } = this.#store.load(pipelineId);
    if (document.status === "cancelled") return;
    const stage = document.stages.find((item) => item.delegationId === delegation.id && item.status === "running");
    if (!stage || (stage.id !== "image" && stage.id !== "prototype")) return;
    const actorId = this.#actor(delegation.executorAgentId);
    if (delegation.status !== "approved") {
      const code = delegation.failureCode ?? (delegation.status === "cancelled" ? "delegation_cancelled" : "delegation_failed");
      const message = errorMessage(delegation.error ?? "", "委派未完成。");
      // 交接类失败不是白干：工作区里的代码还在，提示“恢复”会接续而不是重做。
      const hint = stage.id === "prototype" && CHECKPOINT_FAILURES.has(code) ? "「恢复」将从交接点接续，已保留的改动不丢。" : "";
      this.#failStage(pipelineId, stage.id, code, `${message}${hint}`, actorId);
      return;
    }
    if (stage.id === "prototype") {
      await this.#completePrototype(pipelineId, stage, delegation, actorId);
      return;
    }
    const at = now();
    this.#store.write(pipelineId, ({ document: current }) =>
      withStage(current, stage.id, { ...stageFields(stage), status: "completed", endedAt: at }, at), { actorId });
    this.#launchOneShot(pipelineId, "review", actorId);
  }

  /** 锁内：原型通过 → 非 Git 项目先导出 Demo（同一次通过只导出一次），再把阶段置 completed。 */
  async #completePrototype(
    pipelineId: string,
    stage: PipelineStage,
    delegation: WorkItemDelegation,
    actorId: string,
  ): Promise<void> {
    const { task, document } = this.#store.load(pipelineId);
    let demo = document.demo?.delegationId === delegation.id ? document.demo : undefined;
    if (!demo) {
      try {
        const exported = await this.#delegations.exportDemo(delegation.id, task.title);
        if (exported) demo = { ...exported, delegationId: delegation.id };
      } catch (error) {
        logger.warn("pipeline", `流水线 Demo 导出失败：${pipelineId}`, error);
        const reason = errorMessage(error, "导出失败。");
        this.#failStage(pipelineId, "prototype", "demo_export_failed",
          `原型已通过审核，但 Demo 导出到项目目录失败：${reason}「恢复」会重新导出，不重跑原型。`, actorId);
        return;
      }
    }
    const at = now();
    const { error: _error, ...fields } = stageFields(stage);
    this.#store.write(pipelineId, ({ document: current }) => ({
      ...withStage(current, "prototype", { ...fields, status: "completed", endedAt: at }, at),
      ...(demo ? { demo } : {}),
    }), { actorId });
  }

  #failStage(pipelineId: string, stageId: PipelineStageId, code: string, message: string, actorId: string): void {
    const at = now();
    this.#store.write(pipelineId, ({ document }) => {
      const stage = stageOf(document, stageId);
      return {
        ...withStage(document, stageId, {
          ...(stage ? stageFields(stage) : {}),
          status: "failed",
          endedAt: at,
          error: { code: code.slice(0, 64), message: message.trim() || "阶段失败。" },
        }, at),
        currentStageId: stageId,
      };
    }, { actorId });
  }

  /** 无 delegationId 的图像阶段重试时的输入：首轮用请求参考图，修订轮按最近一次复盘重算。 */
  #imageInputsFallback(document: PipelineDocument): readonly string[] {
    const last = document.reviews.at(-1);
    if (document.revisionCount === 0 || !last || !document.brief) return document.request.referenceAssetIds ?? [];
    return buildRevisionBrief(document.brief, last).inputAssetIds;
  }

  /**
   * 启动对账：先收尾被接手的旧出图子任务（修复早先版本留下的「进行中」）；上次进程停在 running 的阶段——
   * 一次性调用必然已丢失，标 interrupted；委派已到终态（终态回调发生在订阅之前）就按终态推进；委派仍在跑则等回调。
   */
  async #reconcile(): Promise<void> {
    for (const parent of this.#store.database.listPipelineParents()) {
      try {
        await this.#store.withLock(parent.id, async () => {
          this.#retireSupersededImages(parent.id);
          const { document } = this.#store.load(parent.id);
          if (isPipelineFinished(document)) return;
          const stage = currentStage(document);
          if (stage.status !== "running") return;
          const delegation = stage.delegationId ? this.#delegations.get(stage.delegationId) : undefined;
          if (stage.id === "brief" || stage.id === "review" || !delegation) {
            this.#failStage(parent.id, stage.id, "interrupted", "服务重启中断了该阶段，请重试。", HUMAN);
            return;
          }
          if (TERMINAL_DELEGATION.has(delegation.status)) await this.#applySettled(parent.id, delegation);
        });
      } catch (error) {
        logger.warn("pipeline", `流水线启动对账跳过：${parent.id}`, error);
      }
    }
  }
}

interface ReviewInputs {
  childId: string;
  brief: CouncilBrief;
  /** 本轮复盘的产物：只含本次图像委派入库的资产。 */
  assetIds: string[];
  prompts: Map<string, string>;
  /** assetId → 清单标注的 deliverableId，给复盘者作提示；清单漏报收回的产物没有。 */
  deliverableIds: Map<string, string>;
}
