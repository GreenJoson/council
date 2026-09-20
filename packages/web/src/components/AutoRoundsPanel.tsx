/**
 * @input  依赖：界面语言上下文、自动轮次快照、当前议题开放状态和受控运行操作
 * @output 导出：AutoRoundsPanel 按需运行状态、单一当前调用卡、折叠历史、执行审计与恢复控制
 * @pos    Inspector 内仅在存在 Run/Binding 时出现的观察、批准、恢复和取消控制台；
 *         单次创建统一由 Composer @Agent 承担
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { RuntimeAuditDetails } from "./RuntimeAuditDetails";

import {
  CheckCircle2,
  ChevronDown,
  CircleStop,
  History,
  LoaderCircle,
  Play,
  RotateCcw,
  ShieldAlert,
  Zap,
} from "lucide-react";
import type {
  OrchestrationRun,
  OrchestrationSnapshot,
  RuntimeBinding,
} from "../types/orchestration";
import { useI18n } from "../i18n/I18nProvider";
import { BrandGlyph } from "./BrandGlyph";

const STATUS_LABELS: Readonly<Record<OrchestrationRun["status"], string>> = {
  idle: "待启动",
  running: "编排中",
  waiting_agent: "等待 Agent",
  waiting_user: "等待确认",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const CREATE_BLOCKING_STATUSES: ReadonlySet<OrchestrationRun["status"]> = new Set([
  "idle",
  "running",
  "waiting_agent",
  "waiting_user",
]);

const BINDING_STATUS_LABELS: Readonly<Record<RuntimeBinding["status"], string>> = {
  starting: "正在连接",
  ready: "已连接",
  thinking: "正在思考",
  streaming: "正在回复",
  idle: "会话待命",
  interrupted: "连接中断",
  closing: "正在关闭",
  closed: "已关闭",
};

export function latestRuntimeBindings(
  bindings: readonly RuntimeBinding[],
): RuntimeBinding[] {
  const latestByAgent = new Map<string, RuntimeBinding>();
  for (const binding of bindings) {
    const current = latestByAgent.get(binding.agentId);
    if (!current || binding.createdAt > current.createdAt) {
      latestByAgent.set(binding.agentId, binding);
    }
  }
  return [...latestByAgent.values()].sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt),
  );
}

export function getCreateRunBlockedReason(
  runs: readonly OrchestrationRun[],
  busyAction: string | null,
): string | undefined {
  if (busyAction) {
    return "已有编排操作正在处理，请稍候。";
  }
  if (runs.some((run) => CREATE_BLOCKING_STATUSES.has(run.status))) {
    return "当前已有 Agent 调用正在处理，请先等待、确认或取消。";
  }
  return undefined;
}

export function getTopicAgentCallBlockedReason(isTopicOpen: boolean): string | undefined {
  return isTopicOpen
    ? undefined
    : "议题已经决策，不能再启动、重开或通过 @ 召唤 Agent。";
}

export function isRecoveryBudgetExhausted(run: OrchestrationRun): boolean {
  return run.status === "failed"
    && run.manualRecoveriesUsed >= run.policy.maxManualRecoveries;
}

const PRIMARY_RUN_STATUSES: ReadonlySet<OrchestrationRun["status"]> = new Set([
  "idle",
  "running",
  "waiting_agent",
  "waiting_user",
]);

export interface RunDisplayPartition {
  primaryRun?: OrchestrationRun;
  historyRuns: OrchestrationRun[];
}

export function partitionRunsForDisplay(
  runs: readonly OrchestrationRun[],
): RunDisplayPartition {
  const primaryRun = runs.find((run) => PRIMARY_RUN_STATUSES.has(run.status)) ?? runs[0];
  return {
    primaryRun,
    historyRuns: primaryRun
      ? runs.filter((run) => run.id !== primaryRun.id)
      : [],
  };
}

export interface AutoRoundsPanelProps {
  topicId: string;
  isTopicOpen: boolean;
  snapshot: OrchestrationSnapshot | null;
  busyAction: string | null;
  onStart: (runId: string) => Promise<void>;
  onApprove: (run: OrchestrationRun) => Promise<void>;
  onCancel: (runId: string) => Promise<void>;
  onRecover: (runId: string) => Promise<void>;
  onCloseBinding: (bindingId: string) => Promise<void>;
  onReopenBinding: (bindingId: string) => Promise<void>;
}

export function AutoRoundsPanel({
  topicId,
  isTopicOpen,
  snapshot,
  busyAction,
  onStart,
  onApprove,
  onCancel,
  onRecover,
  onCloseBinding,
  onReopenBinding,
}: AutoRoundsPanelProps) {
  const { t } = useI18n();
  const adapters = snapshot?.capabilities?.adapters ?? [];
  const runs = snapshot?.activeTopicId === topicId ? snapshot.runs : [];
  const runtimeBindings = snapshot?.activeTopicId === topicId
    ? latestRuntimeBindings(snapshot.runtimeBindings ?? [])
    : [];
  const { primaryRun, historyRuns } = partitionRunsForDisplay(runs);
  if (!primaryRun && runtimeBindings.length === 0) {
    return null;
  }

  return (
    <section className="auto-rounds-card" aria-labelledby="auto-rounds-title">
      <header className="auto-rounds-heading">
        <div>
          <span className="auto-rounds-kicker"><Zap size={12} /> Activity</span>
          <h3 id="auto-rounds-title">{t("运行状态")}</h3>
        </div>
        <span className={`mini-sync mini-sync-${snapshot?.sync.status ?? "syncing"}`}>
          {snapshot?.sync.status === "offline" ? t("离线") : "LIVE"}
        </span>
      </header>

      {runtimeBindings.length > 0 ? (
        <div className="runtime-binding-list" aria-label={t("当前议题持久会话")}>
          {runtimeBindings.map((binding) => {
            const adapter = adapters.find((candidate) => candidate.id === binding.agentId);
            const isClosed = binding.status === "closed";
            const isBusy = binding.status === "starting"
              || binding.status === "thinking"
              || binding.status === "streaming"
              || binding.status === "closing";
            return (
              <article className={`runtime-binding-row runtime-binding-${binding.status}`} key={binding.id}>
                <BrandGlyph brand={adapter?.brand} size={16} />
                <span className="runtime-binding-main">
                  <strong>{adapter?.label ?? binding.agentId}</strong>
                  <small>
                    {t(BINDING_STATUS_LABELS[binding.status])}
                    {binding.hasSession ? t(" · 已复用上下文") : t(" · 首轮上下文")}
                  </small>
                </span>
                <button
                  type="button"
                  className="runtime-binding-action"
                  disabled={Boolean(busyAction) || isBusy || (isClosed && !isTopicOpen)}
                  onClick={() => void (
                    isClosed
                      ? onReopenBinding(binding.id)
                      : onCloseBinding(binding.id)
                  )}
                >
                  {isClosed ? <RotateCcw size={12} /> : <CircleStop size={12} />}
                  {isClosed ? t("重开") : t("关闭")}
                </button>
              </article>
            );
          })}
        </div>
      ) : null}

      {primaryRun ? (
        <div className="run-stack" aria-live="polite">
          <RunCard
            run={primaryRun}
            busyAction={busyAction}
            onStart={onStart}
            onApprove={onApprove}
            onCancel={onCancel}
            onRecover={onRecover}
          />
          {historyRuns.length > 0 ? (
            <details className="run-history">
              <summary>
                <span><History size={13} /> {t("历史调用")}</span>
                <span>{historyRuns.length} <ChevronDown size={13} /></span>
              </summary>
              <div className="run-history-list">
                {historyRuns.map((run) => (
                  <RunHistoryRow
                    key={run.id}
                    run={run}
                    busyAction={busyAction}
                    onRecover={onRecover}
                  />
                ))}
              </div>
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

interface RunCardProps {
  run: OrchestrationRun;
  busyAction: string | null;
  onStart: (runId: string) => Promise<void>;
  onApprove: (run: OrchestrationRun) => Promise<void>;
  onCancel: (runId: string) => Promise<void>;
  onRecover: (runId: string) => Promise<void>;
}

function RunCard({ run, busyAction, onStart, onApprove, onCancel, onRecover }: RunCardProps) {
  const { t } = useI18n();
  const isBusy = busyAction !== null;
  const isActive = ["running", "waiting_agent", "waiting_user"].includes(run.status);
  const recoveryBudgetExhausted = isRecoveryBudgetExhausted(run);
  const totalRounds = run.plan.length;
  const displayedRound = Math.min(run.nextRoundIndex + 1, totalRounds);
  const displayedAgent =
    run.activeAgentId
    ?? run.plan[Math.min(run.nextRoundIndex, Math.max(totalRounds - 1, 0))]?.adapterId
    ?? "—";
  const isCompletionGate = run.pendingGateId === "before_completion";

  return (
    <article className={`run-card run-status-${run.status}`}>
      <header>
        <div>
          <span className="run-id">{run.id.slice(0, 14)}</span>
          <strong>{t(STATUS_LABELS[run.status])}</strong>
        </div>
        <span className="run-version">v{run.version}</span>
      </header>
      <dl className="run-metrics">
        <div><dt>{t("轮次")}</dt><dd>{displayedRound}/{totalRounds}</dd></div>
        <div><dt>{t("尝试")}</dt><dd>{run.currentAttempt}</dd></div>
        <div><dt>Agent</dt><dd>{displayedAgent}</dd></div>
      </dl>
      {run.pendingGateId ? (
        <p className="run-gate">
          <ShieldAlert size={13} />
          {isCompletionGate
            ? t("回复已生成，等待你确认归档")
            : t("下一轮开始前等待你确认")}
        </p>
      ) : null}
      {run.failure ? (
        <p className="run-failure"><ShieldAlert size={13} /> {run.failure.message}</p>
      ) : null}
      {recoveryBudgetExhausted ? (
        <p className="run-budget"><ShieldAlert size={13} /> {t("人工恢复预算已耗尽")}</p>
      ) : null}
      <div className="run-actions">
        {run.status === "idle" ? (
          <RunButton disabled={isBusy} icon={<Play size={13} />} onClick={() => onStart(run.id)}>
            {t("启动")}
          </RunButton>
        ) : null}
        {run.status === "waiting_user" ? (
          <RunButton disabled={isBusy} icon={<CheckCircle2 size={13} />} onClick={() => onApprove(run)}>
            {isCompletionGate ? t("确认并完成") : t("批准继续")}
          </RunButton>
        ) : null}
        {run.status === "failed" && !recoveryBudgetExhausted ? (
          <RunButton disabled={isBusy} icon={<RotateCcw size={13} />} onClick={() => onRecover(run.id)}>
            {t("恢复")}
          </RunButton>
        ) : null}
        {isActive ? (
          <RunButton
            danger
            disabled={isBusy}
            icon={<CircleStop size={13} />}
            onClick={() => onCancel(run.id)}
          >
            {t("取消")}
          </RunButton>
        ) : null}
      </div>
      <RuntimeAuditDetails topicId={run.topicId} sourceKind="run" sourceId={run.id} />
    </article>
  );
}

interface RunHistoryRowProps {
  run: OrchestrationRun;
  busyAction: string | null;
  onRecover: (runId: string) => Promise<void>;
}

function RunHistoryRow({ run, busyAction, onRecover }: RunHistoryRowProps) {
  const { t } = useI18n();
  const recoveryBudgetExhausted = isRecoveryBudgetExhausted(run);
  const agentId = run.activeAgentId ?? run.plan[0]?.adapterId ?? "—";
  return (
    <article className={`run-history-row run-status-${run.status}`}>
      <span className="run-history-status-dot" aria-hidden="true" />
      <span className="run-history-main">
        <strong>{t(STATUS_LABELS[run.status])}</strong>
        <small>{run.id.slice(0, 14)} · {agentId}</small>
      </span>
      {run.status === "failed" && !recoveryBudgetExhausted ? (
        <RunButton
          disabled={busyAction !== null}
          icon={<RotateCcw size={12} />}
          onClick={() => onRecover(run.id)}
        >
          {t("恢复")}
        </RunButton>
      ) : null}
      <RuntimeAuditDetails topicId={run.topicId} sourceKind="run" sourceId={run.id} />
    </article>
  );
}

interface RunButtonProps {
  children: React.ReactNode;
  icon: React.ReactNode;
  disabled: boolean;
  danger?: boolean;
  onClick: () => Promise<void>;
}

function RunButton({ children, icon, disabled, danger, onClick }: RunButtonProps) {
  return (
    <button
      className={`run-action-button ${danger ? "danger" : ""}`}
      type="button"
      disabled={disabled}
      onClick={() => void onClick()}
    >
      {disabled ? <LoaderCircle className="spinning" size={13} /> : icon}
      {children}
    </button>
  );
}
