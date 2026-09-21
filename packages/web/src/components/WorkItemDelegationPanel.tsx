/**
 * @input  依赖：当前实施项、可用 Agent 权限/职责、最新委派记录与启动/取消回调
 * @output 导出：WorkItemDelegationPanel、验收条件、执行阶段、已有提交与审核问题、本次权限和恢复入口
 * @pos    任务卡内的显式 supervisor→executor 委派入口与可审计进度摘要
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { DelegationExecutionProgress, delegationStatusLabel, isDelegationPaused } from "./DelegationExecutionProgress";
import { DelegationRecoveryActions } from "./DelegationRecoveryActions";
import { DelegationDeliveryEvidence } from "./DelegationDeliveryEvidence";
import { RuntimeAuditDetails } from "./RuntimeAuditDetails";

import { AlertTriangle, Bot, GitBranch, GitCommitHorizontal, LoaderCircle, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n/I18nProvider";
import type { CouncilWorkItem } from "../types/council";
import type {
  OrchestrationAdapter,
  WorkItemDelegation,
} from "../types/orchestration";

const ACTIVE = new Set(["queued", "executing", "reviewing", "changes_requested"]);


export function WorkItemDelegationPanel({
  item,
  adapters,
  delegation,
  busyAction,
  onStart,
  onCancel,
}: {
  item: CouncilWorkItem;
  adapters: OrchestrationAdapter[];
  delegation?: WorkItemDelegation;
  busyAction: string | null;
  onStart: (input: {
    supervisorAgentId: string;
    executorAgentId: string;
    requestedPermission: "workspace_write" | "danger_full_access";
    completionPolicy?: "review" | "human";
    acceptanceCriteria?: string;
    createInitialBaseline?: boolean;
  }) => Promise<void>;
  onCancel: (delegationId: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [completionPolicy, setCompletionPolicy] = useState<"human" | "review">("human");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState(item.details || item.title);
  const reviewers = useMemo(() => adapters.filter(
    (agent) => agent.available && (agent.executionRole === "reviewer" || agent.executionRole === "hybrid"),
  ), [adapters]);
  const executors = useMemo(() => adapters.filter(
    (agent) => agent.available
      && (agent.executionRole === "executor" || agent.executionRole === "hybrid")
      && agent.permissionProfile !== undefined
      && agent.permissionProfile !== "read_only",
  ), [adapters]);
  const defaultExecutor = executors[0]?.id ?? "";
  const defaultReviewer = reviewers.find((agent) => agent.id !== defaultExecutor)?.id ?? "";
  const hasDistinctPair = executors.some((candidate) => (
    reviewers.some((reviewer) => reviewer.id !== candidate.id)
  ));
  const [executorId, setExecutorId] = useState(defaultExecutor);
  const [supervisorId, setSupervisorId] = useState(defaultReviewer);
  const executor = executors.find((agent) => agent.id === executorId);
  const [permission, setPermission] = useState<"workspace_write" | "danger_full_access">(
    "workspace_write",
  );
  const [createInitialBaseline, setCreateInitialBaseline] = useState(false);

  // Agent 能力通过异步快照到达；不能把首次渲染时的空列表永久固化到表单状态。
  useEffect(() => {
    if (!executors.some((agent) => agent.id === executorId)) {
      setExecutorId(defaultExecutor);
    }
  }, [defaultExecutor, executorId, executors]);

  useEffect(() => {
    if (!reviewers.some((agent) => agent.id === supervisorId && agent.id !== executorId)) {
      setSupervisorId(reviewers.find((agent) => agent.id !== executorId)?.id ?? "");
    }
  }, [executorId, reviewers, supervisorId]);

  useEffect(() => {
    if (permission === "danger_full_access" && executor?.permissionProfile !== "danger_full_access") {
      setPermission("workspace_write");
    }
  }, [executor?.permissionProfile, permission]);
  const active = delegation ? ACTIVE.has(delegation.status) : false;
  const canOpen = !delegation || !active;

  if (delegation && !open) {
    const supervisor = adapters.find((agent) => agent.id === delegation.supervisorAgentId);
    const executing = adapters.find((agent) => agent.id === delegation.executorAgentId);
    return (
      <div className={`work-item-delegation-state is-${isDelegationPaused(delegation) ? "paused" : delegation.status}`}>
        <span><Bot size={13} /><strong>{t(delegationStatusLabel(delegation))}</strong></span>
        <small>
          {executing?.label ?? delegation.executorAgentId}
          {" → "}
          {supervisor?.label ?? delegation.supervisorAgentId}
          {delegation.attempt > 0 ? ` · ${delegation.attempt}/${delegation.maxAttempts}` : ""}
        </small>
        {delegation.completionPolicy === "human" && delegation.status === "approved" && item.status !== "completed"
          ? <p>{t("Agent 审核通过，等待人工验收；请在任务状态中填写验收证据并完成。")}</p> : null}
        <p>{t("本次执行权限：{permission}", { permission: t(delegation.permissionProfile === "danger_full_access" ? "完全控制" : "工作区写入") })}</p>
        <DelegationExecutionProgress delegation={delegation} />
        <DelegationDeliveryEvidence delegation={delegation} />
        {delegation.acceptanceCriteria ? <details className="delegation-criteria"><summary>{t("查看验收标准")}</summary><p>{delegation.acceptanceCriteria}</p></details> : null}
        {delegation.error ? <p><AlertTriangle size={12} />{t(delegation.error)}</p> : null}
        {delegation.status === "approved" && delegation.headCommit ? (
          <code><GitBranch size={12} />{delegation.branchName} · {delegation.headCommit.slice(0, 12)}</code>
        ) : null}
        {item.status !== "completed" ? <DelegationRecoveryActions key={delegation.id} delegation={delegation} expectedVersion={item.version} allowFullControl={executing?.permissionProfile === "danger_full_access"} /> : null}
        <RuntimeAuditDetails topicId={delegation.topicId} sourceKind="delegation" sourceId={delegation.id} />
        {active ? (
          <button
            type="button"
            disabled={Boolean(busyAction)}
            onClick={() => void onCancel(delegation.id)}
          >
            {busyAction === `cancel-delegation:${delegation.id}`
              ? <LoaderCircle className="spinning" size={12} />
              : <X size={12} />}
            {t("取消委派")}
          </button>
        ) : canOpen && item.status !== "completed" ? (
          <button type="button" disabled={Boolean(busyAction)} onClick={() => setOpen(true)}>
            <Bot size={12} />{t("重新委派")}
          </button>
        ) : null}
      </div>
    );
  }

  if (!open) {
    return (
      <button
        className="work-item-mini-button work-item-delegate-button"
        type="button"
        disabled={Boolean(busyAction) || !hasDistinctPair}
        title={!hasDistinctPair
          ? t("请先给两个不同 Agent 配置审核/执行职责，并给执行者写入权限")
          : undefined}
        onClick={() => setOpen(true)}
      >
        <Bot size={12} />{t("委派")}
      </button>
    );
  }

  const valid = Boolean(executorId && supervisorId && executorId !== supervisorId && acceptanceCriteria.trim());
  return (
    <div className="work-item-delegation-form">
      <header><span><Bot size={13} />{t("Agent 协作执行")}</span><button type="button" aria-label={t("关闭")} onClick={() => setOpen(false)}><X size={13} /></button></header>
      <label>
        <span>{t("执行 Agent")}</span>
        <select value={executorId} onChange={(event) => {
          const next = event.target.value;
          setExecutorId(next);
          if (next === supervisorId) setSupervisorId(reviewers.find((agent) => agent.id !== next)?.id ?? "");
          setPermission("workspace_write");
        }}>
          {executors.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}
        </select>
      </label>
      <span className="delegation-arrow">→</span>
      <label>
        <span>{t("审核 / 指挥 Agent")}</span>
        <select value={supervisorId} onChange={(event) => setSupervisorId(event.target.value)}>
          {reviewers.filter((agent) => agent.id !== executorId).map((agent) => (
            <option key={agent.id} value={agent.id}>{agent.label}</option>
          ))}
        </select>
      </label>
      <label>
        <span>{t("本次权限")}</span>
        <select value={permission} onChange={(event) => setPermission(event.target.value as typeof permission)}>
          <option value="workspace_write">{t("工作区执行")}</option>
          {executor?.permissionProfile === "danger_full_access" ? (
            <option value="danger_full_access">{t("完全控制")}</option>
          ) : null}
        </select>
      </label>
      {permission === "danger_full_access" ? (
        <p className="delegation-danger"><AlertTriangle size={12} />{t("将跳过 CLI 权限确认与沙箱。")}</p>
      ) : (
        <p><ShieldCheck size={12} />{t("代码改动写入隔离 worktree，由另一个 Agent 审核。")}</p>
      )}
      <label className="delegation-completion-policy">
        <span>{t("完成条件")}</span>
        <select aria-label={t("完成条件")} value={completionPolicy} onChange={(event) => setCompletionPolicy(event.target.value as "human" | "review")}>
          <option value="human">{t("审核通过后，人工验收")}</option>
          <option value="review">{t("以 Agent 审核通过为完成条件")}</option>
        </select>
      </label>
      <label className="delegation-acceptance-criteria">
        <span>{t("验收标准")}</span>
        <textarea aria-label={t("验收标准")} value={acceptanceCriteria} maxLength={4000} onChange={(event) => setAcceptanceCriteria(event.target.value)} />
      </label>
      <label className="delegation-baseline-option">
        <input
          type="checkbox"
          checked={createInitialBaseline}
          onChange={(event) => setCreateInitialBaseline(event.target.checked)}
        />
        <span><GitCommitHorizontal size={12} />{t("新项目没有初始提交：先建立安全基线")}</span>
      </label>
      <button
        className="work-item-submit"
        type="button"
        disabled={!valid || Boolean(busyAction)}
        onClick={() => void onStart({
          executorAgentId: executorId,
          supervisorAgentId: supervisorId,
          requestedPermission: permission,
          completionPolicy,
          acceptanceCriteria: acceptanceCriteria.trim(),
          ...(createInitialBaseline ? { createInitialBaseline: true } : {}),
        }).then(() => setOpen(false))}
      >
        {busyAction === `delegate:${item.id}` ? <LoaderCircle className="spinning" size={13} /> : <Bot size={13} />}
        {t(createInitialBaseline ? "建立安全基线并委派" : "开始执行与审核")}
      </button>
    </div>
  );
}
