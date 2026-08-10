/**
 * @input  依赖：当前项目名、消息类型、议题开放状态、同步/发布状态、提交回调、关联 commit、引用种子与自动轮次快照
 *         （用于 @claude/@codex 召唤自动补全、可用性与"每议题一个活动 run"冲突判断）
 * @output 导出：Composer 公开回复编辑器、结构化关联提交与已决议题 @Agent 禁用边界
 * @pos    将用户可见结论发布到共享 Council 时间线，并承接消息卡片发起的引用回复；
 *         草稿以 "@claude"/"@codex" 开头时额外把发布翻译成一次单轮自动 run
 *         （召唤解析见 data/mention-parser.ts，冲突判断复用 AutoRoundsPanel 的
 *         getCreateRunBlockedReason，保持与自动轮次面板同一套互斥规则）；
 *         召唤成功时讨论消息的 kind 固定改写为 note，kind 选择器转而描述 Agent
 *         回应应呈现的类型（通过 MentionPublishRequest.responseKind 传给 App）
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { Bot, FolderGit2, GitCommitHorizontal, Link2, Plus, Send, TriangleAlert, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  buildCommitAssociationContent,
  MAX_COMMIT_ASSOCIATIONS,
  type CommitAssociationTarget,
  validateCommitAssociationTargets,
} from "../data/commit-association";
import {
  findActiveMentionQuery,
  getMentionToken,
  hasMentionAttempt,
  parseMention,
} from "../data/mention-parser";
import type { MessageKind, SyncState } from "../types/council";
import type { OrchestrationAdapter, OrchestrationSnapshot } from "../types/orchestration";
import {
  getCreateRunBlockedReason,
  getTopicAgentCallBlockedReason,
} from "./AutoRoundsPanel";
import { messageKindLabels } from "./presentation";

const composerKinds: MessageKind[] = ["proposal", "critique", "rebuttal", "synthesis"];

/** 引用回复种子：text 是待插入的引用文本，nonce 保证连续引用同一条消息也能重新触发插入 */
export interface QuoteSeed {
  text: string;
  nonce: number;
}

/**
 * @claude/@codex 召唤成功时随 onPublish 一起交给调用方的补充信息。
 * responseKind 是 Composer 当前选中的 kind——它此时描述的是"Agent 回应应呈现的类型"，
 * 不是这条用户消息自身的 kind（那个已经被固定为 note，随 onPublish 的第一个参数传出）。
 */
export interface MentionPublishRequest {
  adapterId: string;
  instruction: string;
  responseKind: MessageKind;
}

export interface ComposerProps {
  /** 当前议题所属项目；当前项目提交在协议中固定保存为相对路径 . */
  currentProjectName: string;
  isPublishing: boolean;
  allowAgentCalls: boolean;
  sync: SyncState;
  /**
   * mention 非空时：kind 固定传入 "note"（这条消息是指令性发言，不是提案本身）；
   * 调用方（App）应在公开发帖成功后额外发起一次 createRun + startRun，
   * plan.messageKind 取 mention.responseKind，instruction 取 mention.instruction。
   */
  onPublish: (kind: MessageKind, content: string, mention?: MentionPublishRequest) => Promise<boolean>;
  quoteSeed?: QuoteSeed | null;
  /** 当前议题 id，用于从 orchestration 快照里筛出"属于本议题"的 Run 判断活动冲突 */
  topicId: string;
  orchestration: OrchestrationSnapshot | null;
  orchestrationBusyAction: string | null;
}

export function Composer({
  currentProjectName,
  isPublishing,
  allowAgentCalls,
  sync,
  onPublish,
  quoteSeed,
  topicId,
  orchestration,
  orchestrationBusyAction,
}: ComposerProps) {
  const [kind, setKind] = useState<MessageKind>("rebuttal");
  const [content, setContent] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const appliedQuoteNonceRef = useRef<number | null>(null);
  const [isMentionMenuOpen, setIsMentionMenuOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionStart, setMentionStart] = useState<number | null>(null);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [isCommitEditorOpen, setIsCommitEditorOpen] = useState(false);
  const [commitTargets, setCommitTargets] = useState<CommitAssociationTarget[]>([]);

  const mentionAdapters: OrchestrationAdapter[] = orchestration?.capabilities?.adapters ?? [];
  const isOrchestrationOffline = orchestration?.sync.status === "offline";
  const runsForTopic = orchestration?.activeTopicId === topicId ? orchestration.runs : [];
  const mentionRunBlockedReason = getCreateRunBlockedReason(runsForTopic, orchestrationBusyAction);

  /*
   * 输入框高度跟着草稿走：两行起，到 CSS 里的上限封顶后自己滚。
   * 挂在 content 上而不是 onChange 里，是因为引用回复、发布后清空这两条路
   * 都是直接改 state 的——只认按键就会漏掉它们，把高度留在上一稿的尺寸上。
   */
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = "auto";
    textarea.style.height = `${String(textarea.scrollHeight)}px`;
  }, [content]);

  // 引用回复：把消息卡片发起的引用文本追加到草稿开头，再聚焦并把光标移到末尾方便续写
  useEffect(() => {
    if (!quoteSeed || appliedQuoteNonceRef.current === quoteSeed.nonce) {
      return;
    }
    appliedQuoteNonceRef.current = quoteSeed.nonce;
    setIsMentionMenuOpen(false);
    setContent((current) => `${quoteSeed.text}${current}`);
    const frameId = requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    });
    return () => cancelAnimationFrame(frameId);
  }, [quoteSeed]);

  const mentionCandidates = useMemo(() => {
    if (!isMentionMenuOpen) {
      return [];
    }
    const query = mentionQuery.toLocaleLowerCase();
    if (!query) {
      return mentionAdapters;
    }
    return mentionAdapters.filter(
      (adapter) =>
        getMentionToken(adapter).toLocaleLowerCase().includes(query)
        || adapter.label.toLocaleLowerCase().includes(query),
    );
  }, [isMentionMenuOpen, mentionQuery, mentionAdapters]);

  const mention = useMemo(() => parseMention(content, mentionAdapters), [content, mentionAdapters]);
  const mentionAdapter = mention
    ? mentionAdapters.find((adapter) => adapter.id === mention.adapterId)
    : undefined;

  type MentionStatus =
    | { kind: "none" }
    | { kind: "ready"; adapter: OrchestrationAdapter }
    | { kind: "blocked"; reason: string };

  let mentionStatus: MentionStatus = { kind: "none" };
  if (mention && mentionAdapter) {
    if (!allowAgentCalls) {
      mentionStatus = {
        kind: "blocked",
        reason: getTopicAgentCallBlockedReason(false)
          ?? "议题已经决策，不能再通过 @ 召唤 Agent。",
      };
    } else if (!mentionAdapter.available) {
      mentionStatus = {
        kind: "blocked",
        reason: mentionAdapter.limitation ?? `${mentionAdapter.label} 当前不能被 Web 主动调用。`,
      };
    } else if (mentionRunBlockedReason) {
      mentionStatus = { kind: "blocked", reason: mentionRunBlockedReason };
    } else {
      mentionStatus = { kind: "ready", adapter: mentionAdapter };
    }
  } else if (isOrchestrationOffline && hasMentionAttempt(content)) {
    mentionStatus = { kind: "blocked", reason: "自动编排当前离线，暂时无法通过 @ 召唤 Agent。" };
  }

  const commitAssociationError = validateCommitAssociationTargets(commitTargets);
  const hasCommitAssociations = commitTargets.length > 0 && !commitAssociationError;
  const canPublish = (content.trim().length > 0 || hasCommitAssociations)
    && !isPublishing
    && mentionStatus.kind !== "blocked"
    && !commitAssociationError;

  function toggleCommitEditor(): void {
    if (isCommitEditorOpen) {
      if (validateCommitAssociationTargets(commitTargets)) {
        setCommitTargets([]);
      }
      setIsCommitEditorOpen(false);
      return;
    }
    if (commitTargets.length === 0) {
      setCommitTargets([{ repository: ".", commit: "" }]);
    }
    setIsCommitEditorOpen(true);
  }

  function updateCommitTarget(
    index: number,
    field: keyof CommitAssociationTarget,
    value: string,
  ): void {
    setCommitTargets((current) => current.map((target, targetIndex) =>
      targetIndex === index ? { ...target, [field]: value } : target));
  }

  function removeCommitTarget(index: number): void {
    setCommitTargets((current) => current.filter((_target, targetIndex) => targetIndex !== index));
  }

  function applyMentionCandidate(candidate: OrchestrationAdapter): void {
    if (mentionStart === null || !candidate.available) {
      return;
    }
    const textarea = textareaRef.current;
    const cursor = textarea?.selectionStart ?? content.length;
    const before = content.slice(0, mentionStart);
    const after = content.slice(cursor);
    const inserted = `@${getMentionToken(candidate)} `;
    const nextContent = `${before}${inserted}${after}`;
    setContent(nextContent);
    setIsMentionMenuOpen(false);
    const nextCursor = before.length + inserted.length;
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(nextCursor, nextCursor);
    });
  }

  function handleContentChange(event: React.ChangeEvent<HTMLTextAreaElement>): void {
    const value = event.target.value;
    setContent(value);
    const cursor = event.target.selectionStart ?? value.length;
    const active = findActiveMentionQuery(value, cursor);
    if (active) {
      setIsMentionMenuOpen(true);
      setMentionQuery(active.query);
      setMentionStart(active.start);
      setActiveMentionIndex(0);
    } else {
      setIsMentionMenuOpen(false);
    }
  }

  function handleTextareaKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (isMentionMenuOpen && mentionCandidates.length > 0 && !event.metaKey && !event.ctrlKey) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveMentionIndex((current) => (current + 1) % mentionCandidates.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveMentionIndex(
          (current) => (current - 1 + mentionCandidates.length) % mentionCandidates.length,
        );
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const candidate = mentionCandidates[activeMentionIndex];
        if (candidate?.available) {
          event.preventDefault();
          applyMentionCandidate(candidate);
        } else if (event.key === "Enter") {
          // 高亮的候选当前不可用：吞掉换行，但不插入，等用户切到可用候选或自行取消
          event.preventDefault();
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setIsMentionMenuOpen(false);
        return;
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canPublish) {
      return;
    }
    const trimmed = content.trim();
    const mentionPayload: MentionPublishRequest | undefined =
      mentionStatus.kind === "ready" && mention
        ? { adapterId: mention.adapterId, instruction: mention.instruction, responseKind: kind }
        : undefined;
    // 召唤成功时，这条讨论消息本身固定记录为 note——它是"指令性发言"，
    // 不是用户在 kind 选择器里点的那个提案类型；kind 选择器此时改为描述 Agent 回应的类型。
    const publishedContent = hasCommitAssociations
      ? buildCommitAssociationContent(trimmed, commitTargets)
      : trimmed;
    const published = await onPublish(
      mentionPayload || hasCommitAssociations ? "note" : kind,
      publishedContent,
      mentionPayload,
    );
    if (published) {
      setContent("");
      setIsMentionMenuOpen(false);
      setCommitTargets([]);
      setIsCommitEditorOpen(false);
    }
  }

  return (
    <form className="composer" onSubmit={(event) => void handleSubmit(event)}>
      <div className="composer-meta">
        <div className="kind-selector" aria-label="选择消息类型">
          {composerKinds.map((candidate) => (
            <button
              className={`kind-option kind-${candidate} ${kind === candidate ? "active" : ""}`}
              type="button"
              key={candidate}
              aria-pressed={kind === candidate}
              onClick={() => setKind(candidate)}
            >
              {messageKindLabels[candidate]}
            </button>
          ))}
        </div>
        <span className="shared-notice">
          <Link2 size={13} />
          {sync.label}
        </span>
      </div>

      <label>
        <span className="sr-only">公开回复内容</span>
        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleContentChange}
          onKeyDown={handleTextareaKeyDown}
          placeholder="写下公开结论、证据或回应…输入 @ 可召唤 Agent 直接回应"
          rows={2}
        />
        {isMentionMenuOpen ? (
          <div className="mention-menu" role="listbox" aria-label="召唤 Agent">
            {mentionCandidates.length > 0 ? (
              mentionCandidates.map((candidate, index) => (
                <button
                  className={`mention-option ${index === activeMentionIndex ? "active" : ""} ${
                    candidate.available ? "" : "is-disabled"
                  }`}
                  type="button"
                  key={candidate.id}
                  role="option"
                  aria-selected={index === activeMentionIndex}
                  aria-disabled={!candidate.available}
                  disabled={!candidate.available}
                  onMouseEnter={() => setActiveMentionIndex(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    applyMentionCandidate(candidate);
                  }}
                >
                  <span className={`agent-avatar agent-${candidate.actorId} agent-avatar-small`}>
                    {candidate.label.slice(0, 2).toUpperCase()}
                  </span>
                  <span className="mention-option-body">
                    <strong>{candidate.label}</strong>
                    <small>{candidate.available ? "可主动调用" : candidate.limitation ?? "当前不可主动调用"}</small>
                  </span>
                </button>
              ))
            ) : (
              <p className="mention-menu-empty">没有匹配的 Agent</p>
            )}
          </div>
        ) : null}
      </label>

      {isCommitEditorOpen ? (
        <section className="commit-association-editor" aria-label="关联提交">
          <div className="commit-association-heading">
            <div>
              <strong>关联修复提交</strong>
              <small>当前项目已自动绑定；仅跨仓库时填写相对路径</small>
            </div>
            <span>{commitTargets.length}/{MAX_COMMIT_ASSOCIATIONS}</span>
          </div>
          <div className="commit-association-rows">
            {commitTargets.map((target, index) => (
              <div className="commit-association-row" key={index}>
                {target.repository === "." ? (
                  <div className="commit-repository-context">
                    <span>项目</span>
                    <strong title={currentProjectName}>{currentProjectName}</strong>
                  </div>
                ) : (
                  <label>
                    <span>其他仓库</span>
                    <input
                      type="text"
                      value={target.repository}
                      disabled={isPublishing}
                      placeholder="../another-repository"
                      aria-label={`第 ${String(index + 1)} 个仓库路径`}
                      onChange={(event) => updateCommitTarget(index, "repository", event.target.value)}
                    />
                  </label>
                )}
                <label className="commit-sha-field">
                  <span>Commit SHA</span>
                  <input
                    type="text"
                    value={target.commit}
                    disabled={isPublishing}
                    placeholder="7–40 位 commit SHA"
                    spellCheck={false}
                    aria-label={`第 ${String(index + 1)} 个 commit SHA`}
                    onChange={(event) => updateCommitTarget(index, "commit", event.target.value)}
                  />
                </label>
                <button
                  className="icon-button compact commit-remove-button"
                  type="button"
                  disabled={isPublishing}
                  aria-label={`移除第 ${String(index + 1)} 个关联提交`}
                  onClick={() => removeCommitTarget(index)}
                >
                  <X size={15} />
                </button>
              </div>
            ))}
          </div>
          <div className="commit-association-footer">
            <div className="commit-add-actions">
              <button
                className="commit-add-button"
                type="button"
                disabled={isPublishing || commitTargets.length >= MAX_COMMIT_ASSOCIATIONS}
                onClick={() => setCommitTargets((current) => [
                  ...current,
                  { repository: ".", commit: "" },
                ])}
              >
                <Plus size={14} />
                添加当前项目提交
              </button>
              <button
                className="commit-add-button"
                type="button"
                disabled={isPublishing || commitTargets.length >= MAX_COMMIT_ASSOCIATIONS}
                onClick={() => setCommitTargets((current) => [
                  ...current,
                  { repository: "", commit: "" },
                ])}
              >
                <FolderGit2 size={14} />
                关联其他仓库
              </button>
            </div>
            {commitAssociationError ? (
              <span className="commit-association-error" role="alert">
                <TriangleAlert size={13} />
                {commitAssociationError}
              </span>
            ) : commitTargets.length > 0 ? (
              <span className="commit-association-ready">
                修复互审将直接读取这些不可变提交
              </span>
            ) : null}
          </div>
        </section>
      ) : null}

      {mentionStatus.kind === "ready" ? (
        <p className="composer-mention-hint">
          <Bot size={13} />
          {mentionStatus.adapter.label} 将以 {messageKindLabels[kind]} 回应；这条召唤消息本身记录为 Note
        </p>
      ) : null}
      {mentionStatus.kind === "blocked" ? (
        <p className="composer-mention-blocked" role="alert">
          <TriangleAlert size={13} />
          {mentionStatus.reason}
        </p>
      ) : null}

      <div className="composer-toolbar">
        <div className="composer-tools">
          <button
            className={`commit-association-toggle ${isCommitEditorOpen ? "is-active" : ""}`}
            type="button"
            aria-expanded={isCommitEditorOpen}
            onClick={toggleCommitEditor}
          >
            <GitCommitHorizontal size={15} />
            {hasCommitAssociations
              ? `已关联 ${String(commitTargets.length)} 个提交`
              : "关联提交"}
          </button>
          <span className="composer-hint">⌘ Enter 快速发布</span>
        </div>
        <button className="publish-button" type="submit" disabled={!canPublish}>
          <span>
            {isPublishing
              ? "发布中…"
              : mentionStatus.kind === "ready"
                ? `发布并召唤 ${mentionStatus.adapter.label}`
                : hasCommitAssociations
                  ? "发布提交记录"
                  : `发布 ${messageKindLabels[kind]}`}
          </span>
          <Send size={16} />
        </button>
      </div>
    </form>
  );
}
