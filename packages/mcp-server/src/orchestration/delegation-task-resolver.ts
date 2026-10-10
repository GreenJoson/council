/**
 * @input  依赖：CouncilDatabase（按 id 取实施项、读议题详情）、delegation-task-context
 * @output 导出：resolveDelegationTask（运行期取任务上下文）、assertDelegableTask（派发前校验，code/image 两种 kind）
 * @pos    委派任务上下文解析：议题任务沿用议题约束与已接受决策，无议题任务只用任务本身与其项目路径
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */
import type { CouncilDatabase } from "../database.js";
import { CouncilConflictError, CouncilNotFoundError, CouncilValidationError } from "../errors.js";
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

/** 派发前校验：版本、叶子、未完成、议题未关闭、项目路径；委派 kind 只开放 code/image 且须与任务 kind 一致。 */
export function assertDelegableTask(
  database: CouncilDatabase,
  input: DelegableTaskInput,
  limits: DelegationTaskLimits,
): { item: WorkItem; topicId?: string; projectPath: string } {
  const kind = input.kind ?? "code";
  if (kind !== "code" && kind !== "image") {
    throw new CouncilValidationError("当前只支持 kind 为 code 或 image 的委派。");
  }
  // 参考图只对图像委派有意义；图像侧的资产存在性与归属由 delegation-image-execution 校验。
  if (kind === "code" && (input.inputAssetIds ?? []).length > 0) {
    throw new CouncilValidationError("代码委派不支持输入资产，inputAssetIds 必须为空数组。");
  }
  const { item, detail } = loadTask(database, input.workItemId, limits);
  if (input.topicId !== undefined && item.topicId !== input.topicId) {
    throw new CouncilNotFoundError("实施项不存在。");
  }
  if (item.kind !== kind) {
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
  return { item, ...(item.topicId ? { topicId: item.topicId } : {}), projectPath };
}
