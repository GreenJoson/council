/**
 * @input  依赖：议题发起人、编排快照里的活动圆桌、可用 Agent 名册与受控开局/回答操作
 * @output 导出：CyclePanel 三段审查范围、名册能力校验、阶段进度、阻塞提问与累计度量
 * @pos    Inspector 内圆桌讨论的唯一控制面——用户只在这里点两次：开局，和回答提问
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  CircleHelp,
  CircleStop,
  Gavel,
  LoaderCircle,
  MessagesSquare,
  Play,
  ThumbsUp,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { useMemo, useState, type ReactElement } from "react";
import type {
  CycleMetrics,
  CycleReviewScope,
  CycleStage,
  CycleTurn,
  DiscussionCycleView,
  OrchestrationAdapter,
  OrchestrationSnapshot,
} from "../types/orchestration";
import { BrandGlyph } from "./BrandGlyph";

const STAGE_LABELS: Readonly<Record<CycleStage, string>> = {
  proposal: "提案",
  critique: "评审",
  rebuttal: "反驳",
  synthesis: "收敛",
  awaiting_user: "等你回答",
  completed: "已收敛",
};

const STANCE_LABELS: Readonly<Record<CycleTurn["stance"], string>> = {
  agree: "同意",
  non_blocking: "有保留",
  blocking: "阻塞异议",
};

const STOP_REASON_LABELS: Readonly<Record<string, string>> = {
  converged: "已收敛并生成待确认决策",
  round_budget_exhausted: "轮次预算耗尽，仍有阻断异议",
  decision_accepted: "用户已接受决策",
  cancelled: "用户已取消本轮圆桌",
};

/** 默认轮次预算与服务端 DEFAULT_ROUND_BUDGET 一致：提案 + 一轮反驳 + 一轮复核。 */
const DEFAULT_ROUND_BUDGET = 3;

const REVIEW_SCOPE_OPTIONS: ReadonlyArray<{
  value: CycleReviewScope;
  label: string;
  description: string;
}> = [
  { value: "discussion", label: "方案", description: "审设计与取舍" },
  { value: "workspace", label: "工作区", description: "审当前本地代码" },
  { value: "commit", label: "Commit", description: "审冻结提交" },
];

const REVIEW_SCOPE_LABELS: Readonly<Record<CycleReviewScope, string>> = {
  discussion: "方案讨论",
  workspace: "工作区互审",
  commit: "Commit 互审",
};

export interface CyclePanelProps {
  topicId: string;
  initiatorActorId: string;
  isTopicOpen: boolean;
  snapshot: OrchestrationSnapshot | null;
  busyAction: string | null;
  onStart: (
    participants: string[],
    roundBudget: number,
    reviewScope: CycleReviewScope,
  ) => Promise<boolean>;
  onAnswer: (questionMessageId: string, content: string) => Promise<boolean>;
  /** 外部 Agent 修完之后开下一轮复审；条目是否关闭仍由复审判定。 */
  onSubmitFixes: () => Promise<void>;
  onAbandon: () => Promise<void>;
}

/**
 * 审核闭环的等待位。
 *
 * 圆桌不销毁也不空转：清单摆在这里，外部 Agent 认领修复、提交，
 * 再由这颗按钮开下一轮复审——用户不必为了继续而重开一个新圆桌。
 */
function AwaitingFix({
  view,
  busy,
  onSubmitFixes,
}: {
  view: DiscussionCycleView;
  busy: boolean;
  onSubmitFixes: CyclePanelProps["onSubmitFixes"];
}): ReactElement | null {
  if (view.action?.kind !== "await_fix") {
    return null;
  }
  const open = view.reviewLedger?.openBlockingFindings ?? 0;
  return (
    <div className="cycle-await-fix">
      <p className="cycle-await-fix-title">
        <Wrench size={13} /> 等待修复
        {open > 0 ? ` · 还有 ${String(open)} 条阻断问题未关闭` : ""}
      </p>
      <p className="cycle-await-fix-hint">
        审出的问题已经落成实施项，可以认领和跟踪。修完并提交后开下一轮复审；
        条目是否关闭由复审读真实 diff 判定，不由修复者宣布。
      </p>
      <button
        type="button"
        className="primary-button cycle-await-fix-action"
        disabled={busy}
        onClick={() => { void onSubmitFixes(); }}
      >
        <Wrench size={14} /> 已修复，开始复审
      </button>
    </div>
  );
}

function adapterLabel(
  adapters: readonly OrchestrationAdapter[],
  adapterId: string,
): string {
  return adapters.find((candidate) => candidate.id === adapterId)?.label ?? adapterId;
}

function runtimeCapabilityLabel(adapter: OrchestrationAdapter): string {
  if (adapter.runtimeCapabilities.includes("repository_write")) {
    return "可执行修复";
  }
  if (adapter.runtimeCapabilities.includes("repository_read")) {
    return "只读项目";
  }
  return "仅文本";
}

function StageTrack({ view }: { view: DiscussionCycleView }): ReactElement {
  const { cycle } = view;
  const stages: CycleStage[] = ["proposal", "critique", "rebuttal", "synthesis"];
  const activeIndex = stages.indexOf(cycle.stage as CycleStage);
  return (
    <ol className="cycle-track">
      {stages.map((stage, index) => (
        <li
          key={stage}
          className={
            index === activeIndex
              ? "cycle-track-step is-active"
              : index < activeIndex
                ? "cycle-track-step is-done"
                : "cycle-track-step"
          }
        >
          {STAGE_LABELS[stage]}
        </li>
      ))}
    </ol>
  );
}

function CycleStarter({
  adapters,
  initiatorActorId,
  isTopicOpen,
  busy,
  onStart,
}: {
  adapters: readonly OrchestrationAdapter[];
  initiatorActorId: string;
  isTopicOpen: boolean;
  busy: boolean;
  onStart: CyclePanelProps["onStart"];
}): ReactElement {
  const available = useMemo(
    () => adapters.filter((adapter) => adapter.available),
    [adapters],
  );
  // 发起人入选时固定置首但不再次调用；其余 Agent 仍按勾选顺序评审。
  const [roster, setRoster] = useState<string[]>([]);
  const [roundBudget, setRoundBudget] = useState(DEFAULT_ROUND_BUDGET);
  const [reviewScope, setReviewScope] = useState<CycleReviewScope>("discussion");

  const toggle = (adapterId: string): void => {
    setRoster((current) =>
      current.includes(adapterId)
        ? current.filter((item) => item !== adapterId)
        : [...current, adapterId],
    );
  };

  const initiatorAdapterId = available.find(
    (adapter) => adapter.actorId === initiatorActorId,
  )?.id;
  const orderedRoster = initiatorAdapterId && roster.includes(initiatorAdapterId)
    ? [initiatorAdapterId, ...roster.filter((item) => item !== initiatorAdapterId)]
    : roster;
  const initiatorSelected = Boolean(
    initiatorAdapterId && orderedRoster[0] === initiatorAdapterId,
  );

  const missingScopeCapability = orderedRoster
    .map((adapterId) => available.find((adapter) => adapter.id === adapterId))
    .filter((adapter): adapter is OrchestrationAdapter => adapter !== undefined)
    .filter((adapter) =>
      reviewScope === "workspace"
        ? !adapter.runtimeCapabilities.includes("repository_read")
        : reviewScope === "commit"
          ? !adapter.runtimeCapabilities.includes("repository_read")
            || !adapter.runtimeCapabilities.includes("git_diff")
          : false,
    );
  const canStart = isTopicOpen
    && !busy
    && orderedRoster.length >= 2
    && missingScopeCapability.length === 0;

  return (
    <div className="cycle-starter">
      <fieldset className="cycle-review-scope" disabled={!isTopicOpen || busy}>
        <legend>审查范围</legend>
        <div className="cycle-scope-segments">
          {REVIEW_SCOPE_OPTIONS.map((option) => (
            <label
              className={`cycle-scope-option ${reviewScope === option.value ? "is-active" : ""}`}
              key={option.value}
            >
              <input
                type="radio"
                name="cycle-review-scope"
                value={option.value}
                checked={reviewScope === option.value}
                onChange={() => setReviewScope(option.value)}
              />
              <strong>{option.label}</strong>
              <small>{option.description}</small>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="cycle-hint">
        {initiatorSelected
          ? "议题发起人已冻结为提案人并跳过首轮；第一条调用从评审开始。"
          : reviewScope === "workspace"
            ? "发起人未入选；首位 Agent 提案后，其他评审读取当前工作区。"
          : reviewScope === "commit"
            ? "发起人未入选；首位 Agent 先从议题读取并验证仓库与 commit。"
            : "发起人未入选；第一位 Agent 作为提案人，其余按顺序评审。"}
      </p>
      <ul className="cycle-roster">
        {available.map((adapter) => {
          const order = orderedRoster.indexOf(adapter.id);
          const isInitiator = adapter.id === initiatorAdapterId;
          return (
            <li key={adapter.id}>
              <label className="cycle-roster-item">
                <input
                  type="checkbox"
                  checked={order >= 0}
                  disabled={!isTopicOpen || busy}
                  onChange={() => { toggle(adapter.id); }}
                />
                <BrandGlyph brand={adapter.brand} size={16} />
                <span className="cycle-roster-name">{adapter.label}</span>
                <span className="cycle-hint-inline">
                  {runtimeCapabilityLabel(adapter)}
                </span>
                {isInitiator ? (
                  <span className={`cycle-badge ${order < 0 ? "is-muted" : ""}`}>
                    {order >= 0 ? "发起人 · 跳过首轮" : "发起人"}
                  </span>
                ) : order === 0 ? (
                  <span className="cycle-badge">提案人</span>
                ) : null}
                {!isInitiator && order > 0 ? (
                  <span className="cycle-badge is-muted">评审 {order}</span>
                ) : null}
              </label>
            </li>
          );
        })}
      </ul>
      {available.length < 2 ? (
        <p className="cycle-warning">
          <TriangleAlert size={14} />
          可用 Agent 不足两位，无法互审。请先在设置里连接第二个 Provider。
        </p>
      ) : null}
      {missingScopeCapability.length > 0 ? (
        <p className="cycle-warning">
          <TriangleAlert size={14} />
          {missingScopeCapability.map((adapter) => adapter.label).join("、")}
          不具备当前审查范围所需的项目读取能力。
        </p>
      ) : null}
      <label className="cycle-budget">
        轮次预算
        <input
          type="number"
          min={1}
          max={10}
          value={roundBudget}
          disabled={!isTopicOpen || busy}
          onChange={(event) => {
            const parsed = Number.parseInt(event.target.value, 10);
            setRoundBudget(Number.isNaN(parsed) ? DEFAULT_ROUND_BUDGET : parsed);
          }}
        />
        <span className="cycle-hint-inline">预算耗尽时输出阻断清单并交回给你</span>
      </label>
      <button
        type="button"
        className="primary-button"
        disabled={!canStart}
        onClick={() => {
          void onStart(
            orderedRoster,
            roundBudget,
            reviewScope,
          );
        }}
      >
        {busy ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}
        开始圆桌
      </button>
    </div>
  );
}

function BlockingQuestion({
  view,
  busy,
  onAnswer,
}: {
  view: DiscussionCycleView;
  busy: boolean;
  onAnswer: CyclePanelProps["onAnswer"];
}): ReactElement | null {
  const question = view.openQuestion;
  const [answer, setAnswer] = useState("");
  if (!question) {
    return null;
  }
  const submit = (content: string): void => {
    const trimmed = content.trim();
    if (!trimmed || busy) {
      return;
    }
    void onAnswer(question.questionMessageId, trimmed).then((ok) => {
      if (ok) {
        setAnswer("");
      }
    });
  };
  return (
    <div className="cycle-question">
      <p className="cycle-question-title">
        <CircleHelp size={15} />
        讨论停在这里等你回答
      </p>
      <p className="cycle-question-body">{question.question}</p>
      <p className="cycle-question-rationale">{question.rationale}</p>
      {question.options.length > 0 ? (
        <div className="cycle-question-options">
          {question.options.map((option) => (
            <button
              key={option}
              type="button"
              className="ghost-button"
              disabled={busy}
              onClick={() => { submit(option); }}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      <textarea
        className="cycle-question-input"
        rows={3}
        value={answer}
        disabled={busy}
        placeholder="给出你的判断；这条会作为公开回复留在讨论里。"
        onChange={(event) => { setAnswer(event.target.value); }}
      />
      <button
        type="button"
        className="primary-button"
        disabled={busy || answer.trim().length === 0}
        onClick={() => { submit(answer); }}
      >
        {busy ? <LoaderCircle className="spin" size={15} /> : <Gavel size={15} />}
        提交回答并继续
      </button>
    </div>
  );
}

function CycleOutcome({
  view,
  adapters,
}: {
  view: DiscussionCycleView;
  adapters: readonly OrchestrationAdapter[];
}): ReactElement {
  const { cycle } = view;
  return (
    <div className={`cycle-question cycle-outcome is-${cycle.status}`}>
      <p className="cycle-question-title">
        {cycle.status === "completed"
          ? <ThumbsUp size={15} />
          : <TriangleAlert size={15} />}
        {STOP_REASON_LABELS[cycle.stopReason ?? ""] ?? "圆桌已经结束"}
      </p>
      {cycle.outcome?.kind === "blocking_disagreements" ? (
        <>
          <p className="cycle-question-rationale">
            下面这些公开发言仍为 blocking，未被静默当作共识：
          </p>
          <ul className="cycle-turns">
            {cycle.outcome.items.map((item) => (
              <li key={item.messageId} className="cycle-turn is-blocking">
                <span className="cycle-turn-agent">
                  {adapterLabel(adapters, item.agentId)}
                </span>
                <span className="cycle-turn-stage">第 {item.round} 轮</span>
                <span className="cycle-turn-stance">
                  <TriangleAlert size={13} />
                  {item.messageId.slice(0, 18)}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 60_000) {
    return `${String(Math.round(milliseconds / 1_000))} 秒`;
  }
  return `${String(Math.round(milliseconds / 60_000))} 分`;
}

/** 累计度量：这套流程到底有没有比手工来回搬运快，只能靠这几个数说话。 */
function MetricsLedger({ metrics }: { metrics: CycleMetrics }): ReactElement | null {
  if (metrics.cycles.total === 0) {
    return null;
  }
  const diverged = metrics.decisionConsistency.divergedCycleIds.length;
  return (
    <dl className="cycle-metrics">
      <div>
        <dt>收敛 / 放弃</dt>
        <dd>
          {metrics.cycles.converged} / {metrics.cycles.abandoned}
        </dd>
      </div>
      <div>
        <dt>轮次中位数</dt>
        <dd>{metrics.rounds.count > 0 ? metrics.rounds.median : "—"}</dd>
      </div>
      <div>
        <dt>耗时中位数</dt>
        <dd>
          {metrics.wallClockMs.count > 0
            ? formatDuration(metrics.wallClockMs.median)
            : "—"}
        </dd>
      </div>
      <div>
        <dt>平均打断</dt>
        <dd>{metrics.questions.perCycle} 次</dd>
      </div>
      <div className={metrics.verdicts.missing > 0 ? "cycle-metric-alert" : undefined}>
        <dt>协议缺失</dt>
        <dd>{metrics.verdicts.missing} / {metrics.verdicts.checked}</dd>
      </div>
      <div className={diverged > 0 ? "cycle-metric-alert" : undefined}>
        <dt>决策一致性</dt>
        <dd>
          {diverged > 0
            ? `${String(diverged)} 条与讨论不符`
            : `${String(metrics.decisionConsistency.checked)} 条全部一致`}
        </dd>
      </div>
    </dl>
  );
}

export function CyclePanel({
  topicId,
  initiatorActorId,
  isTopicOpen,
  snapshot,
  busyAction,
  onStart,
  onAnswer,
  onSubmitFixes,
  onAbandon,
}: CyclePanelProps): ReactElement | null {
  const adapters = snapshot?.capabilities?.adapters ?? [];
  const view = snapshot?.activeTopicId === topicId ? snapshot.cycle : undefined;
  const activeView = view?.cycle.status === "active" ? view : undefined;
  const busy = busyAction === "cycle";

  if (!snapshot?.capabilities) {
    return null;
  }

  return (
    <section className="auto-rounds-card cycle-card" aria-labelledby="cycle-title">
      <header className="auto-rounds-heading">
        <div>
          <span className="auto-rounds-kicker">
            <MessagesSquare size={12} /> Roundtable
          </span>
          <h3 id="cycle-title">圆桌讨论</h3>
        </div>
        {view ? (
          <span className="cycle-round">
            第 {view.cycle.currentRound}/{view.cycle.roundBudget} 轮 ·{" "}
            {STAGE_LABELS[view.cycle.stage]} ·{" "}
            {REVIEW_SCOPE_LABELS[view.cycle.requirements.reviewScope]}
          </span>
        ) : null}
      </header>

      {activeView ? (
        <>
          <StageTrack view={activeView} />
          <BlockingQuestion view={activeView} busy={busy} onAnswer={onAnswer} />
          <AwaitingFix view={activeView} busy={busy} onSubmitFixes={onSubmitFixes} />
          <ol className="cycle-turns">
            {activeView.cycle.turns.map((turn) => (
              <li key={turn.messageId} className={`cycle-turn is-${turn.stance}`}>
                <span className="cycle-turn-agent">
                  {adapterLabel(adapters, turn.agentId)}
                </span>
                <span className="cycle-turn-stage">{STAGE_LABELS[turn.stage]}</span>
                <span className="cycle-turn-stance">
                  {turn.stance === "agree" ? <ThumbsUp size={13} /> : null}
                  {turn.stance === "blocking" ? <TriangleAlert size={13} /> : null}
                  {STANCE_LABELS[turn.stance]}
                </span>
                {turn.verdictDeclared === false ? (
                  <span className="cycle-badge is-warning">缺少 verdict</span>
                ) : null}
              </li>
            ))}
          </ol>
          <button
            type="button"
            className="ghost-button cycle-abandon"
            disabled={busy}
            onClick={() => { void onAbandon(); }}
          >
            <CircleStop size={14} />
            放弃这次圆桌
          </button>
        </>
      ) : (
        <>
          {view ? <CycleOutcome view={view} adapters={adapters} /> : null}
          <CycleStarter
            adapters={adapters}
            initiatorActorId={initiatorActorId}
            isTopicOpen={isTopicOpen}
            busy={busy}
            onStart={onStart}
          />
        </>
      )}
      {snapshot.cycleMetrics ? (
        <MetricsLedger metrics={snapshot.cycleMetrics} />
      ) : null}
    </section>
  );
}
