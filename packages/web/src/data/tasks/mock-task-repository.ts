/**
 * @input  依赖：mock-tasks 夹具、mock-data Actor 快照、workspace-mapper 行映射、council-brief 校验与浏览器随机 ID
 * @output 导出：MockTaskRepository（内存任务与任务委派的同构原型实现）
 * @pos    mock 模式任务仓储：排序、标题去重、乐观版本、brief 校验与 P2 委派约束（code/image、输入资产上限、
 *         图像委派无审核者）与服务端契约保持同一语义；输入资产是否同项目、kind=image 由服务端校验，mock 不模拟
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { ApiWorkItem } from "../api-types";
import { validateCouncilBrief } from "./council-brief";
import { mockActorSnapshot } from "../mock-data";
import { mapWorkItem } from "../workspace-mapper";
import { createMockTaskFixtures, MOCK_TASK_PROJECT_PATH, type MockTaskFixtures } from "./mock-tasks";
import type { TaskRepository } from "./task-repository";
import type { CouncilWorkItem } from "../../types/council";
import type {
  StartTaskDelegationInput,
  WorkItemDelegation,
} from "../../types/orchestration";
import type {
  CreateTaskInput,
  TaskDetail,
  TaskListFilter,
  UpdateTaskInput,
} from "../../types/tasks";

const ACTIVE_DELEGATION_STATUSES: readonly WorkItemDelegation["status"][] = [
  "queued", "executing", "reviewing", "changes_requested",
];
const RESUMABLE_DELEGATION_STATUSES: readonly WorkItemDelegation["status"][] = [
  "failed", "cancelled",
];
/** 契约：图像委派的输入资产最多 8 个。 */
const MAX_INPUT_ASSETS = 8;
const MOCK_TOPIC_SUMMARY = { id: "topic-idempotency", title: "支付回调幂等方案", status: "open" } as const;

export interface MockTaskRepositoryOptions {
  projectPath?: string;
  /** 测试可注入自定义夹具；默认使用 createMockTaskFixtures()。 */
  fixtures?: MockTaskFixtures;
}

export class MockTaskRepository implements TaskRepository {
  readonly #projectPath: string;
  readonly #tasks: ApiWorkItem[];
  readonly #delegations: WorkItemDelegation[];

  constructor(options: MockTaskRepositoryOptions = {}) {
    const fixtures = structuredClone(options.fixtures ?? createMockTaskFixtures());
    this.#projectPath = options.projectPath ?? MOCK_TASK_PROJECT_PATH;
    this.#tasks = fixtures.tasks;
    this.#delegations = fixtures.delegations;
  }

  async listTasks(filter: TaskListFilter = {}): Promise<CouncilWorkItem[]> {
    return this.#tasks
      .filter((item) => item.projectPath === this.#projectPath)
      .filter((item) => !filter.status || item.status === filter.status)
      .filter((item) => !filter.kind || item.kind === filter.kind)
      .filter((item) => !filter.source || item.source === filter.source)
      // 与服务端 ORDER BY priority DESC, updated_at DESC 一致。
      .sort((left, right) =>
        right.priority - left.priority || right.updatedAt.localeCompare(left.updatedAt))
      .map(mapWorkItem);
  }

  async getTask(taskId: string): Promise<TaskDetail> {
    const item = this.#requireTask(taskId);
    return {
      task: mapWorkItem(item),
      ...(item.topicId === MOCK_TOPIC_SUMMARY.id ? { topic: { ...MOCK_TOPIC_SUMMARY } } : {}),
      delegations: this.#delegationsOf(taskId),
    };
  }

  async createTask(input: CreateTaskInput): Promise<CouncilWorkItem> {
    const title = input.title.trim();
    if (!title) {
      throw new Error("任务标题不能为空。");
    }
    const priority = input.priority ?? 0;
    if (!Number.isSafeInteger(priority)) {
      throw new Error("任务优先级必须是整数。");
    }
    const normalized = title.toLowerCase();
    if (this.#tasks.some((item) =>
      item.projectPath === this.#projectPath && item.title.toLowerCase() === normalized)) {
      throw new Error("同一项目下已存在同名任务。");
    }
    const now = new Date().toISOString();
    const snapshot = mockActorSnapshot("human");
    const created: ApiWorkItem = {
      id: `work_item_${crypto.randomUUID()}`,
      kind: input.kind ?? "code",
      source: "direct",
      priority,
      projectPath: this.#projectPath,
      ...(input.brief ? { brief: structuredClone(input.brief) } : {}),
      title,
      details: input.details?.trim() ?? "",
      status: "pending",
      sortOrder: 0,
      origin: "manual",
      version: 1,
      createdByActorId: "human",
      createdBySnapshot: snapshot,
      updatedByActorId: "human",
      updatedBySnapshot: snapshot,
      createdAt: now,
      updatedAt: now,
    };
    this.#tasks.push(created);
    return mapWorkItem(created);
  }

  async updateTask(input: UpdateTaskInput): Promise<CouncilWorkItem> {
    const item = this.#requireTask(input.taskId);
    // 文案对齐服务端 work-item-repository 的更新冲突；委派冲突用 resolver 的另一句文案。
    this.#assertVersion(item, input.expectedVersion, "实施项已被其他参与者更新，请刷新后重试。");
    const now = new Date().toISOString();
    item.status = input.status;
    if (input.statusNote !== undefined) {
      if (input.statusNote) item.statusNote = input.statusNote;
      else delete item.statusNote;
    }
    if (input.fixCommit !== undefined) {
      if (input.fixCommit) item.fixCommit = input.fixCommit;
      else delete item.fixCommit;
    }
    if (input.brief !== undefined) {
      if (!validateCouncilBrief(input.brief).brief) {
        throw new Error("简报不符合 council-brief 格式。");
      }
      item.brief = structuredClone(input.brief);
    }
    if (input.status === "completed") item.completedAt = now;
    else delete item.completedAt;
    item.version += 1;
    item.updatedAt = now;
    item.updatedByActorId = "human";
    item.updatedBySnapshot = mockActorSnapshot("human");
    return mapWorkItem(item);
  }

  async listTaskDelegations(taskId: string): Promise<WorkItemDelegation[]> {
    this.#requireTask(taskId);
    return this.#delegationsOf(taskId);
  }

  async startTaskDelegation(
    taskId: string,
    input: StartTaskDelegationInput,
  ): Promise<WorkItemDelegation> {
    // 与 P2 契约同序：先校验入参形状，再校验任务本身，mock 下也能看到真实的失败路径。
    const kind = input.kind ?? "code";
    const inputAssetIds = input.inputAssetIds ?? [];
    if (kind !== "code" && kind !== "image") {
      throw new Error("当前只支持 code 或 image 委派。");
    }
    if (kind === "code" && inputAssetIds.length > 0) {
      throw new Error("代码委派不接受输入资产，inputAssetIds 必须为空数组。");
    }
    if (inputAssetIds.length > MAX_INPUT_ASSETS) {
      throw new Error("输入资产最多 8 个。");
    }
    if (kind === "code" && !input.supervisorAgentId) {
      throw new Error("代码委派必须指定审核 Agent。");
    }
    const item = this.#requireTask(taskId);
    if (item.kind !== kind) {
      throw new Error("委派类型必须与任务类型一致。");
    }
    this.#assertVersion(item, input.expectedVersion);
    if (item.status === "completed") {
      throw new Error("只能委派未关闭议题中的未完成叶子任务。");
    }
    if (this.#delegations.some((entry) =>
      entry.workItemId === taskId && ACTIVE_DELEGATION_STATUSES.includes(entry.status))) {
      throw new Error("该任务已有进行中的委派。");
    }
    return this.#pushDelegation(item, {
      // 图像委派没有审核者；公开 DTO 的 supervisorAgentId 仍是必填字符串，mock 回填执行者（待与服务端对齐）。
      supervisorAgentId: input.supervisorAgentId ?? input.executorAgentId,
      executorAgentId: input.executorAgentId,
      permissionProfile: input.requestedPermission,
      // 图像委派由人验收（契约固定 human）。
      completionPolicy: kind === "image" ? "human" : input.completionPolicy ?? "human",
      acceptanceCriteria: input.acceptanceCriteria ?? "",
      kind,
      inputAssetIds: [...inputAssetIds],
    });
  }

  async cancelTaskDelegation(delegationId: string): Promise<WorkItemDelegation> {
    const delegation = this.#requireDelegation(delegationId);
    if (!ACTIVE_DELEGATION_STATUSES.includes(delegation.status)) {
      throw new Error("委派已结束，无法取消。");
    }
    const now = new Date().toISOString();
    delegation.status = "cancelled";
    delegation.updatedAt = now;
    delegation.completedAt = now;
    return structuredClone(delegation);
  }

  async resumeTaskDelegation(
    delegationId: string,
    expectedVersion: number,
    requestedPermission?: WorkItemDelegation["permissionProfile"],
  ): Promise<WorkItemDelegation> {
    const previous = this.#requireDelegation(delegationId);
    if (!RESUMABLE_DELEGATION_STATUSES.includes(previous.status)) {
      throw new Error("只有失败或已取消的委派可以接续。");
    }
    const item = this.#requireTask(previous.workItemId);
    this.#assertVersion(item, expectedVersion);
    return this.#pushDelegation(item, {
      supervisorAgentId: previous.supervisorAgentId,
      executorAgentId: previous.executorAgentId,
      permissionProfile: requestedPermission ?? previous.permissionProfile,
      completionPolicy: previous.completionPolicy ?? "human",
      acceptanceCriteria: previous.acceptanceCriteria ?? "",
      kind: previous.kind,
      inputAssetIds: [...previous.inputAssetIds],
      resumedFromId: previous.id,
      ...(previous.branchName ? { branchName: previous.branchName } : {}),
      ...(previous.headCommit ? { baseCommit: previous.headCommit } : {}),
    });
  }

  #pushDelegation(
    item: ApiWorkItem,
    fields: Pick<WorkItemDelegation,
      "supervisorAgentId" | "executorAgentId" | "permissionProfile" | "completionPolicy"
      | "acceptanceCriteria" | "kind" | "inputAssetIds" | "resumedFromId" | "branchName" | "baseCommit">,
  ): WorkItemDelegation {
    const now = new Date().toISOString();
    const delegation: WorkItemDelegation = {
      id: `delegation_${crypto.randomUUID()}`,
      ...(item.topicId ? { topicId: item.topicId } : {}),
      workItemId: item.id,
      ...fields,
      status: "queued",
      attempt: 0,
      // 图像委派单段、不进审核轮次。
      maxAttempts: fields.kind === "image" ? 1 : 2,
      createdAt: now,
      updatedAt: now,
    };
    this.#delegations.unshift(delegation);
    return structuredClone(delegation);
  }

  #delegationsOf(taskId: string): WorkItemDelegation[] {
    return structuredClone(this.#delegations.filter((entry) => entry.workItemId === taskId));
  }

  #requireTask(taskId: string): ApiWorkItem {
    const item = this.#tasks.find((candidate) => candidate.id === taskId);
    if (!item) {
      throw new Error("任务不存在或已被移除");
    }
    return item;
  }

  #requireDelegation(delegationId: string): WorkItemDelegation {
    const delegation = this.#delegations.find((entry) => entry.id === delegationId);
    if (!delegation) {
      throw new Error("委派不存在");
    }
    return delegation;
  }

  #assertVersion(
    item: ApiWorkItem,
    expectedVersion: number,
    message = "实施项已被更新，请刷新后重试。",
  ): void {
    if (item.version !== expectedVersion) {
      throw new Error(message);
    }
  }
}
