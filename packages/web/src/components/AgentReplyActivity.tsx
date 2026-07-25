/**
 * @input  依赖：当前议题、自动轮次快照与 AgentAvatar
 * @output 导出：活动 Agent 选择器和讨论时间线“正在回复”动态卡
 * @pos    把编排器真实运行状态翻译成讨论区内可感知、可访问的即时反馈
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { AgentId } from "../types/council";
import { useEffect, useRef, useState } from "react";
import type {
  OrchestrationRun,
  OrchestrationSnapshot,
} from "../types/orchestration";
import { BrandGlyph } from "./BrandGlyph";
import { AgentAvatar } from "./presentation";

export interface AgentReplyActivityState {
  runId: string;
  adapterId: string;
  agent: AgentId;
  label: string;
  brand?: {
    glyphId: string;
    colorToken: string;
    displayName: string;
  };
  phase: "preparing" | "replying";
  content: string;
}

const ACTIVE_STATUSES: ReadonlySet<OrchestrationRun["status"]> = new Set([
  "running",
  "waiting_agent",
]);

/**
 * 同议题理论上只允许一个活动 Run；若快照短暂包含多个，取更新时间最新者，
 * 避免旧运行覆盖当前 Agent 的可见状态。
 */
export function selectAgentReplyActivity(
  snapshot: OrchestrationSnapshot | null,
  topicId: string,
): AgentReplyActivityState | null {
  if (!snapshot || snapshot.activeTopicId !== topicId) {
    return null;
  }

  const run = snapshot.runs
    .filter((candidate) => (
      candidate.topicId === topicId && ACTIVE_STATUSES.has(candidate.status)
    ))
    .reduce<OrchestrationRun | null>((latest, candidate) => (
      !latest || candidate.updatedAt > latest.updatedAt ? candidate : latest
    ), null);
  if (!run) {
    return null;
  }

  const round = run.plan[run.nextRoundIndex];
  const adapterId = run.activeAgentId ?? round?.adapterId;
  if (!adapterId) {
    return null;
  }

  const adapter = snapshot.capabilities?.adapters.find(
    (candidate) => candidate.id === adapterId,
  );
  const actorId = adapter?.actorId ?? round?.actorId;
  if (!actorId) {
    return null;
  }
  const output = snapshot.agentOutputs?.find(
    (candidate) => candidate.runId === run.id && candidate.adapterId === adapterId,
  );

  return {
    runId: run.id,
    adapterId,
    agent: actorId,
    label: adapter?.label ?? actorId,
    ...(adapter?.brand ? { brand: adapter.brand } : {}),
    phase: run.status === "waiting_agent" ? "replying" : "preparing",
    content: output?.content ?? "",
  };
}

export interface AgentReplyActivityProps {
  activity: AgentReplyActivityState;
}

export function AgentReplyActivity({ activity }: AgentReplyActivityProps) {
  const title = activity.phase === "replying"
    ? `${activity.label} 正在回复`
    : `${activity.label} 正在准备`;
  const detail = activity.phase === "replying"
    ? "已接收本轮任务，回复完成后会自动加入讨论。"
    : "正在整理公开上下文并准备下一轮调用。";

  return (
    <article
      className={`agent-reply-activity agent-reply-${activity.agent}`}
      role="status"
      aria-label={title}
      aria-live="polite"
      data-run-id={activity.runId}
      data-adapter-id={activity.adapterId}
    >
      <div className="agent-reply-avatar">
        {activity.brand
          ? <span className="agent-avatar agent-avatar-medium"><BrandGlyph brand={activity.brand} size={19} /></span>
          : <AgentAvatar agent={activity.agent} />}
        <span className="agent-reply-presence" aria-hidden="true" />
      </div>
      <div className="agent-reply-surface">
        <div className="agent-reply-copy">
          <strong>{title}</strong>
          <span className="agent-reply-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </div>
        {activity.content ? (
          <>
            <span className="agent-reply-draft-label">实时草稿 · 尚未发布</span>
            <StreamedDraft content={activity.content} />
          </>
        ) : (
          <p>{detail}</p>
        )}
      </div>
    </article>
  );
}

const MAX_REVEAL_FRAMES = 75;
const MIN_REVEAL_CHARS = 4;

function StreamedDraft({ content }: { content: string }) {
  const [visibleContent, setVisibleContent] = useState("");
  const targetRef = useRef(content);

  useEffect(() => {
    targetRef.current = content;
    setVisibleContent((current) => (
      content.startsWith(current) ? current : ""
    ));
  }, [content]);

  useEffect(() => {
    if (visibleContent === targetRef.current) {
      return;
    }
    const animationFrame = requestAnimationFrame(() => {
      setVisibleContent((current) => {
        const target = targetRef.current;
        if (!target.startsWith(current)) {
          return target.slice(0, MIN_REVEAL_CHARS);
        }
        const remaining = target.length - current.length;
        const step = Math.max(
          MIN_REVEAL_CHARS,
          Math.ceil(remaining / MAX_REVEAL_FRAMES),
        );
        return target.slice(0, current.length + step);
      });
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [visibleContent, content]);

  return (
    <pre className="agent-reply-preview">
      {visibleContent}
      <span className="agent-reply-caret" aria-hidden="true" />
    </pre>
  );
}
