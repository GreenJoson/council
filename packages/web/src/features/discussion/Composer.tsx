/**
 * @input  依赖：界面语言上下文、当前项目名、消息类型、议题开放状态、同步/发布状态、提交回调、关联 commit、引用种子与自动轮次快照
 *         （用于 @claude/@codex 召唤自动补全、可用性与"每议题一个活动 run"冲突判断）
 * @output 导出：Composer 公开回复编辑器、结构化关联提交、「引用图片」/粘贴图片（use-composer-images）与已决议题 @Agent 禁用边界
 * @pos    将用户可见结论发布到共享 Council 时间线，并承接消息卡片发起的引用回复；
 *         图片以 `![说明](council-asset:<id>)` 插在光标处，字节只进 Council 资产库；
 *         草稿以 "@claude"/"@codex" 开头时额外把发布翻译成一次自动 run；连写多个召唤（如 "@claude @codex"）
 *         时同一个问题交给每位 Agent 各答一轮、答题时互相看不到（同题盲答）
 *         （召唤解析见 data/mention-parser.ts，冲突判断复用 AutoRoundsPanel 的
 *         getCreateRunBlockedReason，保持与自动轮次面板同一套互斥规则）；
 *         召唤成功时讨论消息的 kind 固定改写为 note，kind 选择器转而描述 Agent
 *         回应应呈现的类型（通过 MentionPublishRequest.responseKind 传给 App）
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { Bot, FolderGit2, GitCommitHorizontal, ImagePlus, Link2, ListTodo, MessagesSquare, Plus, Send, TriangleAlert, Workflow, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import {
  buildCommitAssociationContent,
  expandCommitAssociationDrafts,
  MAX_COMMIT_ASSOCIATIONS,
  type CommitAssociationDraft,
  validateCommitAssociationDrafts,
} from "../../data/commit-association";
import {
  findActiveMentionQuery,
  getMentionToken,
  hasMentionAttempt,
  parseMentions,
} from "../../data/mention-parser";
import type { MessageKind, SyncState } from "../../types/council";
import type { OrchestrationAdapter, OrchestrationSnapshot } from "../../types/orchestration";
import {
  getCreateRunBlockedReason,
  getTopicAgentCallBlockedReason,
} from "./AutoRoundsPanel";
import { messageKindLabels } from "../../components/presentation";
import { COMPOSER_IMAGE_ACCEPT, useComposerImages } from "./use-composer-images";

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
 * adapterIds 有两个及以上时是同题盲答：每位 Agent 各答一轮，答题时看不到彼此这次的回答。
 */
export interface MentionPublishRequest {
  adapterIds: string[];
  instruction: string;
  responseKind: MessageKind;
  /** 按 adapterId 覆盖各自的指令（一键互评要告诉每位 Agent 去评谁）；缺省用 instruction */
  instructions?: Readonly<Record<string, string>>;
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
  /**
   * 模式切换「派任务 / 起流水线」：不在编辑器内建表单，只把当前草稿交给壳层打开对话框；
   * 两个都缺省时不渲染切换条（测试与独立使用场景）。
   */
  onOpenTaskCreate?: (draft: string) => void;
  onOpenPipelineCreate?: (draft: string) => void;
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
  onOpenTaskCreate,
  onOpenPipelineCreate,
}: ComposerProps) {
  const { t } = useI18n();
  const [kind, setKind] = useState<MessageKind>("rebuttal");
  const [content, setContent] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const appliedQuoteNonceRef = useRef<number | null>(null);
  const [isMentionMenuOpen, setIsMentionMenuOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionStart, setMentionStart] = useState<number | null>(null);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [isCommitEditorOpen, setIsCommitEditorOpen] = useState(false);
  const [commitDrafts, setCommitDrafts] = useState<CommitAssociationDraft[]>([]);

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

  const mention = useMemo(() => parseMentions(content, mentionAdapters), [content, mentionAdapters]);
  const mentionTargets = mention
    ? mention.adapterIds.flatMap((id) => mentionAdapters.filter((adapter) => adapter.id === id))
    : [];
  const unavailableTarget = mentionTargets.find((adapter) => !adapter.available);

  type MentionStatus =
    | { kind: "none" }
    | { kind: "ready"; adapters: OrchestrationAdapter[]; agents: string }
    | { kind: "blocked"; reason: string };

  let mentionStatus: MentionStatus = { kind: "none" };
  if (mention && mentionTargets.length > 0) {
    if (!allowAgentCalls) {
      mentionStatus = {
        kind: "blocked",
        reason: t(
          getTopicAgentCallBlockedReason(false)
            ?? "议题已经决策，不能再通过 @ 召唤 Agent。",
        ),
      };
    } else if (unavailableTarget) {
      mentionStatus = {
        kind: "blocked",
        reason: unavailableTarget.limitation ?? t("{agent} 当前不能被 Web 主动调用。", {
          agent: unavailableTarget.label,
        }),
      };
    } else if (mentionRunBlockedReason) {
      mentionStatus = { kind: "blocked", reason: t(mentionRunBlockedReason) };
    } else {
      mentionStatus = {
        kind: "ready",
        adapters: mentionTargets,
        agents: mentionTargets.map((adapter) => adapter.label).join(t("、")),
      };
    }
  } else if (isOrchestrationOffline && hasMentionAttempt(content)) {
    mentionStatus = { kind: "blocked", reason: t("自动编排当前离线，暂时无法通过 @ 召唤 Agent。") };
  }

  const commitTargets = useMemo(
    () => expandCommitAssociationDrafts(commitDrafts),
    [commitDrafts],
  );
  const commitAssociationError = validateCommitAssociationDrafts(commitDrafts);
  const hasCommitAssociations = commitTargets.length > 0 && !commitAssociationError;
  const hasCurrentProjectDraft = commitDrafts.some((draft) => draft.repository.trim() === ".");
  const canPublish = (content.trim().length > 0 || hasCommitAssociations)
    && !isPublishing
    && mentionStatus.kind !== "blocked"
    && !commitAssociationError;

  function toggleCommitEditor(): void {
    if (isCommitEditorOpen) {
      if (validateCommitAssociationDrafts(commitDrafts)) {
        setCommitDrafts([]);
      }
      setIsCommitEditorOpen(false);
      return;
    }
    if (commitDrafts.length === 0) {
      setCommitDrafts([{ repository: ".", commits: "" }]);
    }
    setIsCommitEditorOpen(true);
  }

  function updateCommitDraft(
    index: number,
    field: keyof CommitAssociationDraft,
    value: string,
  ): void {
    setCommitDrafts((current) => current.map((target, targetIndex) =>
      targetIndex === index ? { ...target, [field]: value } : target));
  }

  function removeCommitDraft(index: number): void {
    setCommitDrafts((current) => current.filter((_target, targetIndex) => targetIndex !== index));
  }

  /** 在光标处插入独立一行的片段（图片引用）；用函数式更新，上传期间用户继续输入也不会被覆盖。 */
  function insertAtCursor(snippet: string): void {
    const textarea = textareaRef.current;
    let nextCursor = 0;
    setContent((current) => {
      const start = Math.min(textarea?.selectionStart ?? current.length, current.length);
      const end = Math.min(Math.max(textarea?.selectionEnd ?? start, start), current.length);
      const before = current.slice(0, start);
      const after = current.slice(end);
      const prefix = before && !before.endsWith("\n") ? "\n" : "";
      const suffix = after && !after.startsWith("\n") ? "\n" : "";
      const inserted = `${prefix}${snippet}${suffix}`;
      nextCursor = before.length + inserted.length;
      return `${before}${inserted}${after}`;
    });
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(nextCursor, nextCursor);
    });
  }

  const images = useComposerImages({ onInsert: insertAtCursor });

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
        ? { adapterIds: mention.adapterIds, instruction: mention.instruction, responseKind: kind }
        : undefined;
    // 召唤成功时，这条讨论消息本身固定记录为 note——它是"指令性发言"，
    // 不是用户在 kind 选择器里点的那个提案类型；kind 选择器此时改为描述 Agent 回应的类型。
    const publishedContent = hasCommitAssociations
      ? buildCommitAssociationContent(trimmed, commitTargets, t("补充本次修复对应的提交记录。"))
      : trimmed;
    const published = await onPublish(
      mentionPayload || hasCommitAssociations ? "note" : kind,
      publishedContent,
      mentionPayload,
    );
    if (published) {
      setContent("");
      setIsMentionMenuOpen(false);
      setCommitDrafts([]);
      setIsCommitEditorOpen(false);
    }
  }

  return (
    <form className="composer" onSubmit={(event) => void handleSubmit(event)}>
      <div className="composer-meta">
        {onOpenTaskCreate || onOpenPipelineCreate ? (
          <div className="segment-control composer-mode-switch" role="group" aria-label={t("编辑器模式")}>
            <button className="segment-option active" type="button" aria-pressed="true">
              <MessagesSquare size={13} aria-hidden="true" />
              {t("讨论")}
            </button>
            {onOpenTaskCreate ? (
              <button className="segment-option" type="button" aria-pressed="false"
                onClick={() => onOpenTaskCreate(content)}>
                <ListTodo size={13} aria-hidden="true" />
                {t("派任务")}
              </button>
            ) : null}
            {onOpenPipelineCreate ? (
              <button className="segment-option" type="button" aria-pressed="false"
                onClick={() => onOpenPipelineCreate(content)}>
                <Workflow size={13} aria-hidden="true" />
                {t("起流水线")}
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="kind-selector" aria-label={t("选择消息类型")}>
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
          {t(sync.label)}
        </span>
      </div>

      <label>
        <span className="sr-only">{t("公开回复内容")}</span>
        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleContentChange}
          onKeyDown={handleTextareaKeyDown}
          onPaste={images.handlePaste}
          placeholder={t("写下公开结论、证据或回应…输入 @ 可召唤 Agent 直接回应")}
          rows={2}
        />
        {isMentionMenuOpen ? (
          <div className="mention-menu" role="listbox" aria-label={t("召唤 Agent")}>
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
                    <small>{candidate.available
                      ? t("可主动调用")
                      : candidate.limitation ?? t("当前不可主动调用")}</small>
                  </span>
                </button>
              ))
            ) : (
              <p className="mention-menu-empty">{t("没有匹配的 Agent")}</p>
            )}
          </div>
        ) : null}
      </label>

      {isCommitEditorOpen ? (
        <section className="commit-association-editor" aria-label={t("关联提交")}>
          <div className="commit-association-heading">
            <div>
              <strong>{t("关联修复提交")}</strong>
              <small>{t("一个仓库可粘贴多个 SHA；逗号、空格或换行均可分隔")}</small>
            </div>
            <span>{t("{count}/{max} 个提交", {
              count: commitTargets.length,
              max: MAX_COMMIT_ASSOCIATIONS,
            })}</span>
          </div>
          <div className="commit-association-rows">
            {commitDrafts.map((target, index) => (
              <div className="commit-association-row" key={index}>
                {target.repository === "." ? (
                  <div className="commit-repository-context">
                    <span>{t("项目")}</span>
                    <strong title={currentProjectName}>{currentProjectName}</strong>
                  </div>
                ) : (
                  <label>
                    <span>{t("其他仓库")}</span>
                    <input
                      type="text"
                      value={target.repository}
                      disabled={isPublishing}
                      placeholder="../another-repository"
                      aria-label={t("第 {index} 个仓库路径", { index: index + 1 })}
                      onChange={(event) => updateCommitDraft(index, "repository", event.target.value)}
                    />
                  </label>
                )}
                <label className="commit-sha-field">
                  <span>{t("Commit SHA（可多个）")}</span>
                  <textarea
                    rows={1}
                    value={target.commits}
                    disabled={isPublishing}
                    placeholder={t("如 abc1234, def5678 或用空格分隔")}
                    spellCheck={false}
                    aria-label={t("第 {index} 个仓库的 commit SHA 列表", { index: index + 1 })}
                    onChange={(event) => updateCommitDraft(index, "commits", event.target.value)}
                  />
                </label>
                <button
                  className="icon-button compact commit-remove-button"
                  type="button"
                  disabled={isPublishing}
                  aria-label={t("移除第 {index} 个仓库的关联提交", { index: index + 1 })}
                  onClick={() => removeCommitDraft(index)}
                >
                  <X size={15} />
                </button>
              </div>
            ))}
          </div>
          <div className="commit-association-footer">
            <div className="commit-add-actions">
              {!hasCurrentProjectDraft ? (
                <button
                  className="commit-add-button"
                  type="button"
                  disabled={isPublishing || commitDrafts.length >= MAX_COMMIT_ASSOCIATIONS}
                  onClick={() => setCommitDrafts((current) => [
                    { repository: ".", commits: "" },
                    ...current,
                  ])}
                >
                  <Plus size={14} />
                  {t("关联当前项目")}
                </button>
              ) : null}
              <button
                className="commit-add-button"
                type="button"
                disabled={isPublishing
                  || commitDrafts.length >= MAX_COMMIT_ASSOCIATIONS
                  || commitTargets.length >= MAX_COMMIT_ASSOCIATIONS}
                onClick={() => setCommitDrafts((current) => [
                  ...current,
                  { repository: "", commits: "" },
                ])}
              >
                <FolderGit2 size={14} />
                {t("关联其他仓库")}
              </button>
            </div>
            {commitAssociationError ? (
              <span className="commit-association-error" role="alert">
                <TriangleAlert size={13} />
                {t(commitAssociationError)}
              </span>
            ) : commitDrafts.length > 0 ? (
              <span className="commit-association-ready">
                {t("修复互审将直接读取这些不可变提交")}
              </span>
            ) : null}
          </div>
        </section>
      ) : null}

      {mentionStatus.kind === "ready" ? (
        <p className="composer-mention-hint">
          <Bot size={13} />
          {mentionStatus.adapters.length > 1
            ? t("{agents} 将各自独立回答（答题时看不到彼此），以 {kind} 呈现；这条召唤消息本身记录为 Note", {
                agents: mentionStatus.agents,
                kind: messageKindLabels[kind],
              })
            : t("{agent} 将以 {kind} 回应；这条召唤消息本身记录为 Note", {
                agent: mentionStatus.agents,
                kind: messageKindLabels[kind],
              })}
        </p>
      ) : null}
      {mentionStatus.kind === "blocked" ? (
        <p className="composer-mention-blocked" role="alert">
          <TriangleAlert size={13} />
          {mentionStatus.reason}
        </p>
      ) : null}
      {images.error ? (
        <p className="composer-mention-blocked composer-image-error" role="alert">
          <TriangleAlert size={13} />
          {images.error}
        </p>
      ) : null}

      <div className="composer-toolbar">
        <div className="composer-tools">
          <button
            className="composer-tool-button"
            type="button"
            onClick={images.pick}
            disabled={images.isBusy}
            aria-busy={images.isBusy}
          >
            <ImagePlus size={15} />
            {images.isBusy ? t("正在加入图片…") : t("引用图片")}
          </button>
          {images.isDesktop ? null : (
            <input
              ref={images.fileInputRef}
              type="file"
              accept={COMPOSER_IMAGE_ACCEPT}
              hidden
              aria-label={t("选择要引用的图片")}
              onChange={images.handleFileInput}
            />
          )}
          <button
            className={`commit-association-toggle ${isCommitEditorOpen ? "is-active" : ""}`}
            type="button"
            aria-expanded={isCommitEditorOpen}
            onClick={toggleCommitEditor}
          >
            <GitCommitHorizontal size={15} />
            {hasCommitAssociations
              ? t("已关联 {count} 个提交", { count: commitTargets.length })
              : t("关联提交")}
          </button>
          <span className="composer-hint">{t("⌘ Enter 快速发布")}</span>
        </div>
        <button className="publish-button" type="submit" disabled={!canPublish}>
          <span>
            {isPublishing
              ? t("发布中…")
              : mentionStatus.kind === "ready"
                ? t("发布并召唤 {agent}", { agent: mentionStatus.agents })
                : hasCommitAssociations
                  ? t("发布提交记录")
                  : t("发布 {kind}", { kind: messageKindLabels[kind] })}
          </span>
          <Send size={16} />
        </button>
      </div>
    </form>
  );
}
