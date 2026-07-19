/**
 * @input  依赖：自动轮次快照、当前议题和受控运行操作
 * @output 导出：AutoRoundsPanel 紧凑编排控制卡片
 * @pos    Inspector 内创建、观察、批准、恢复和取消自动轮次的操作台
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  Bot,
  CheckCircle2,
  CircleStop,
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
    return "当前已有待启动或进行中的 Run，请先处理后再新建。";
  }
  return undefined;
}

export function isRecoveryBudgetExhausted(run: OrchestrationRun): boolean {
  return run.status === "failed"
    && run.manualRecoveriesUsed >= run.policy.maxManualRecoveries;
}

export interface AutoRoundsPanelProps {
  topicId: string;
  snapshot: OrchestrationSnapshot | null;
  busyAction: string | null;
  onCreateAndStart: (
    adapterId: string,
    messageKind: OrchestrationMessageKind,
    instruction: string,
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

  useEffect(() => {
    if (!availableAdapters.some((adapter) => adapter.id === adapterId)) {
      setAdapterId(availableAdapters[0]?.id ?? "");
    }
  }, [adapterId, availableAdapters]);

  const runs = snapshot?.activeTopicId === topicId ? snapshot.runs : [];
  const createBlockedReason = getCreateRunBlockedReason(runs, busyAction);
  const isCreateBlocked = createBlockedReason !== undefined;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const normalizedInstruction = instruction.trim();
    if (isCreateBlocked || !adapterId || !normalizedInstruction) {
      return;
    }
    const succeeded = await onCreateAndStart(adapterId, messageKind, normalizedInstruction);
    if (succeeded) {
      setInstruction("");
    }
  }

  return (
    <section className="auto-rounds-card" aria-labelledby="auto-rounds-title">
      <header className="auto-rounds-heading">
        <div>
          <span className="auto-rounds-kicker"><Zap size={12} /> Orchestration</span>
          <h3 id="auto-rounds-title">自动轮次</h3>
        </div>
        <span className={`mini-sync mini-sync-${snapshot?.sync.status ?? "syncing"}`}>
          {snapshot?.sync.status === "offline" ? "离线" : "LIVE"}
        </span>
      </header>

      <div className="adapter-ledger" aria-label="Agent 主动调用能力">
        {adapters.length > 0 ? adapters.map((adapter) => (
          <div className="adapter-ledger-row" key={adapter.id}>
            <span className={`adapter-light ${adapter.available ? "is-available" : "is-limited"}`} />
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
          ? "Claude 可主动调用；Codex 当前仅自动共享回帖，不会从 Web 主动唤醒。"
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
          {busyAction === "create" ? "创建并启动中…" : "创建并启动"}
        </button>
      </form>

      <div className="run-stack" aria-live="polite">
        {runs.length === 0 ? (
          <div className="auto-rounds-empty">
            <Bot size={17} />
            <span>当前议题还没有自动轮次。</span>
          </div>
        ) : runs.map((run) => (
          <RunCard
            key={run.id}
            run={run}
            busyAction={busyAction}
            onStart={onStart}
            onApprove={onApprove}
            onCancel={onCancel}
            onRecover={onRecover}
          />
        ))}
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
        <div><dt>Agent</dt><dd>{run.activeAgentId ?? run.plan[run.nextRoundIndex]?.adapterId ?? "—"}</dd></div>
      </dl>
      {run.pendingGateId ? (
        <p className="run-gate"><ShieldAlert size={13} /> {run.pendingGateId}</p>
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
            批准继续
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
