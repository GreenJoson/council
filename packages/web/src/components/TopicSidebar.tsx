/**
 * @input  依赖：议题列表、选中状态与关闭回调
 * @output 导出：TopicSidebar 项目和议题导航
 * @pos    Operator Console 左侧高密度导航区域
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  Archive,
  Boxes,
  FileCheck2,
  GitBranch,
  SearchX,
  SlidersHorizontal,
  X,
} from "lucide-react";
import type { TopicSummary } from "../types/council";
import { StatusBadge } from "./presentation";

export interface TopicSidebarProps {
  topics: TopicSummary[];
  selectedTopicId: string;
  isOpen: boolean;
  onSelectTopic: (topicId: string) => void;
  onClose: () => void;
}

export function TopicSidebar({
  topics,
  selectedTopicId,
  isOpen,
  onSelectTopic,
  onClose,
}: TopicSidebarProps) {
  return (
    <aside className={`topic-sidebar ${isOpen ? "panel-open" : ""}`} aria-label="议题导航">
      <div className="sidebar-mobile-heading">
        <span>议题导航</span>
        <button className="icon-button" type="button" aria-label="关闭议题导航" onClick={onClose}>
          <X size={18} />
        </button>
      </div>

      <nav className="project-navigation" aria-label="项目视图">
        <button className="project-nav-item active" type="button">
          <Boxes size={18} />
          <span>议题</span>
        </button>
        <button className="project-nav-item" type="button">
          <GitBranch size={18} />
          <span>架构视图</span>
        </button>
        <button className="project-nav-item" type="button">
          <FileCheck2 size={18} />
          <span>决策记录</span>
        </button>
      </nav>

      <div className="topic-list-heading">
        <div>
          <span className="eyebrow">Topics</span>
          <span className="count-pill">{topics.length}</span>
        </div>
        <button className="icon-button compact" type="button" aria-label="筛选议题">
          <SlidersHorizontal size={16} />
        </button>
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
            <p>没有匹配的议题</p>
          </div>
        )}
      </div>

      <button className="archive-button" type="button">
        <Archive size={17} />
        <span>归档 topics</span>
      </button>
    </aside>
  );
}
