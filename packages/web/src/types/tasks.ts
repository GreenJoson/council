/**
 * @input  依赖：council.ts 的任务行快照与 kind/source/status 联合类型、orchestration.ts 的委派类型
 * @output 导出：任务列表筛选、任务详情（含可选议题摘要、委派与桌面离线提示）、创建/更新任务入参
 * @pos    任务领域（/api/v1/tasks 与 Tauri list_tasks/get_task）在 Web 端的稳定领域模型；
 *         任务本体复用 CouncilWorkItem，不另起一套行类型
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type {
  CouncilWorkItem,
  WorkItemKind,
  WorkItemSource,
  WorkItemStatus,
} from "./council";
import type { WorkItemDelegation } from "./orchestration";

export interface TaskListFilter {
  status?: WorkItemStatus;
  kind?: WorkItemKind;
  source?: WorkItemSource;
}

/** 议题派生任务所属议题的轻量摘要；status 是 canonical 议题状态而非 Web 展示态。 */
export interface TaskTopicSummary {
  id: string;
  title: string;
  status: "open" | "decided" | "closed";
}

export interface TaskDetail {
  task: CouncilWorkItem;
  /** 只有议题派生任务（source=topic）才有。 */
  topic?: TaskTopicSummary;
  delegations: WorkItemDelegation[];
  /**
   * 详情能读到任务本体、但委派列表暂不可得时的诚实提示（桌面模式本地 Agent 服务离线）。
   * 有它时 delegations 为空数组只代表“未知”，不代表“没有委派”。
   */
  limitation?: string;
}

/** 项目路径由仓储实现持有，UI 不传。 */
export interface CreateTaskInput {
  title: string;
  details?: string;
  kind?: WorkItemKind;
  priority?: number;
  brief?: Record<string, unknown>;
}

export interface UpdateTaskInput {
  taskId: string;
  status: WorkItemStatus;
  expectedVersion: number;
  statusNote?: string;
  fixCommit?: string;
}
