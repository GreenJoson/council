/**
 * @input  依赖：DesktopBridge 的设置/任务只读/议题详情/本地 Agent 服务配置与健康命令、
 *         HttpTaskRepository（写操作与委派列表）、离线指引 buildOfflineLimitation
 * @output 导出：DesktopTaskRepository、其桥接子接口与构造参数类型
 * @pos    桌面模式任务仓储：读（列表、任务本体、所属议题）走 Tauri 直读 Rust core；
 *         委派列表与全部写操作走本地 Agent 服务 HTTP；服务离线时写操作抛诚实指引，
 *         详情降级为“委派未知”而不是整体失败
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { parseApiTopicDetail } from "../api-types";
import type {
  DesktopBridge,
  DesktopSettings,
} from "../desktop-bridge";
import { buildOfflineLimitation } from "../desktop-orchestration-repository";
import { getErrorMessage } from "../error-message";
import { readProjectPathConfig } from "../project-path";
import { mapWorkItem } from "../workspace-mapper";
import { HttpTaskRepository } from "./http-task-repository";
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
  TaskTopicSummary,
  UpdateTaskInput,
} from "../../types/tasks";

/** 仅暴露任务仓储需要的桥接命令，方便测试注入替身。 */
export type DesktopTaskBridge = Pick<
  DesktopBridge,
  | "getSettings"
  | "listTasks"
  | "getTask"
  | "getTopic"
  | "getOrchestrationConfig"
  | "checkOrchestrationService"
>;

export interface DesktopTaskRepositoryOptions {
  bridge: DesktopTaskBridge;
  /** 本地服务可达时按 (服务地址, 当前项目路径) 构造 HTTP 实现；默认 HttpTaskRepository。 */
  createHttpDelegate?: (baseUrl: string, projectPath: string) => TaskRepository;
}

const PROJECT_SWITCHED = "项目已切换，旧任务结果已忽略";

export class DesktopTaskRepository implements TaskRepository {
  readonly #bridge: DesktopTaskBridge;
  readonly #createHttpDelegate: (baseUrl: string, projectPath: string) => TaskRepository;
  /** 服务地址来自 Rust 设置层且运行期不变，读一次即可；失败时下次再读。 */
  #baseUrl: string | undefined;

  constructor(options: DesktopTaskRepositoryOptions) {
    this.#bridge = options.bridge;
    this.#createHttpDelegate = options.createHttpDelegate
      ?? ((baseUrl, projectPath) => new HttpTaskRepository({ baseUrl, projectPath }));
  }

  async listTasks(filter: TaskListFilter = {}): Promise<CouncilWorkItem[]> {
    return this.#readInCurrentProject(async (projectPath) => {
      const items = await this.#bridge.listTasks({
        projectPath,
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.kind ? { kind: filter.kind } : {}),
      });
      return items
        .filter((item) => !filter.source || item.source === filter.source)
        .map(mapWorkItem);
    });
  }

  async getTask(taskId: string): Promise<TaskDetail> {
    const raw = await this.#bridge.getTask(taskId);
    if (!raw) {
      throw new Error("任务不存在或已被移除");
    }
    const task = mapWorkItem(raw);
    const topic = raw.topicId ? await this.#readTopicSummary(raw.topicId) : undefined;
    const delegationResult = await this.#readDelegations(taskId);
    return {
      task,
      ...(topic ? { topic } : {}),
      ...delegationResult,
    };
  }

  async createTask(input: CreateTaskInput): Promise<CouncilWorkItem> {
    return (await this.#requireLive()).createTask(input);
  }

  async updateTask(input: UpdateTaskInput): Promise<CouncilWorkItem> {
    return (await this.#requireLive()).updateTask(input);
  }

  async listTaskDelegations(taskId: string): Promise<WorkItemDelegation[]> {
    return (await this.#requireLive()).listTaskDelegations(taskId);
  }

  async startTaskDelegation(
    taskId: string,
    input: StartTaskDelegationInput,
  ): Promise<WorkItemDelegation> {
    return (await this.#requireLive()).startTaskDelegation(taskId, input);
  }

  async cancelTaskDelegation(delegationId: string): Promise<WorkItemDelegation> {
    return (await this.#requireLive()).cancelTaskDelegation(delegationId);
  }

  async resumeTaskDelegation(
    delegationId: string,
    expectedVersion: number,
    requestedPermission?: WorkItemDelegation["permissionProfile"],
  ): Promise<WorkItemDelegation> {
    return (await this.#requireLive()).resumeTaskDelegation(
      delegationId,
      expectedVersion,
      requestedPermission,
    );
  }

  /**
   * 项目路径以 Rust 设置为唯一真源，每次现读、不缓存，因此不需要第二套设置世代。
   * 读结果回来后再核对一次当前项目：期间切过项目就丢弃旧结果，语义与
   * NativeCouncilRepository 的世代校验一致（同一错误文案风格）。
   */
  async #readInCurrentProject<T>(read: (projectPath: string) => Promise<T>): Promise<T> {
    const projectPath = requireProjectPath(await this.#bridge.getSettings());
    const result = await read(projectPath);
    const after = await this.#bridge.getSettings();
    if (after.currentProjectPath !== projectPath) {
      throw new Error(PROJECT_SWITCHED);
    }
    return result;
  }

  async #readTopicSummary(topicId: string): Promise<TaskTopicSummary | undefined> {
    try {
      const detail = parseApiTopicDetail(await this.#bridge.getTopic({
        topicId,
        messageLimit: 1,
        messageOffset: 0,
      }));
      return { id: detail.topic.id, title: detail.topic.title, status: detail.topic.status };
    } catch {
      // 议题摘要只是详情的附加信息；读不到时任务本体仍然可看。
      return undefined;
    }
  }

  async #readDelegations(
    taskId: string,
  ): Promise<{ delegations: WorkItemDelegation[]; limitation?: string }> {
    let delegate: TaskRepository | undefined;
    try {
      delegate = await this.#tryLive();
    } catch (error: unknown) {
      if (error instanceof ProjectNotConfiguredError) {
        return { delegations: [], limitation: error.message };
      }
      delegate = undefined;
    }
    if (!delegate) {
      return { delegations: [], limitation: buildOfflineLimitation(this.#baseUrl) };
    }
    try {
      return { delegations: await delegate.listTaskDelegations(taskId) };
    } catch (error: unknown) {
      return { delegations: [], limitation: getErrorMessage(error) };
    }
  }

  /** 写操作必须在服务可达时执行；离线时抛出与编排面板一致的诚实指引。 */
  async #requireLive(): Promise<TaskRepository> {
    let delegate: TaskRepository | undefined;
    try {
      delegate = await this.#tryLive();
    } catch (error: unknown) {
      // 设置未就绪（未选项目）是用户可处理的错误，原样抛出；其余桥接异常归为离线。
      if (error instanceof ProjectNotConfiguredError) {
        throw error;
      }
      delegate = undefined;
    }
    if (!delegate) {
      throw new Error(buildOfflineLimitation(this.#baseUrl));
    }
    return delegate;
  }

  /** 与 DesktopOrchestrationRepository 相同的探测方式：Rust 设置给地址、Rust 侧做健康检查。 */
  async #tryLive(): Promise<TaskRepository | undefined> {
    if (this.#baseUrl === undefined) {
      this.#baseUrl = (await this.#bridge.getOrchestrationConfig()).baseUrl;
    }
    const health = await this.#bridge.checkOrchestrationService();
    if (!health.reachable) {
      return undefined;
    }
    const projectPath = requireProjectPath(await this.#bridge.getSettings());
    return this.#createHttpDelegate(this.#baseUrl, projectPath);
  }
}

class ProjectNotConfiguredError extends Error {}

function requireProjectPath(settings: DesktopSettings): string {
  if (!settings.logLibrary || !settings.currentProjectPath) {
    throw new ProjectNotConfiguredError("请先设置日志库并选择项目目录");
  }
  return readProjectPathConfig(settings.currentProjectPath);
}
