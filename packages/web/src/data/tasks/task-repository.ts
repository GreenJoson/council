/**
 * @input  依赖：任务领域类型（types/tasks.ts）与委派类型（types/orchestration.ts）
 * @output 导出：TaskRepository 任务列表/详情/创建/更新与任务委派发起/取消/接续契约
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
}
