/**
 * @input  依赖：项目、同步状态、搜索与面板操作回调
 * @output 导出：HeaderBar 顶部命令栏
 * @pos    Operator Console 的全局导航和状态入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  Bell,
  ChevronDown,
  Menu,
  PanelRight,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";
import type { ProjectSummary, SyncState } from "../types/council";

export interface HeaderBarProps {
  project: ProjectSummary;
  sync: SyncState;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onCreateTopic: () => void;
  onRetrySync: () => void;
  onOpenTopics: () => void;
  onOpenInspector: () => void;
}

export function HeaderBar({
  project,
  sync,
  searchQuery,
  onSearchChange,
  onCreateTopic,
  onRetrySync,
  onOpenTopics,
  onOpenInspector,
}: HeaderBarProps) {
  return (
    <header className="header-bar">
      <div className="brand-cluster">
        <button
          className="icon-button mobile-panel-button"
          type="button"
          aria-label="打开议题导航"
          onClick={onOpenTopics}
        >
          <Menu size={19} />
        </button>
        <a className="brand" href="#main-content" aria-label="Council 首页">
          Council
        </a>
        <button className="project-switcher" type="button" aria-label="切换项目">
          <span className="project-mark" aria-hidden="true" />
          <span>{project.name}</span>
          <ChevronDown size={15} />
        </button>
      </div>

      <label className="global-search">
        <Search size={17} aria-hidden="true" />
        <span className="sr-only">搜索议题</span>
        <input
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="搜索 topics、参与者或内容…"
        />
        <kbd>⌘ K</kbd>
      </label>

      <div className="header-actions">
        {sync.status === "offline" ? (
          <button
            className={`sync-state sync-${sync.status}`}
            type="button"
            title={`${sync.label}，点击重试`}
            onClick={onRetrySync}
          >
            <Sparkles size={14} aria-hidden="true" />
            <span>{sync.label}</span>
          </button>
        ) : (
          <span className={`sync-state sync-${sync.status}`} title={sync.label}>
            <Sparkles size={14} aria-hidden="true" />
            <span>{sync.label}</span>
          </span>
        )}
        <button className="primary-button" type="button" onClick={onCreateTopic}>
          <Plus size={17} />
          <span>新建议题</span>
        </button>
        <button className="icon-button desktop-action" type="button" aria-label="通知">
          <Bell size={18} />
        </button>
        <button
          className="icon-button inspector-mobile-button"
          type="button"
          aria-label="打开议题摘要"
          onClick={onOpenInspector}
        >
          <PanelRight size={18} />
        </button>
        <button className="user-menu" type="button" aria-label="打开用户菜单">
          U
        </button>
      </div>
    </header>
  );
}
