/**
 * @input  依赖：已加载的工作区议题摘要、项目名称与议题打开/创建回调
 * @output 导出：ArchitectureView 五列状态看板
 * @pos    Operator Console 架构视图：按 TopicStatus 分组展示项目议题总览，不发起任何请求
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { Boxes, GitBranch, Plus } from "lucide-react";
import { groupTopicsByStatus, topicStatusOrder } from "../data/selectors";
import type { TopicSummary } from "../types/council";
import { topicStatusLabels } from "./presentation";

export interface ArchitectureViewProps {
  projectName: string;
  /** 只读取摘要字段（标题/状态/更新时间），复用已加载的 workspace.topics，不发起请求 */
  topics: TopicSummary[];
  onOpenTopic: (topicId: string) => void;
  onCreateTopic: () => void;
}

export function ArchitectureView({ projectName, topics, onOpenTopic, onCreateTopic }: ArchitectureViewProps) {
  const grouped = groupTopicsByStatus(topics);

  return (
    <section className="architecture-view" aria-label="架构视图">
      <header className="architecture-view-header">
        <h1>
          <GitBranch size={18} aria-hidden="true" />
          架构视图
        </h1>
        <p>
          {projectName} · 共 {topics.length} 个议题
        </p>
      </header>

      {topics.length === 0 ? (
        <div className="architecture-empty">
          <Boxes size={28} aria-hidden="true" />
          <h2>这个工作区还没有议题</h2>
          <p>创建第一个架构议题，即可在这里按状态追踪它的推进节奏。</p>
          <button className="primary-button" type="button" onClick={onCreateTopic}>
            <Plus size={17} />
            创建议题
          </button>
        </div>
      ) : (
        <div className="architecture-board">
          {topicStatusOrder.map((status) => {
            const columnTopics = grouped[status];
            return (
              <div className={`architecture-column architecture-column-${status}`} key={status}>
                <header className="architecture-column-header">
                  <span className="architecture-column-dot" aria-hidden="true" />
                  <h2>{topicStatusLabels[status]}</h2>
                  <span className="count-pill">{columnTopics.length}</span>
                </header>
                <div
                  className="architecture-column-body"
                  role="list"
                  aria-label={`${topicStatusLabels[status]}议题`}
                >
                  {columnTopics.length > 0 ? (
                    columnTopics.map((topic) => (
                      <div role="listitem" key={topic.id}>
                        <button
                          className="architecture-card"
                          type="button"
                          onClick={() => onOpenTopic(topic.id)}
                        >
                          <span className="architecture-card-title">{topic.title}</span>
                          <span className="architecture-card-updated">{topic.updatedLabel}</span>
                        </button>
                      </div>
                    ))
                  ) : (
                    <p className="architecture-column-empty">暂无议题</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
