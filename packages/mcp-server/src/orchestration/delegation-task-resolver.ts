/**
 * @input  依赖：CouncilDatabase（按 id 取实施项、读议题详情）、delegation-task-context
 * @output 导出：resolveDelegationTask（运行期取任务上下文）、assertDelegableTask（派发前校验，code/image 两种 kind；
 *         prototype 任务按 code 委派）、validateInputImageAssets（输入图校验，代码与图像委派共用）
 * @pos    委派任务上下文解析：议题任务沿用议题约束与已接受决策，无议题任务只用任务本身与其项目路径
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */
import { MAX_IMAGE_INPUT_ASSETS } from "../constants.js";
import type { CouncilDatabase } from "../database.js";
import { CouncilConflictError, CouncilNotFoundError, CouncilValidationError } from "../errors.js";
import { normalizeProjectPath } from "../project-path.js";
import type { TopicDetail, WorkItem, WorkItemKind } from "../types.js";
import { delegationProjectPath, delegationTaskContext } from "./delegation-task-context.js";

export interface DelegationTaskLimits {
  messageLimit: number;
  maxContextChars: number;
}

export interface ResolvedDelegationTask {
  item: WorkItem;
  topicId?: string;
  context: string;
  contextFingerprint: string;
  projectPath: string;
}

/** 按 workItemId 取项；有议题时读取议题详情（只用于约束与已接受决策），无议题时决策为空。 */
function loadTask(database: CouncilDatabase, workItemId: string, limits: DelegationTaskLimits): {
  item: WorkItem; detail: Partial<Pick<TopicDetail, "topic">> & Pick<TopicDetail, "decisions">;
} {
  const item = database.getWorkItem(workItemId);
  if (!item.topicId) return { item, detail: { decisions: [] } };
  const detail = database.getTopicDetail(item.topicId, limits.messageLimit);
  return { item, detail };
}

/** 运行期使用：任务失效统一报“任务或项目路径已失效”，已关闭议题拒绝继续。 */
export function resolveDelegationTask(
  database: CouncilDatabase,
  workItemId: string,
  limits: DelegationTaskLimits,
): ResolvedDelegationTask {
  let loaded: ReturnType<typeof loadTask>;
  try {
    loaded = loadTask(database, workItemId, limits);
  } catch (error) {
    if (error instanceof CouncilNotFoundError) throw new Error("任务或项目路径已失效。");
    throw error;
  }
  const { item, detail } = loaded;
  if (detail.topic?.status === "closed") throw new CouncilConflictError("已关闭议题不能继续执行任务。");
  const projectPath = detail.topic?.projectPath ?? item.projectPath;
  if (!projectPath) throw new Error("任务或项目路径已失效。");
  return {
    item,
    ...(item.topicId ? { topicId: item.topicId } : {}),
    ...delegationTaskContext(detail, item, limits.maxContextChars),
    projectPath,
  };
}

export interface DelegableTaskInput {
  workItemId: string;
  /** 议题入口传入时必须与任务归属一致；任务入口可省略。 */
  topicId?: string;
  expectedVersion: number;
  kind?: WorkItemKind;
  inputAssetIds?: readonly string[];
}

/**
 * 输入资产校验（图像委派参考图与代码委派输入图共用）：≤8、不重复、存在未删除、kind=image、与任务同项目。
 * 缺失/已删除资产由仓储抛 CouncilNotFoundError（404），其余不合规为 400；label 只用于文案前缀。
 */
export function validateInputImageAssets(
  database: CouncilDatabase,
  input: { projectPath: string; inputAssetIds: readonly string[]; label: string; maxAssets?: number },
): void {
  const maximum = input.maxAssets ?? MAX_IMAGE_INPUT_ASSETS;
  if (input.inputAssetIds.length > maximum) {
    throw new CouncilValidationError(`${input.label}的输入图不能超过 ${String(maximum)} 张。`);
  }
  if (new Set(input.inputAssetIds).size !== input.inputAssetIds.length) {
    throw new CouncilValidationError(`${input.label}的输入图不能重复。`);
  }
  const project = normalizeProjectPath(input.projectPath);
  for (const assetId of input.inputAssetIds) {
    const record = database.getAssetRecord(assetId);
    if (record.asset.kind !== "image") {
      throw new CouncilValidationError(`${input.label}的输入资产必须是图像。`);
    }
    if (normalizeProjectPath(record.projectPath) !== project) {
      throw new CouncilValidationError(`${input.label}的输入资产必须属于任务所在项目。`);
    }
  }
}

/**
 * 委派 kind 与任务 kind 的对应：code→code、image→image；P3 起原型任务（kind=prototype）按 code 委派执行。
 * 其余组合一律拒绝。
 */
function delegationKindMatches(taskKind: WorkItemKind, delegationKind: WorkItemKind): boolean {
  if (taskKind === delegationKind) return true;
  return taskKind === "prototype" && delegationKind === "code";
}

/** 派发前校验：版本、叶子、未完成、议题未关闭、项目路径；委派 kind 只开放 code/image，任务 kind 须匹配（prototype 任务走 code）。 */
export function assertDelegableTask(
  database: CouncilDatabase,
  input: DelegableTaskInput,
  limits: DelegationTaskLimits,
): { item: WorkItem; topicId?: string; projectPath: string } {
  const kind = input.kind ?? "code";
  if (kind !== "code" && kind !== "image") {
    throw new CouncilValidationError("当前只支持 kind 为 code 或 image 的委派。");
  }
  const { item, detail } = loadTask(database, input.workItemId, limits);
  if (input.topicId !== undefined && item.topicId !== input.topicId) {
    throw new CouncilNotFoundError("实施项不存在。");
  }
  if (!delegationKindMatches(item.kind, kind)) {
    throw new CouncilValidationError(`任务 kind 为 ${item.kind}，不能按 ${kind} 委派。`);
  }
  if (item.version !== input.expectedVersion) {
    throw new CouncilConflictError("实施项已被更新，请刷新后重试。");
  }
  if (detail.topic?.status === "closed" || item.status === "completed"
    || database.workItemHasChildren(item.id)) {
    throw new CouncilConflictError("只能委派未关闭议题中的未完成叶子任务。");
  }
  if (detail.topic && !detail.topic.projectPath) {
    throw new CouncilValidationError("项目尚未绑定本地路径，不能执行代码任务。");
  }
  const projectPath = delegationProjectPath(detail, item);
  delegationTaskContext(detail, item, limits.maxContextChars);
  // 代码委派可带同项目输入图（如原型参考的终稿）；图像侧参考图由 validateImageDelegationRequest 同规则校验。
  if (kind === "code" && (input.inputAssetIds ?? []).length > 0) {
    validateInputImageAssets(database, { projectPath, inputAssetIds: input.inputAssetIds ?? [], label: "代码委派" });
  }
  return { item, ...(item.topicId ? { topicId: item.topicId } : {}), projectPath };
}
