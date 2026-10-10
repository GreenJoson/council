/**
 * @input  依赖：CouncilDatabase（work_items 唯一读写方）、task-intake 归一化、可选的委派端口（HTTP 为编排服务，MCP 为本地只读账本 + HTTP 转发）
 * @output 导出：TaskService（createDirect/list/get/update（image 任务可写 brief）/submitBrief/listDelegations/delegate）、
 *         TaskDelegationPort、TaskDetail、StartTaskDelegationInput、SubmitTaskBriefInput
 * @pos    任务域用例：直接任务与议题派生任务共用一套读取/更新/委派入口；REST 与 MCP 只做协议适配
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import path from "node:path";
import type { CouncilDatabase } from "../database.js";
import { CouncilValidationError } from "../errors.js";
import { CouncilProtocolError, parseCouncilBrief } from "../pipelines/brief-protocol.js";
import type { StartWorkItemDelegationInput } from "../orchestration/work-item-delegation-manager.js";
import type { WorkItemDelegation } from "../orchestration/work-item-delegation-store.js";
import type { TopicStatus, WorkItem, WorkItemKind, WorkItemSource, WorkItemStatus } from "../types.js";
import { createDirectTask, type DirectTaskInput } from "./task-intake.js";

/** 任务入口的委派参数：任务归属由 id 决定，不接受调用方指定议题。 */
export type StartTaskDelegationInput = Omit<StartWorkItemDelegationInput, "topicId" | "workItemId">;

/** 委派能力的端口：同步或异步皆可，便于 HTTP 进程直连管理器、MCP 进程转发到 HTTP。 */
export interface TaskDelegationPort {
  listForWorkItem(workItemId: string): WorkItemDelegation[] | Promise<WorkItemDelegation[]>;
  start(workItemId: string, input: StartTaskDelegationInput): WorkItemDelegation | Promise<WorkItemDelegation>;
}

export interface TaskTopicSummary {
  id: string;
  title: string;
  status: TopicStatus;
}

export interface TaskDetail {
  task: WorkItem;
  /** 议题派生任务才有；直接任务省略。 */
  topic?: TaskTopicSummary;
  delegations: WorkItemDelegation[];
}

export interface ListTasksInput {
  projectPath: string;
  status?: WorkItemStatus;
  kind?: WorkItemKind;
  source?: WorkItemSource;
}

export interface UpdateTaskInput {
  taskId: string;
  status: WorkItemStatus;
  expectedVersion: number;
  statusNote?: string;
  fixCommit?: string;
  /** 仅 image 任务；按 council-brief 协议严格校验后整体替换。 */
  brief?: Record<string, unknown>;
  actorId: string;
}

export interface SubmitTaskBriefInput {
  taskId: string;
  expectedVersion: number;
  brief: Record<string, unknown>;
  actorId: string;
}

export class TaskService {
  constructor(
    private readonly database: CouncilDatabase,
    private readonly delegations?: TaskDelegationPort,
  ) {}

  createDirect(input: DirectTaskInput & { actorId: string }): WorkItem {
    return createDirectTask(this.database, input);
  }

  /** 列表按字面路径匹配：项目目录可能已移动，读取历史任务不要求目录仍存在。 */
  list(input: ListTasksInput): WorkItem[] {
    if (!path.isAbsolute(input.projectPath)) {
      throw new CouncilValidationError("项目路径必须是绝对路径。");
    }
    return this.database.listTasks({ ...input, projectPath: path.normalize(input.projectPath) });
  }

  async get(taskId: string): Promise<TaskDetail> {
    const task = this.database.getWorkItem(taskId);
    const delegations = await this.listDelegations(taskId);
    if (!task.topicId) return { task, delegations };
    const topic = this.database.getTopic(task.topicId);
    return { task, topic: { id: topic.id, title: topic.title, status: topic.status }, delegations };
  }

  /** 与议题内 PUT 相同的乐观版本语义；不传议题，以任务 id 为准。 */
  update(input: UpdateTaskInput): WorkItem {
    const brief = input.brief ? this.#validatedBrief(input.taskId, input.brief) : undefined;
    return this.database.updateWorkItemAsActor({
      workItemId: input.taskId,
      status: input.status,
      expectedVersion: input.expectedVersion,
      ...(input.statusNote !== undefined ? { statusNote: input.statusNote } : {}),
      ...(input.fixCommit !== undefined ? { fixCommit: input.fixCommit } : {}),
      ...(brief ? { brief } : {}),
      actorId: input.actorId,
    });
  }

  /** 只提交 brief：保持当前状态，仍走乐观版本，供 MCP 等不改状态的入口使用。 */
  submitBrief(input: SubmitTaskBriefInput): WorkItem {
    const brief = this.#validatedBrief(input.taskId, input.brief);
    const current = this.database.getWorkItem(input.taskId);
    return this.database.updateWorkItemAsActor({
      workItemId: input.taskId,
      status: current.status,
      expectedVersion: input.expectedVersion,
      brief,
      actorId: input.actorId,
    });
  }

  #validatedBrief(taskId: string, brief: Record<string, unknown>): Record<string, unknown> {
    const task = this.database.getWorkItem(taskId);
    if (task.kind !== "image") throw new CouncilValidationError("只有 image 任务可以提交 council-brief。");
    try {
      return { ...parseCouncilBrief(brief) };
    } catch (error) {
      if (error instanceof CouncilProtocolError) throw new CouncilValidationError(error.message);
      throw error;
    }
  }

  async listDelegations(taskId: string): Promise<WorkItemDelegation[]> {
    this.database.getWorkItem(taskId);
    return await this.#port().listForWorkItem(taskId);
  }

  async delegate(taskId: string, input: StartTaskDelegationInput): Promise<WorkItemDelegation> {
    this.database.getWorkItem(taskId);
    return await this.#port().start(taskId, input);
  }

  #port(): TaskDelegationPort {
    if (!this.delegations) throw new CouncilValidationError("任务委派服务未启用。");
    return this.delegations;
  }
}
