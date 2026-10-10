/**
 * @input  依赖：路由中的可选 taskId、内容 revision（工作区快照对象）、编排 revision、可用 Agent 列表、打开议题回调；
 *         data/tasks 的 createTaskRepository、data/assets 的 createAssetRepository，TaskList / TaskDetail / TaskCreateDialog
 * @output 导出：TasksView —— #/tasks 与 #/tasks/<taskId> 的视图入口
 * @pos    任务功能的装配点：创建一次任务仓储（列表、详情、新建对话框共享）与资产仓储（详情产物区与图像委派）；不持有路由逻辑，导航只写 buildHash 生成的 hash
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { useMemo, useState } from "react";
import { buildHash } from "../../app/routes";
import { createAssetRepository } from "../../data/assets/create-asset-repository";
import { createTaskRepository } from "../../data/tasks/create-task-repository";
import type { OrchestrationAdapter } from "../../types/orchestration";
import { TaskCreateDialog } from "./TaskCreateDialog";
import { TaskDetail } from "./TaskDetail";
import { TaskList } from "./TaskList";

export interface TasksViewProps {
  taskId?: string;
  /** 内容 revision：任务行写入会让内容仓储发布新快照，传快照对象本身即可。 */
  revision: unknown;
  /** 编排 revision：委派状态变化时前进。 */
  executionRevision: unknown;
  delegationAgents: OrchestrationAdapter[];
  onOpenTopic: (topicId: string) => void;
}

export function TasksView({ taskId, revision, executionRevision, delegationAgents, onOpenTopic }: TasksViewProps) {
  // 仓储只建一次：mock 实现把任务存在实例内存里，列表/详情/新建必须共用同一个实例才能看到彼此的写入。
  const repository = useMemo(() => createTaskRepository(), []);
  // 产物区与图像委派的 reference 候选读资产；mock 模式下与资产库页共用同一内存实例。
  const assetRepository = useMemo(() => createAssetRepository(), []);
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  return (
    <>
      {taskId ? (
        <TaskDetail
          key={taskId}
          repository={repository}
          assetRepository={assetRepository}
          taskId={taskId}
          revision={revision}
          executionRevision={executionRevision}
          delegationAgents={delegationAgents}
          onOpenTopic={onOpenTopic}
        />
      ) : (
        <TaskList
          repository={repository}
          revision={revision}
          executionRevision={executionRevision}
          onCreate={() => setIsCreateOpen(true)}
        />
      )}
      <TaskCreateDialog
        isOpen={isCreateOpen}
        repository={repository}
        onClose={() => setIsCreateOpen(false)}
        onCreated={(task) => {
          setIsCreateOpen(false);
          // 与 <a href> 跳转同一机制：写 hash，由 use-workspace-route 的 hashchange 订阅接管
          window.location.hash = buildHash({ view: "tasks", taskId: task.id });
        }}
      />
    </>
  );
}
