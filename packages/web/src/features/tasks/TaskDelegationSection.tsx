/**
 * @input  依赖：界面语言、当前任务与委派列表、可用 Agent、AssetRepository、默认验收标准、忙碌键/错误与发起/取消回调；
 *         components 的 WorkItemDelegationPanel、ImageDelegationPanel、DelegationTimeline
 * @output 导出：TaskDelegationSection —— 任务详情的「Agent 委派」区：委派类型选择（代码 / 图像）、对应面板与委派历史
 * @pos    任务详情的子区块；代码委派沿用议题页的 supervisor→executor 面板，图像委派走 ImageDelegationPanel。
 *         有进行中的委派时类型锁定为该委派的类型，避免并行发起另一种委派
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { WorkItemDelegationPanel } from "../../components/WorkItemDelegationPanel";
import type { AssetRepository } from "../../data/assets/asset-repository";
import { useI18n } from "../../i18n/I18nProvider";
import type { CouncilWorkItem } from "../../types/council";
import type { OrchestrationAdapter, WorkItemDelegation } from "../../types/orchestration";
import { DelegationTimeline } from "./DelegationTimeline";
import { ImageDelegationPanel } from "./ImageDelegationPanel";
import type { TaskDelegationStartInput } from "./use-task-detail";

type DelegationKind = "code" | "image";
const ACTIVE = new Set<WorkItemDelegation["status"]>(["queued", "executing", "reviewing", "changes_requested"]);

export interface TaskDelegationSectionProps {
  task: CouncilWorkItem;
  delegations: WorkItemDelegation[];
  adapters: OrchestrationAdapter[];
  assetRepository: AssetRepository;
  defaultAcceptance: string;
  busyAction: string | null;
  actionError?: string;
  onStart: (input: TaskDelegationStartInput) => Promise<void>;
  onCancel: (delegationId: string) => Promise<void>;
}

function asDelegationKind(kind: string | undefined): DelegationKind {
  return kind === "image" ? "image" : "code";
}

export function TaskDelegationSection({
  task,
  delegations,
  adapters,
  assetRepository,
  defaultAcceptance,
  busyAction,
  actionError,
  onStart,
  onCancel,
}: TaskDelegationSectionProps) {
  const { t } = useI18n();
  const latest = delegations[0];
  const [selectedKind, setSelectedKind] = useState<DelegationKind>(asDelegationKind(latest?.kind ?? task.kind));
  const isActive = latest ? ACTIVE.has(latest.status) : false;
  const kind = isActive && latest ? asDelegationKind(latest.kind) : selectedKind;
  // 面板只展示与当前类型一致的最新委派；另一类型的历史仍在时间线里。
  const latestOfKind = latest && asDelegationKind(latest.kind) === kind ? latest : undefined;

  return (
    <section className="task-detail-section" aria-labelledby="task-delegation-heading">
      <h2 id="task-delegation-heading">{t("Agent 委派")}</h2>
      {actionError ? (
        <p className="task-notice is-danger" role="alert">
          <AlertTriangle size={13} />
          {t("委派操作失败：{message}", { message: t(actionError) })}
        </p>
      ) : null}
      {task.status !== "completed" ? (
        <label className="task-delegation-kind">
          <span>{t("委派类型")}</span>
          <select
            aria-label={t("委派类型")}
            value={kind}
            disabled={isActive || Boolean(busyAction)}
            title={isActive ? t("有进行中的委派时不能切换类型") : undefined}
            onChange={(event) => setSelectedKind(event.target.value as DelegationKind)}
          >
            <option value="code">{t("代码")}</option>
            <option value="image">{t("图像")}</option>
          </select>
        </label>
      ) : null}
      {task.status === "completed" && !latest ? (
        <p className="task-muted">{t("任务已完成，没有委派记录。")}</p>
      ) : kind === "image" ? (
        <ImageDelegationPanel
          key={`${task.id}:image`}
          item={task}
          adapters={adapters}
          delegation={latestOfKind}
          assetRepository={assetRepository}
          defaultAcceptance={defaultAcceptance}
          busyAction={busyAction}
          onStart={onStart}
          onCancel={onCancel}
        />
      ) : (
        <WorkItemDelegationPanel
          key={`${task.id}:code`}
          item={task}
          adapters={adapters}
          delegation={latestOfKind}
          busyAction={busyAction}
          onStart={(input) => onStart({ ...input, kind: "code" })}
          onCancel={onCancel}
        />
      )}
      <DelegationTimeline delegations={delegations.slice(latestOfKind ? 1 : 0)} adapters={adapters} />
    </section>
  );
}
