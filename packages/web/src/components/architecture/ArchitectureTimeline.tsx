/**
 * @input  依赖：界面语言上下文、selectors.ts 的 ArchitectureTimelineEntry 列表、议题/决策记录跳转回调与折叠开关
 * @output 导出：ArchitectureTimeline 架构档案第二区块——按时间排列的决策演进时间线
 * @pos    ArchitectureView 的第二区块；已接受/被取代条目带稳定 ADR 编号并可跳转决策记录，
 *         仍在提案中的条目跳转回讨论视图；不发起请求，纯展示 + 回调
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { CheckCircle2, GitCommitHorizontal, History, ShieldCheck } from "lucide-react";
import type { ArchitectureTimelineEntry } from "../../data/selectors";
import type { SectionId } from "../../data/section-collapse";
import { useI18n } from "../../i18n/I18nProvider";
import { ArchitectureSection } from "./ArchitectureSection";

export interface ArchitectureTimelineProps {
  entries: ArchitectureTimelineEntry[];
  /** 仍在提案中的条目：跳回讨论视图查看实时进展 */
  onOpenTopic: (topicId: string) => void;
  /** 已接受/被取代的条目：跳到决策记录视图对应的 ADR 条目 */
  onOpenDecisionRecord: (topicId: string) => void;
  isCollapsed: boolean;
  onToggleCollapse: (id: SectionId) => void;
}

export function ArchitectureTimeline({
  entries,
  onOpenTopic,
  onOpenDecisionRecord,
  isCollapsed,
  onToggleCollapse,
}: ArchitectureTimelineProps) {
  const { t } = useI18n();
  return (
    <ArchitectureSection
      id="timeline"
      className="architecture-timeline"
      icon={<GitCommitHorizontal size={17} aria-hidden="true" />}
      title="架构演进时间线"
      count={entries.length}
      isCollapsed={isCollapsed}
      onToggle={onToggleCollapse}
    >
      {entries.length === 0 ? (
        <p className="architecture-section-empty">
          {t("还没有决策记录。在决策里写下 summary/rationale 并接受后，会按时间出现在这里。")}
        </p>
      ) : (
        <ol className="architecture-timeline-list">
          {entries.map((entry) => {
            const isPending = entry.status === "proposed";
            const openEntry = () => (isPending ? onOpenTopic(entry.topicId) : onOpenDecisionRecord(entry.topicId));
            return (
              <li key={entry.topicId} className={`architecture-timeline-item status-${entry.status}`}>
                {/* 整行可点击跳转；取代徽章是行内嵌套的独立按钮，用 div+role=button 而非
                    <button> 承载整行，避免把一个真正的 <button> 塞进另一个 <button> 里 */}
                <div
                  className="architecture-timeline-entry"
                  role="button"
                  tabIndex={0}
                  onClick={openEntry}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      openEntry();
                    }
                  }}
                >
                  <span className="architecture-timeline-marker" aria-hidden="true">
                    {entry.status === "accepted" ? (
                      <CheckCircle2 size={15} />
                    ) : entry.status === "superseded" ? (
                      <History size={15} />
                    ) : (
                      <ShieldCheck size={15} />
                    )}
                  </span>
                  <span className="architecture-timeline-body">
                    <span className="architecture-timeline-heading">
                      <span className="architecture-timeline-adr">{entry.adrNumber ?? t("提案中")}</span>
                      <span className="architecture-timeline-title">{entry.decisionTitle}</span>
                    </span>
                    <span className="architecture-timeline-meta">
                      <span>{entry.topicTitle}</span>
                      <span aria-hidden="true"> · </span>
                      <span>{entry.timeLabel}</span>
                    </span>
                  </span>
                  {entry.supersededByAdrNumber ? (
                    <button
                      type="button"
                      className="architecture-superseded-badge"
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpenDecisionRecord(entry.supersededByTopicId ?? entry.topicId);
                      }}
                    >
                      {t("已被 {adr} 取代", { adr: entry.supersededByAdrNumber })}
                    </button>
                  ) : entry.status === "superseded" ? (
                    <span className="architecture-superseded-badge">{t("已被取代")}</span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </ArchitectureSection>
  );
}
