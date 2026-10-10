/**
 * @input  依赖：http-client 统一请求/URL 构造、task-api 与 orchestration-api 严格解析器
 * @output 导出：HttpTaskRepository（/api/v1/tasks 全量 REST 实现）与其构造参数类型
 * @pos    http 模式的任务仓储；桌面模式也用它承接写操作和委派列表（每次按当前项目路径构造）
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { createApiUrl, jsonRequest, requestApiData, type Fetcher } from "../http-client";
import { parseWorkItemDelegation, parseWorkItemDelegations } from "../orchestration-api";
import { parseTask, parseTaskDetail, parseTasks } from "./task-api";
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

export interface HttpTaskRepositoryOptions {
  baseUrl: string;
  /** 绝对项目路径；列表与创建都绑定它，UI 不传。 */
  projectPath: string;
  fetcher?: Fetcher;
}

export class HttpTaskRepository implements TaskRepository {
  readonly #baseUrl: string;
  readonly #projectPath: string;
  readonly #fetcher: Fetcher;

  constructor(options: HttpTaskRepositoryOptions) {
    const projectPath = options.projectPath.trim();
    if (!projectPath) {
      throw new Error("任务仓储必须绑定项目路径");
    }
    // 先构造一次以尽早暴露非法地址，而不是等第一次请求才失败。
    createApiUrl(options.baseUrl, "/api/v1/tasks");
    this.#baseUrl = options.baseUrl;
    this.#projectPath = projectPath;
    this.#fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async listTasks(filter: TaskListFilter = {}): Promise<CouncilWorkItem[]> {
    return requestApiData(
      this.#fetcher,
      createApiUrl(this.#baseUrl, "/api/v1/tasks", {
        project: this.#projectPath,
        status: filter.status,
        kind: filter.kind,
        source: filter.source,
      }),
      parseTasks,
    );
  }

  async getTask(taskId: string): Promise<TaskDetail> {
    return requestApiData(this.#fetcher, this.#taskUrl(taskId), parseTaskDetail);
  }

  async createTask(input: CreateTaskInput): Promise<CouncilWorkItem> {
    return requestApiData(
      this.#fetcher,
      createApiUrl(this.#baseUrl, "/api/v1/tasks"),
      parseTask,
      jsonRequest({
        projectPath: this.#projectPath,
        title: input.title,
        ...(input.details !== undefined ? { details: input.details } : {}),
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.brief ? { brief: input.brief } : {}),
      }),
    );
  }

  async updateTask(input: UpdateTaskInput): Promise<CouncilWorkItem> {
    return requestApiData(
      this.#fetcher,
      this.#taskUrl(input.taskId),
      parseTask,
      jsonRequest({
        status: input.status,
        expectedVersion: input.expectedVersion,
        ...(input.statusNote !== undefined ? { statusNote: input.statusNote } : {}),
        ...(input.fixCommit !== undefined ? { fixCommit: input.fixCommit } : {}),
      }, "PUT"),
    );
  }

  async listTaskDelegations(taskId: string): Promise<WorkItemDelegation[]> {
    return requestApiData(
      this.#fetcher,
      this.#taskUrl(taskId, "/delegations"),
      parseWorkItemDelegations,
    );
  }

  async startTaskDelegation(
    taskId: string,
    input: StartTaskDelegationInput,
  ): Promise<WorkItemDelegation> {
    return requestApiData(
      this.#fetcher,
      this.#taskUrl(taskId, "/delegations"),
      parseWorkItemDelegation,
      jsonRequest({
        expectedVersion: input.expectedVersion,
        supervisorAgentId: input.supervisorAgentId,
        executorAgentId: input.executorAgentId,
        requestedPermission: input.requestedPermission,
        // 与议题入口一致：未选择时按人工验收提交，避免服务端默认值悄悄变化。
        completionPolicy: input.completionPolicy ?? "human",
        ...(input.acceptanceCriteria ? { acceptanceCriteria: input.acceptanceCriteria } : {}),
        ...(input.createInitialBaseline !== undefined
          ? { createInitialBaseline: input.createInitialBaseline }
          : {}),
        kind: input.kind ?? "code",
        inputAssetIds: input.inputAssetIds ?? [],
      }),
    );
  }

  async cancelTaskDelegation(delegationId: string): Promise<WorkItemDelegation> {
    return requestApiData(
      this.#fetcher,
      this.#delegationActionUrl(delegationId, "cancel"),
      parseWorkItemDelegation,
      jsonRequest({}),
    );
  }

  async resumeTaskDelegation(
    delegationId: string,
    expectedVersion: number,
    requestedPermission?: WorkItemDelegation["permissionProfile"],
  ): Promise<WorkItemDelegation> {
    return requestApiData(
      this.#fetcher,
      this.#delegationActionUrl(delegationId, "resume"),
      parseWorkItemDelegation,
      jsonRequest({ expectedVersion, ...(requestedPermission ? { requestedPermission } : {}) }),
    );
  }

  #taskUrl(taskId: string, suffix = ""): URL {
    return createApiUrl(this.#baseUrl, `/api/v1/tasks/${encodeURIComponent(taskId)}${suffix}`);
  }

  #delegationActionUrl(delegationId: string, action: "cancel" | "resume"): URL {
    return createApiUrl(
      this.#baseUrl,
      `/api/v1/work-item-delegations/${encodeURIComponent(delegationId)}/actions/${action}`,
    );
  }
}
