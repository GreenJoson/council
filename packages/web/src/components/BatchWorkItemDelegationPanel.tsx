/**
 * @input  依赖：当前未完成叶子任务、Agent 权限/职责、批量委派账本与启动回调
 * @output 导出：顶部一键委派入口、共享分支串行进度与新项目安全基线确认
 * @pos    任务列表级 supervisor→executor 执行控制台；只编排剩余任务，不替代逐项审计卡
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  GitCommitHorizontal,
  ListRestart,
  LoaderCircle,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n/I18nProvider";
import type { CouncilWorkItem } from "../types/council";
import type { OrchestrationAdapter, WorkItemDelegation } from "../types/orchestration";

const ACTIVE = new Set(["queued", "executing", "reviewing", "changes_requested"]);
const BATCH_BRANCH_PREFIX = "codex/council-batch-";

export interface BatchDelegationOptions {
  supervisorAgentId: string;
  executorAgentId: string;
  requestedPermission: "workspace_write" | "danger_full_access";
  completionPolicy?: "review" | "human";
  acceptanceCriteria?: string;
  createInitialBaseline?: boolean;
}

export function BatchWorkItemDelegationPanel({
  items,
  adapters,
  delegations,
  busyAction,
  onStart,
}: {
  items: CouncilWorkItem[];
  adapters: OrchestrationAdapter[];
  delegations: WorkItemDelegation[];
  busyAction: string | null;
  onStart: (input: BatchDelegationOptions) => Promise<void>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [completionPolicy, setCompletionPolicy] = useState<"human" | "review">("human");
  const [createInitialBaseline, setCreateInitialBaseline] = useState(false);
  const reviewers = useMemo(() => adapters.filter(
    (agent) => agent.available
      && (agent.executionRole === "reviewer" || agent.executionRole === "hybrid"),
  ), [adapters]);
  const executors = useMemo(() => adapters.filter(
    (agent) => agent.available
      && (agent.executionRole === "executor" || agent.executionRole === "hybrid")
      && agent.permissionProfile !== undefined
      && agent.permissionProfile !== "read_only",
  ), [adapters]);
  const defaultExecutor = executors[0]?.id ?? "";
  const [executorId, setExecutorId] = useState(defaultExecutor);
  const [supervisorId, setSupervisorId] = useState(
    reviewers.find((agent) => agent.id !== defaultExecutor)?.id ?? "",
  );
  const executor = executors.find((agent) => agent.id === executorId);
  const [permission, setPermission] = useState<"workspace_write" | "danger_full_access">(
    "workspace_write",
  );

  useEffect(() => {
    if (!executors.some((agent) => agent.id === executorId)) setExecutorId(defaultExecutor);
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

  const latestBranch = delegations.find(
    (delegation) => delegation.branchName?.startsWith(BATCH_BRANCH_PREFIX),
  )?.branchName;
  const latestBatch = latestBranch
    ? delegations.filter((delegation) => delegation.branchName === latestBranch)
    : [];
  const approved = latestBatch.filter((delegation) => delegation.status === "approved").length;
  const active = latestBatch.some((delegation) => ACTIVE.has(delegation.status));
  const failed = latestBatch.find((delegation) => delegation.status === "failed");
  const displayCount = active && latestBatch.length > 0 ? latestBatch.length : items.length;
  const hasDistinctPair = executors.some((candidate) => (
    reviewers.some((reviewer) => reviewer.id !== candidate.id)
  ));
  const valid = Boolean(items.length > 0 && executorId && supervisorId && executorId !== supervisorId);

  return (
    <div className="batch-delegation-panel">
      <div className="batch-delegation-summary">
        <div>
          <span><ListRestart size={14} />{t("串行执行队列")}</span>
          <strong>{t("一键委派全部剩余任务")}</strong>
          <small>{t("{count} 项叶子任务 · 同一隔离分支 · 逐项执行并交叉审核", { count: displayCount })}</small>
        </div>
        <button
          type="button"
          disabled={Boolean(busyAction) || active || items.length === 0 || !hasDistinctPair}
          title={!hasDistinctPair
            ? t("请先给两个不同 Agent 配置审核/执行职责，并给执行者写入权限")
            : undefined}
          onClick={() => setOpen((current) => !current)}
        >
          {busyAction === "delegate-batch" ? <LoaderCircle className="spinning" size={14} /> : <Bot size={14} />}
          {t("一键委派")}
        </button>
      </div>

      {latestBatch.length > 0 ? (
        <div className={`batch-delegation-progress${failed ? " is-failed" : ""}`}>
          <span style={{ width: `${String(Math.round((approved / latestBatch.length) * 100))}%` }} />
          <p>
            {active ? <LoaderCircle className="spinning" size={12} /> : <CheckCircle2 size={12} />}
            {t("最近队列：{approved}/{total} 项审核通过", {
              approved,
              total: latestBatch.length,
            })}
            {failed?.error ? ` · ${failed.error}` : ""}
          </p>
        </div>
      ) : null}

      {open ? (
        <div className="batch-delegation-form">
          <header>
            <div><strong>{t("设置整批执行链")}</strong><small>{t("任一任务失败后暂停后续队列，不跳过失败项。")}</small></div>
            <button type="button" aria-label={t("关闭")} onClick={() => setOpen(false)}><X size={14} /></button>
          </header>
          <div className="batch-delegation-fields">
            <label>
              <span>{t("执行 Agent")}</span>
              <select value={executorId} onChange={(event) => {
                const next = event.target.value;
                setExecutorId(next);
                setPermission("workspace_write");
              }}>
                {executors.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}
              </select>
            </label>
            <label>
              <span>{t("审核 / 指挥 Agent")}</span>
              <select value={supervisorId} onChange={(event) => setSupervisorId(event.target.value)}>
                {reviewers.filter((agent) => agent.id !== executorId).map((agent) => (
                  <option key={agent.id} value={agent.id}>{agent.label}</option>
                ))}
              </select>
            </label>
            <label>
              <span>{t("整批权限")}</span>
              <select value={permission} onChange={(event) => setPermission(event.target.value as typeof permission)}>
                <option value="workspace_write">{t("工作区执行")}</option>
                {executor?.permissionProfile === "danger_full_access" ? (
                  <option value="danger_full_access">{t("完全控制")}</option>
                ) : null}
              </select>
            </label>
          </div>
          {permission === "danger_full_access" ? (
            <p className="delegation-danger"><AlertTriangle size={12} />{t("将跳过 CLI 权限确认与沙箱。")}</p>
          ) : (
            <p><ShieldCheck size={12} />{t("所有任务串行写入同一隔离分支；按各项任务说明验收，满足完成条件后计入进度。")}</p>
          )}
          <label>
            <span>{t("完成条件")}</span>
            <select aria-label={t("完成条件")} value={completionPolicy} onChange={(event) => setCompletionPolicy(event.target.value as "human" | "review")}>
              <option value="human">{t("审核通过后，人工验收")}</option>
              <option value="review">{t("以 Agent 审核通过为完成条件")}</option>
            </select>
          </label>
          <label className="delegation-baseline-option">
            <input
              type="checkbox"
              checked={createInitialBaseline}
              onChange={(event) => setCreateInitialBaseline(event.target.checked)}
            />
            <span><GitCommitHorizontal size={12} />{t("新项目没有初始提交：先扫描并建立安全基线")}</span>
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
              ...(createInitialBaseline ? { createInitialBaseline: true } : {}),
            }).then(() => setOpen(false))}
          >
            {busyAction === "delegate-batch" ? <LoaderCircle className="spinning" size={13} /> : <Bot size={13} />}
            {t(createInitialBaseline ? "建立安全基线并一键委派" : "开始串行委派")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
