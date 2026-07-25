/**
 * @input  依赖：自动轮次快照、当前议题和受控运行操作
 * @output 导出：AutoRoundsPanel 单一当前调用卡、折叠历史与按需复核操作台
 * @pos    Inspector 内创建、观察、批准、恢复和取消 Agent 调用的紧凑控制台
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  Bot,
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
import { useEffect, useMemo, useState } from "react";
import type {
  OrchestrationMessageKind,
  OrchestrationRun,
  OrchestrationSnapshot,
} from "../types/orchestration";
import { BrandGlyph } from "./BrandGlyph";

const KIND_OPTIONS: ReadonlyArray<{
  value: OrchestrationMessageKind;
  label: string;
}> = [
  { value: "brief", label: "Brief" },
  { value: "proposal", label: "Proposal" },
  { value: "critique", label: "Critique" },
  { value: "rebuttal", label: "Rebuttal" },
  { value: "synthesis", label: "Synthesis" },
  { value: "note", label: "Note" },
];

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
  snapshot: OrchestrationSnapshot | null;
  busyAction: string | null;
  onCreateAndStart: (
    adapterId: string,
    messageKind: OrchestrationMessageKind,
    instruction: string,
    confirmationBeforeCompletion: boolean,
  ) => Promise<boolean>;
  onStart: (runId: string) => Promise<void>;
  onApprove: (run: OrchestrationRun) => Promise<void>;
  onCancel: (runId: string) => Promise<void>;
  onRecover: (runId: string) => Promise<void>;
}

export function AutoRoundsPanel({
  topicId,
  snapshot,
  busyAction,
  onCreateAndStart,
  onStart,
  onApprove,
  onCancel,
  onRecover,
}: AutoRoundsPanelProps) {
  const adapters = snapshot?.capabilities?.adapters ?? [];
  const availableAdapters = useMemo(
    () => adapters.filter((adapter) => adapter.available),
    [adapters],
  );
  const [adapterId, setAdapterId] = useState("");
  const [messageKind, setMessageKind] = useState<OrchestrationMessageKind>("proposal");
  const [instruction, setInstruction] = useState("");
  const defaultConfirmation =
    snapshot?.capabilities?.defaultPolicy.confirmation.beforeCompletion
    ?? false;
  const [confirmationBeforeCompletion, setConfirmationBeforeCompletion] =
    useState(defaultConfirmation);

  useEffect(() => {
    if (!availableAdapters.some((adapter) => adapter.id === adapterId)) {
      setAdapterId(availableAdapters[0]?.id ?? "");
    }
  }, [adapterId, availableAdapters]);

  useEffect(() => {
    setConfirmationBeforeCompletion(defaultConfirmation);
  }, [defaultConfirmation]);

  const runs = snapshot?.activeTopicId === topicId ? snapshot.runs : [];
  const { primaryRun, historyRuns } = partitionRunsForDisplay(runs);
  const createBlockedReason = getCreateRunBlockedReason(runs, busyAction);
  const isCreateBlocked = createBlockedReason !== undefined;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const normalizedInstruction = instruction.trim();
    if (isCreateBlocked || !adapterId || !normalizedInstruction) {
      return;
    }
    const succeeded = await onCreateAndStart(
      adapterId,
      messageKind,
      normalizedInstruction,
      confirmationBeforeCompletion,
    );
    if (succeeded) {
      setInstruction("");
    }
  }

  return (
    <section className="auto-rounds-card" aria-labelledby="auto-rounds-title">
      <header className="auto-rounds-heading">
        <div>
          <span className="auto-rounds-kicker"><Zap size={12} /> Orchestration</span>
          <h3 id="auto-rounds-title">Agent 调用</h3>
        </div>
        <span className={`mini-sync mini-sync-${snapshot?.sync.status ?? "syncing"}`}>
          {snapshot?.sync.status === "offline" ? "离线" : "LIVE"}
        </span>
      </header>

      <div className="adapter-ledger" aria-label="Agent 主动调用能力">
        {adapters.length > 0 ? adapters.map((adapter) => (
          <div className="adapter-ledger-row" key={adapter.id}>
            <span className="adapter-ledger-brand">
              <BrandGlyph brand={adapter.brand} size={16} />
              <i className={`adapter-light ${adapter.available ? "is-available" : "is-limited"}`} />
            </span>
            <div>
              <strong>{adapter.label}</strong>
              <small>
                {adapter.available
                  ? "可由 Web 主动调用"
                  : adapter.limitation ?? "当前不可主动调用"}
              </small>
            </div>
          </div>
        )) : (
          <p className="auto-rounds-empty">正在读取 Agent 能力…</p>
        )}
      </div>

      <p className="runtime-boundary">
        {availableAdapters.length > 0
          ? `可主动调用：${availableAdapters.map((adapter) => adapter.label).join("、")}`
          : adapters[0]?.limitation ?? "当前没有可主动调用的 Agent。"}
      </p>

      <form className="auto-round-form" onSubmit={(event) => void handleSubmit(event)}>
        <div className="auto-round-fields">
          <label>
            <span>Agent</span>
            <select
              value={adapterId}
              disabled={isCreateBlocked || availableAdapters.length === 0}
              onChange={(event) => setAdapterId(event.target.value)}
            >
              {availableAdapters.map((adapter) => (
                <option value={adapter.id} key={adapter.id}>{adapter.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>消息类型</span>
            <select
              value={messageKind}
              disabled={isCreateBlocked}
              onChange={(event) => setMessageKind(event.target.value as OrchestrationMessageKind)}
            >
              {KIND_OPTIONS.map((kind) => (
                <option value={kind.value} key={kind.value}>{kind.label}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="auto-round-instruction">
          <span>本轮指令</span>
          <textarea
            value={instruction}
            disabled={isCreateBlocked}
            rows={3}
            placeholder="例如：先给出可回滚的最小架构方案，并列出失败条件。"
            onChange={(event) => setInstruction(event.target.value)}
          />
        </label>
        <label className="completion-review-option">
          <input
            type="checkbox"
            checked={confirmationBeforeCompletion}
            disabled={isCreateBlocked}
            onChange={(event) => setConfirmationBeforeCompletion(event.target.checked)}
          />
          <span>
            <strong>完成前需要我确认</strong>
            <small>关闭时，Agent 回复完成后自动归档。</small>
          </span>
        </label>
        {createBlockedReason ? (
          <p className="auto-round-blocked">{createBlockedReason}</p>
        ) : null}
        <button
          className="auto-round-launch"
          type="submit"
          disabled={isCreateBlocked || !adapterId || !instruction.trim()}
        >
          {busyAction === "create"
            ? <LoaderCircle className="spinning" size={15} />
            : <Play size={15} />}
          {busyAction === "create" ? "正在启动 Agent…" : "启动 Agent"}
        </button>
      </form>

      <div className="run-stack" aria-live="polite">
        {!primaryRun ? (
          <div className="auto-rounds-empty">
            <Bot size={17} />
            <span>当前议题还没有 Agent 调用。</span>
          </div>
        ) : (
          <RunCard
            run={primaryRun}
            busyAction={busyAction}
            onStart={onStart}
            onApprove={onApprove}
            onCancel={onCancel}
            onRecover={onRecover}
          />
        )}
        {historyRuns.length > 0 ? (
          <details className="run-history">
            <summary>
              <span><History size={13} /> 历史调用</span>
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
          <strong>{STATUS_LABELS[run.status]}</strong>
        </div>
        <span className="run-version">v{run.version}</span>
      </header>
      <dl className="run-metrics">
        <div><dt>轮次</dt><dd>{displayedRound}/{totalRounds}</dd></div>
        <div><dt>尝试</dt><dd>{run.currentAttempt}</dd></div>
        <div><dt>Agent</dt><dd>{displayedAgent}</dd></div>
      </dl>
      {run.pendingGateId ? (
        <p className="run-gate">
          <ShieldAlert size={13} />
          {isCompletionGate
            ? "回复已生成，等待你确认归档"
            : "下一轮开始前等待你确认"}
        </p>
      ) : null}
      {run.failure ? (
        <p className="run-failure"><ShieldAlert size={13} /> {run.failure.message}</p>
      ) : null}
      {recoveryBudgetExhausted ? (
        <p className="run-budget"><ShieldAlert size={13} /> 人工恢复预算已耗尽</p>
      ) : null}
      <div className="run-actions">
        {run.status === "idle" ? (
          <RunButton disabled={isBusy} icon={<Play size={13} />} onClick={() => onStart(run.id)}>
            启动
          </RunButton>
        ) : null}
        {run.status === "waiting_user" ? (
          <RunButton disabled={isBusy} icon={<CheckCircle2 size={13} />} onClick={() => onApprove(run)}>
            {isCompletionGate ? "确认并完成" : "批准继续"}
          </RunButton>
        ) : null}
        {run.status === "failed" && !recoveryBudgetExhausted ? (
          <RunButton disabled={isBusy} icon={<RotateCcw size={13} />} onClick={() => onRecover(run.id)}>
            恢复
          </RunButton>
        ) : null}
        {isActive ? (
          <RunButton
            danger
            disabled={isBusy}
            icon={<CircleStop size={13} />}
            onClick={() => onCancel(run.id)}
          >
            取消
          </RunButton>
        ) : null}
      </div>
    </article>
  );
}

interface RunHistoryRowProps {
  run: OrchestrationRun;
  busyAction: string | null;
  onRecover: (runId: string) => Promise<void>;
}

function RunHistoryRow({ run, busyAction, onRecover }: RunHistoryRowProps) {
  const recoveryBudgetExhausted = isRecoveryBudgetExhausted(run);
  const agentId = run.activeAgentId ?? run.plan[0]?.adapterId ?? "—";
  return (
    <article className={`run-history-row run-status-${run.status}`}>
      <span className="run-history-status-dot" aria-hidden="true" />
      <span className="run-history-main">
        <strong>{STATUS_LABELS[run.status]}</strong>
        <small>{run.id.slice(0, 14)} · {agentId}</small>
      </span>
      {run.status === "failed" && !recoveryBudgetExhausted ? (
        <RunButton
          disabled={busyAction !== null}
          icon={<RotateCcw size={12} />}
          onClick={() => onRecover(run.id)}
        >
          恢复
        </RunButton>
      ) : null}
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
