/**
 * @input  依赖：任务领域类型（types/tasks.ts）与委派类型（types/orchestration.ts）
 * @output 导出：TaskRepository 任务列表/详情/创建/更新、任务委派发起/取消/接续，以及 P4 团队（读取、团队模式发起、
 *         Worker 聚焦/打断/归档/合并、结束团队）契约
 * @pos    任务领域的前端数据边界；http/desktop/mock 三套实现由 create-task-repository.ts 选择
 *
 * 刷新约定：本接口刻意不提供 subscribe。服务端 SSE 只有 council.changed {revision}，
 * 而内容仓储与编排仓储已各自持有 EventSource/轮询并按 revision 分流；任务仓储再开一条连接
 * 只会重复同一信号。任务行写入递增 content revision（内容仓储随之发布新快照），委派变化
 * 递增 orchestration revision（编排快照 revision 前进）——调用方（hook 层）在这两个信号
 * 变化时重读 listTasks/getTask 即可。自身写操作返回最新行，调用方据此就地更新。
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type {
  StartTaskDelegationInput,
  WorkItemDelegation,
} from "../../types/orchestration";
import type { CouncilWorkItem } from "../../types/council";
import type { StartTaskTeamInput, StartTaskTeamResult, TaskTeam, TaskWorker } from "../../types/team";
import type {
  CreateTaskInput,
  TaskDetail,
  TaskListFilter,
  UpdateTaskInput,
} from "../../types/tasks";

export interface TaskRepository {
  /** 当前项目的任务，按 priority 降序、updatedAt 降序（与服务端一致）。 */
  listTasks(filter?: TaskListFilter): Promise<CouncilWorkItem[]>;
  getTask(taskId: string): Promise<TaskDetail>;
  /** 同一项目下标题大小写不敏感去重，冲突时 reject（服务端 409）。 */
  createTask(input: CreateTaskInput): Promise<CouncilWorkItem>;
  /** 乐观版本更新；版本冲突时 reject（服务端 409）。 */
  updateTask(input: UpdateTaskInput): Promise<CouncilWorkItem>;
  listTaskDelegations(taskId: string): Promise<WorkItemDelegation[]>;
  startTaskDelegation(taskId: string, input: StartTaskDelegationInput): Promise<WorkItemDelegation>;
  /** 复用既有 /api/v1/work-item-delegations/:id/actions/cancel，委派动作不分议题/任务入口。 */
  cancelTaskDelegation(delegationId: string): Promise<WorkItemDelegation>;
  /** 复用既有 /api/v1/work-item-delegations/:id/actions/resume；expectedVersion 是任务行版本。 */
  resumeTaskDelegation(
    delegationId: string,
    expectedVersion: number,
    requestedPermission?: WorkItemDelegation["permissionProfile"],
  ): Promise<WorkItemDelegation>;

  // ---------- P4 团队（/api/v1/tasks/:taskId/team） ----------
  /** 任务当前团队（含已结束的最近一个）；没有团队时返回 null（服务端 404），不是错误。 */
  getTaskTeam(taskId: string): Promise<TaskTeam | null>;
  /** 以团队模式发起 Lead 委派；已有活动团队或进行中委派时 reject（服务端 409）。 */
  startTaskTeam(taskId: string, input: StartTaskTeamInput): Promise<StartTaskTeamResult>;
  /** 聚焦是团队内单选：focused=true 时服务端负责取消其他 Worker 的聚焦。 */
  focusWorker(taskId: string, workerId: string, focused: boolean): Promise<TaskWorker>;
  /** 只对 idle/running 的 Worker 有效；打断后 Worker 进入 error，不影响其他 Worker。 */
  interruptWorker(taskId: string, workerId: string): Promise<TaskWorker>;
  /** 只对 done/error 的 Worker 有效。 */
  archiveWorker(taskId: string, workerId: string): Promise<TaskWorker>;
  /** 受控合并 Worker 分支到 Lead 分支；Web 暂不提供入口（由 Lead 经 MCP 调用），仓储保留以与契约对齐。 */
  mergeWorker(taskId: string, workerId: string): Promise<TaskWorker>;
  endTeam(taskId: string): Promise<TaskTeam>;
}
