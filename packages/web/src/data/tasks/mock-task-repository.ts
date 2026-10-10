/**
 * @input  依赖：mock-tasks 夹具、mock-data Actor 快照、workspace-mapper 行映射、council-brief 校验与浏览器随机 ID
 * @output 导出：MockTaskRepository（内存任务、任务委派与 P4 团队的同构原型实现）
 * @pos    mock 模式任务仓储：排序、标题去重、乐观版本、brief 校验与 P2 委派约束（code/image、输入资产上限、
 *         图像委派无审核者）与服务端契约保持同一语义；输入资产是否同项目、kind=image 由服务端校验，mock 不模拟。
 *         团队：一任务至多一个活动团队；聚焦单选、打断仅 idle/running→error、归档仅 done/error、合并仅未合并的 done、
 *         结束团队把仍在跑的 Worker 记为被打断；团队模式发起只建 Lead 委派与空团队，Worker 由 Lead 经 MCP 派发，mock 不模拟
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
import type { StartTaskTeamInput, StartTaskTeamResult, TaskTeam, TaskWorker } from "../../types/team";
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
/** 与界面一致的并行上限范围；服务端以 COUNCIL_WORKER_MAX_PARALLEL 为准。 */
const MAX_PARALLEL_RANGE = { min: 1, max: 6 } as const;
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
  readonly #teams: TaskTeam[];

  constructor(options: MockTaskRepositoryOptions = {}) {
    const fixtures = structuredClone(options.fixtures ?? createMockTaskFixtures());
    this.#projectPath = options.projectPath ?? MOCK_TASK_PROJECT_PATH;
    this.#tasks = fixtures.tasks;
    this.#delegations = fixtures.delegations;
    this.#teams = fixtures.teams ?? [];
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

  // ---------- P4 团队 ----------

  async getTaskTeam(taskId: string): Promise<TaskTeam | null> {
    this.#requireTask(taskId);
    const team = this.#latestTeam(taskId);
    return team ? structuredClone(team) : null;
  }

  async startTaskTeam(taskId: string, input: StartTaskTeamInput): Promise<StartTaskTeamResult> {
    const maxParallel = input.maxParallel ?? 3;
    if (!Number.isInteger(maxParallel)
      || maxParallel < MAX_PARALLEL_RANGE.min || maxParallel > MAX_PARALLEL_RANGE.max) {
      throw new Error("并行上限必须是 1–6 的整数。");
    }
    const item = this.#requireTask(taskId);
    if (item.kind !== "code") {
      throw new Error("只有代码任务可以使用团队模式。");
    }
    if (this.#teams.some((team) => team.workItemId === taskId && team.status === "active")) {
      throw new Error("该任务已有活动团队。");
    }
    // Lead 委派与普通代码委派同一套校验（版本、未完成、无进行中委派、审核者）。
    const leadDelegation = await this.startTaskDelegation(taskId, {
      expectedVersion: input.expectedVersion,
      executorAgentId: input.executorAgentId,
      ...(input.supervisorAgentId ? { supervisorAgentId: input.supervisorAgentId } : {}),
      requestedPermission: input.requestedPermission,
      ...(input.completionPolicy ? { completionPolicy: input.completionPolicy } : {}),
      ...(input.acceptanceCriteria ? { acceptanceCriteria: input.acceptanceCriteria } : {}),
      kind: "code",
      inputAssetIds: [],
    });
    const team: TaskTeam = {
      id: `team_${crypto.randomUUID()}`,
      workItemId: item.id,
      leadDelegationId: leadDelegation.id,
      status: "active",
      maxParallel,
      createdAt: new Date().toISOString(),
      workers: [],
    };
    this.#teams.unshift(team);
    return { team: structuredClone(team), leadDelegation };
  }

  async focusWorker(taskId: string, workerId: string, focused: boolean): Promise<TaskWorker> {
    const { team, worker } = this.#requireWorker(taskId, workerId);
    const now = new Date().toISOString();
    if (focused) {
      // 单选：聚焦一个即取消其余。
      for (const other of team.workers) {
        if (other.id !== worker.id && other.focused) {
          other.focused = false;
          other.updatedAt = now;
        }
      }
    }
    worker.focused = focused;
    worker.updatedAt = now;
    return structuredClone(worker);
  }

  async interruptWorker(taskId: string, workerId: string): Promise<TaskWorker> {
    const { team, worker } = this.#requireWorker(taskId, workerId);
    if (team.status !== "active") {
      throw new Error("团队已结束。");
    }
    if (worker.status !== "idle" && worker.status !== "running") {
      throw new Error("只有待命或运行中的 Worker 可以打断。");
    }
    this.#markInterrupted(worker, new Date().toISOString());
    return structuredClone(worker);
  }

  async archiveWorker(taskId: string, workerId: string): Promise<TaskWorker> {
    const { worker } = this.#requireWorker(taskId, workerId);
    if (worker.status !== "done" && worker.status !== "error") {
      throw new Error("只有已完成或出错的 Worker 可以归档。");
    }
    worker.status = "archived";
    worker.focused = false;
    worker.updatedAt = new Date().toISOString();
    return structuredClone(worker);
  }

  async mergeWorker(taskId: string, workerId: string): Promise<TaskWorker> {
    const { team, worker } = this.#requireWorker(taskId, workerId);
    if (team.status !== "active") {
      throw new Error("团队已结束。");
    }
    if (worker.status !== "done" || worker.mergedCommit) {
      throw new Error("只有已完成且未合并的 Worker 可以合并。");
    }
    worker.mergedCommit = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    worker.updatedAt = new Date().toISOString();
    return structuredClone(worker);
  }

  async endTeam(taskId: string): Promise<TaskTeam> {
    this.#requireTask(taskId);
    const team = this.#teams.find((entry) => entry.workItemId === taskId && entry.status === "active");
    if (!team) {
      throw new Error("该任务没有活动团队。");
    }
    const now = new Date().toISOString();
    for (const worker of team.workers) {
      if (worker.status === "idle" || worker.status === "running") this.#markInterrupted(worker, now);
    }
    team.status = "ended";
    team.endedAt = now;
    return structuredClone(team);
  }

  /** 活动团队优先，否则取最近创建的已结束团队。 */
  #latestTeam(taskId: string): TaskTeam | undefined {
    const teams = this.#teams.filter((team) => team.workItemId === taskId);
    return teams.find((team) => team.status === "active")
      ?? [...teams].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  }

  #requireWorker(taskId: string, workerId: string): { team: TaskTeam; worker: TaskWorker } {
    this.#requireTask(taskId);
    const team = this.#latestTeam(taskId);
    const worker = team?.workers.find((entry) => entry.id === workerId);
    if (!team || !worker) {
      throw new Error("Worker 不存在");
    }
    return { team, worker };
  }

  #markInterrupted(worker: TaskWorker, now: string): void {
    worker.status = "error";
    worker.updatedAt = now;
    worker.delegation = {
      ...worker.delegation,
      status: "cancelled",
      failureCode: "interrupted",
      execution: undefined,
      headCommit: worker.delegation?.headCommit,
      error: "已在团队面板中打断该 Worker。",
    };
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
