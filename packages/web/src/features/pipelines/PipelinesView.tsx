/**
 * @input  依赖：路由中的可选 pipelineId、内容 revision（工作区快照对象）、编排 revision、可用 Agent 列表；
 *         data/pipelines 的 createPipelineRepository、data/assets 的 createAssetRepository，PipelineList / PipelineDetailView / PipelineCreateDialog
 * @output 导出：PipelinesView —— #/pipelines 与 #/pipelines/<pipelineId> 的视图入口
 * @pos    流水线功能的装配点：创建一次流水线仓储（列表、详情、新建共享）与资产仓储（参考图候选、select 对比）；
 *         不持有路由逻辑，导航只写 buildHash 生成的 hash
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { useMemo, useState } from "react";
import { buildHash } from "../../app/routes";
import { createAssetRepository } from "../../data/assets/create-asset-repository";
import { createPipelineRepository } from "../../data/pipelines/create-pipeline-repository";
import type { OrchestrationAdapter } from "../../types/orchestration";
import { PipelineCreateDialog } from "./PipelineCreateDialog";
import { PipelineDetailView } from "./PipelineDetailView";
import { PipelineList } from "./PipelineList";

export interface PipelinesViewProps {
  pipelineId?: string;
  /** 内容 revision：流水线父/子任务写入会让内容仓储发布新快照，传快照对象本身即可。 */
  revision: unknown;
  /** 编排 revision：子任务委派状态变化时前进。 */
  executionRevision: unknown;
  delegationAgents: OrchestrationAdapter[];
}

export function PipelinesView({ pipelineId, revision, executionRevision, delegationAgents }: PipelinesViewProps) {
  // mock 实现把状态机挂在实例上，列表/详情/新建必须共用同一个实例。
  const repository = useMemo(() => createPipelineRepository(), []);
  const assetRepository = useMemo(() => createAssetRepository(), []);
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  return (
    <>
      {pipelineId ? (
        <PipelineDetailView
          key={pipelineId}
          repository={repository}
          assetRepository={assetRepository}
          pipelineId={pipelineId}
          revision={revision}
          executionRevision={executionRevision}
        />
      ) : (
        <PipelineList
          repository={repository}
          revision={revision}
          executionRevision={executionRevision}
          onCreate={() => setIsCreateOpen(true)}
        />
      )}
      <PipelineCreateDialog
        isOpen={isCreateOpen}
        repository={repository}
        assetRepository={assetRepository}
        agents={delegationAgents}
        onClose={() => setIsCreateOpen(false)}
        onCreated={(detail) => {
          setIsCreateOpen(false);
          window.location.hash = buildHash({ view: "pipelines", pipelineId: detail.task.id });
        }}
      />
    </>
  );
}
