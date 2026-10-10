/**
 * @input  依赖：界面语言、当前任务与委派列表、可用 Agent、AssetRepository、默认验收标准、忙碌键/错误与发起/取消回调；
 *         components 的 WorkItemDelegationPanel、ImageDelegationPanel、DelegationTimeline
 * @output 导出：TaskDelegationSection —— 任务详情的「Agent 委派」区：委派类型选择（代码 / 图像）、对应面板与委派历史；
 *         代码面板内附「团队模式」复选框与并行上限（1–6，默认 3），勾选后提交走 onStartTeam
 * @pos    任务详情的子区块；代码委派沿用议题页的 supervisor→executor 面板（经 formExtras 插入团队选项），图像委派走
 *         ImageDelegationPanel 且不显示团队选项。有进行中的委派时类型锁定为该委派的类型；已有活动团队时团队模式禁用
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
import type { TaskDelegationStartInput, TaskTeamStartInput } from "./use-task-detail";

type DelegationKind = "code" | "image";
/** 并行上限的界面范围与默认值；服务端还会按 COUNCIL_WORKER_MAX_PARALLEL 再收紧。 */
const MAX_PARALLEL = { min: 1, max: 6, initial: 3 } as const;
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
  /** 团队模式发起；不传则不显示团队选项。 */
  onStartTeam?: (input: TaskTeamStartInput) => Promise<void>;
  /** 任务已有活动团队：团队模式禁用（服务端会 409）。 */
  hasActiveTeam?: boolean;
}

/** 输入原文 → 合法并行上限：空或非数字回到默认值，越界收敛到边界。 */
function clampParallel(text: string): number {
  const value = Number(text);
  if (!text.trim() || !Number.isFinite(value)) return MAX_PARALLEL.initial;
  return Math.min(MAX_PARALLEL.max, Math.max(MAX_PARALLEL.min, Math.round(value)));
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
  onStartTeam,
  hasActiveTeam = false,
}: TaskDelegationSectionProps) {
  const { t } = useI18n();
  const [teamMode, setTeamMode] = useState(false);
  // 输入框保存原文，避免清空时出现 NaN；提交与失焦时再收敛到合法范围。
  const [parallelText, setParallelText] = useState<string>(String(MAX_PARALLEL.initial));
  const teamSelected = Boolean(onStartTeam) && teamMode && !hasActiveTeam;
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
          onStart={(input) => teamSelected && onStartTeam
            ? onStartTeam({ ...input, maxParallel: clampParallel(parallelText) })
            : onStart({ ...input, kind: "code" })}
          onCancel={onCancel}
          formExtras={onStartTeam ? (
            <fieldset className="task-team-mode">
              <label className="task-team-mode-toggle">
                <input
                  type="checkbox"
                  checked={teamSelected}
                  disabled={hasActiveTeam}
                  onChange={(event) => setTeamMode(event.target.checked)}
                />
                <span>{t("团队模式（允许执行者并行派发 Worker）")}</span>
              </label>
              {hasActiveTeam ? <small>{t("该任务已有活动团队，结束后才能再次以团队模式发起。")}</small> : null}
              {teamSelected ? (
                <label className="task-team-mode-parallel">
                  <span>{t("并行上限")}</span>
                  <input
                    type="number"
                    aria-label={t("并行上限")}
                    min={MAX_PARALLEL.min}
                    max={MAX_PARALLEL.max}
                    step={1}
                    value={parallelText}
                    onChange={(event) => setParallelText(event.target.value)}
                    onBlur={() => setParallelText((value) => String(clampParallel(value)))}
                  />
                  <small>{t("执行者作为 Lead，在自己的会话里用 council_dispatch_worker 等工具派发，最多同时运行这么多个 Worker。")}</small>
                </label>
              ) : null}
            </fieldset>
          ) : undefined}
        />
      )}
      <DelegationTimeline delegations={delegations.slice(latestOfKind ? 1 : 0)} adapters={adapters} />
    </section>
  );
}
