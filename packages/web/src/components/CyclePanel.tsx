/**
 * @input  依赖：编排快照里的活动圆桌、可用 Agent 名册与受控的开局/回答操作
 * @output 导出：CyclePanel 开局名册勾选、阶段进度、发言立场与阻塞提问作答台
 * @pos    Inspector 内圆桌讨论的唯一控制面——用户只在这里点两次：开局，和回答提问
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  CircleHelp,
  Gavel,
  LoaderCircle,
  MessagesSquare,
  Play,
  ThumbsUp,
  TriangleAlert,
} from "lucide-react";
import { useMemo, useState, type ReactElement } from "react";
import type {
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

/** 默认轮次预算与服务端 DEFAULT_ROUND_BUDGET 一致：提案 + 一轮反驳 + 一轮复核。 */
const DEFAULT_ROUND_BUDGET = 3;

export interface CyclePanelProps {
  topicId: string;
  isTopicOpen: boolean;
  snapshot: OrchestrationSnapshot | null;
  busyAction: string | null;
  onStart: (participants: string[], roundBudget: number) => Promise<boolean>;
  onAnswer: (questionMessageId: string, content: string) => Promise<boolean>;
}

function adapterLabel(
  adapters: readonly OrchestrationAdapter[],
  adapterId: string,
): string {
  return adapters.find((candidate) => candidate.id === adapterId)?.label ?? adapterId;
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
  isTopicOpen,
  busy,
  onStart,
}: {
  adapters: readonly OrchestrationAdapter[];
  isTopicOpen: boolean;
  busy: boolean;
  onStart: CyclePanelProps["onStart"];
}): ReactElement {
  const available = useMemo(
    () => adapters.filter((adapter) => adapter.available),
    [adapters],
  );
  // 勾选顺序即发言顺序：第一位是提案人，其余是评审。用数组而非 Set 就是为了留住顺序。
  const [roster, setRoster] = useState<string[]>([]);
  const [roundBudget, setRoundBudget] = useState(DEFAULT_ROUND_BUDGET);

  const toggle = (adapterId: string): void => {
    setRoster((current) =>
      current.includes(adapterId)
        ? current.filter((item) => item !== adapterId)
        : [...current, adapterId],
    );
  };

  const canStart = isTopicOpen && !busy && roster.length >= 2;

  return (
    <div className="cycle-starter">
      <p className="cycle-hint">
        勾选参与者，第一位是提案人。开局后由编排层自动交接，只有被提问时才需要你介入。
      </p>
      <ul className="cycle-roster">
        {available.map((adapter) => {
          const order = roster.indexOf(adapter.id);
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
                {order === 0 ? <span className="cycle-badge">提案人</span> : null}
                {order > 0 ? (
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
        <span className="cycle-hint-inline">吵满仍未一致就放弃，交回给你</span>
      </label>
      <button
        type="button"
        className="primary-button"
        disabled={!canStart}
        onClick={() => {
          void onStart(roster, roundBudget);
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

export function CyclePanel({
  topicId,
  isTopicOpen,
  snapshot,
  busyAction,
  onStart,
  onAnswer,
}: CyclePanelProps): ReactElement | null {
  const adapters = snapshot?.capabilities?.adapters ?? [];
  const view = snapshot?.activeTopicId === topicId ? snapshot.cycle : undefined;
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
            {STAGE_LABELS[view.cycle.stage]}
          </span>
        ) : null}
      </header>

      {view ? (
        <>
          <StageTrack view={view} />
          <BlockingQuestion view={view} busy={busy} onAnswer={onAnswer} />
          <ol className="cycle-turns">
            {view.cycle.turns.map((turn) => (
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
              </li>
            ))}
          </ol>
        </>
      ) : (
        <CycleStarter
          adapters={adapters}
          isTopicOpen={isTopicOpen}
          busy={busy}
          onStart={onStart}
        />
      )}
    </section>
  );
}
