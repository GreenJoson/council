/**
 * @input  依赖：界面语言上下文、议题列表、选中状态、状态筛选、工作区视图路由与关闭回调
 * @output 导出：WorkspaceView 视图路由类型与 TopicSidebar 项目和议题导航
 * @pos    Operator Console 左侧高密度导航区域，三个工作区视图共用
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  Boxes,
  FileCheck2,
  GitBranch,
  SearchX,
  X,
} from "lucide-react";
import type { ComponentType } from "react";
import type { TopicStatusFilter } from "../data/selectors";
import type { TopicSummary } from "../types/council";
import { useI18n } from "../i18n/I18nProvider";
import { StatusBadge } from "./presentation";

/** Operator Console 三个工作区视图：议题讨论、架构总览看板、决策归档 */
export type WorkspaceView = "topics" | "architecture" | "decisions";

const statusFilterOptions: { id: TopicStatusFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "active", label: "进行中" },
  { id: "decided", label: "已决策" },
];

const workspaceViewOptions: { id: WorkspaceView; label: string; Icon: ComponentType<{ size?: number }> }[] = [
  { id: "topics", label: "议题", Icon: Boxes },
  { id: "architecture", label: "架构档案", Icon: GitBranch },
  { id: "decisions", label: "决策记录", Icon: FileCheck2 },
];

export interface TopicSidebarProps {
  topics: TopicSummary[];
  selectedTopicId: string;
  isOpen: boolean;
  statusFilter: TopicStatusFilter;
  activeView: WorkspaceView;
  onSelectView: (view: WorkspaceView) => void;
  onStatusFilterChange: (filter: TopicStatusFilter) => void;
  onSelectTopic: (topicId: string) => void;
  onClose: () => void;
}

export function TopicSidebar({
  topics,
  selectedTopicId,
  isOpen,
  statusFilter,
  activeView,
  onSelectView,
  onStatusFilterChange,
  onSelectTopic,
  onClose,
}: TopicSidebarProps) {
  const { t } = useI18n();
  return (
    <aside className={`topic-sidebar ${isOpen ? "panel-open" : ""}`} aria-label={t("议题导航")}>
      <div className="sidebar-mobile-heading">
        <span>{t("议题导航")}</span>
        <button className="icon-button" type="button" aria-label={t("关闭议题导航")} onClick={onClose}>
          <X size={18} />
        </button>
      </div>

      <nav className="project-navigation" aria-label={t("项目视图")}>
        {workspaceViewOptions.map(({ id, label, Icon }) => (
          <button
            key={id}
            className={`project-nav-item ${activeView === id ? "active" : ""}`}
            type="button"
            aria-current={activeView === id ? "page" : undefined}
            onClick={() => {
              onSelectView(id);
              onClose();
            }}
          >
            <Icon size={18} />
            <span>{t(label)}</span>
          </button>
        ))}
      </nav>

      <div className="topic-list-heading">
        <div>
          <span className="eyebrow">Topics</span>
          <span className="count-pill">{topics.length}</span>
        </div>
      </div>

      <div className="topic-filter-chips" role="group" aria-label={t("按状态筛选议题")}>
        {statusFilterOptions.map((option) => (
          <button
            key={option.id}
            className={`filter-chip ${statusFilter === option.id ? "active" : ""}`}
            type="button"
            aria-pressed={statusFilter === option.id}
            onClick={() => onStatusFilterChange(option.id)}
          >
            {t(option.label)}
          </button>
        ))}
      </div>

      <div className="topic-list" role="list">
        {topics.length > 0 ? (
          topics.map((topic) => (
            <div role="listitem" key={topic.id}>
              <button
                className={`topic-row ${topic.id === selectedTopicId ? "selected" : ""}`}
                type="button"
                onClick={() => {
                  onSelectTopic(topic.id);
                  onClose();
                }}
              >
                <span className="topic-title">{topic.title}</span>
                <StatusBadge status={topic.status} />
                <span className="topic-updated">{topic.updatedLabel}</span>
              </button>
            </div>
          ))
        ) : (
          <div className="empty-topics">
            <SearchX size={24} />
            <p>{t("没有匹配的议题")}</p>
          </div>
        )}
      </div>
    </aside>
  );
}
