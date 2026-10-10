/**
 * @input  依赖：界面语言、app/routes 的 WorkspaceRoute/buildHash、议题摘要（含实施完成度）、任务与流水线列表、桌面设置、
 *         components/ImplementationProgress 的任务状态文案、features/tasks 与 features/pipelines 的文案表、StatusBadge
 * @output 导出：ConversationList —— V2 壳的会话列表栏：项目切换菜单、⌘K 搜索、全部/议题/任务/流水线分段筛选、
 *         议题行（时间与完成度左右分列，未拆分实施项时不渲染徽标）、任务/流水线行（hash 链接）、新建议题入口与手机端关闭
 * @pos    把原顶栏的项目菜单与搜索、原侧栏的议题列表合并为一个「会话流」；任务/流水线 chip 直接切主区路由，
 *         全部/议题只过滤本栏并在其他视图下带回讨论视图；跨视图切换只回调路由对象，由 App 壳写 hash
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  Check,
  ChevronDown,
  Database,
  FolderOpen,
  ListTodo,
  Plus,
  Search,
  SearchX,
  Workflow,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { buildHash, type WorkspaceRoute } from "../app/routes";
import type { DesktopSettings } from "../data/desktop-bridge";
import { STAGE_LABELS, STAGE_STATUS_LABELS, TEMPLATE_LABELS } from "../features/pipelines/pipeline-labels";
import { KIND_LABELS } from "../features/tasks/task-labels";
import { useI18n } from "../i18n/I18nProvider";
import type { CouncilWorkItem, ProjectSummary, TopicSummary } from "../types/council";
import type { PipelineSummary } from "../types/pipelines";
import { WORK_ITEM_STATUS_LABELS } from "./ImplementationProgress";
import { StatusBadge } from "./presentation";

type StreamFilter = "all" | "topics" | "tasks" | "pipelines";

const streamFilterOptions: { id: StreamFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "topics", label: "议题" },
  { id: "tasks", label: "任务" },
  { id: "pipelines", label: "流水线" },
];

/** 「全部」模式下任务与流水线各只露出前几条，其余交给对应视图的完整列表。 */
const STREAM_PREVIEW_LIMIT = 5;

export interface ConversationListProps {
  project: ProjectSummary;
  topics: TopicSummary[];
  tasks: CouncilWorkItem[];
  pipelines: PipelineSummary[];
  route: WorkspaceRoute;
  selectedTopicId: string;
  isOpen: boolean;
  searchQuery: string;
  desktopSettings?: DesktopSettings;
  onSearchChange: (query: string) => void;
  onNavigate: (route: WorkspaceRoute) => void;
  onSelectTopic: (topicId: string) => void;
  onCreateTopic: () => void;
  onClose: () => void;
  onChooseProject?: () => Promise<void>;
  onChooseLogLibrary?: () => Promise<void>;
  onSelectRecentProject?: (path: string) => Promise<void>;
}

function pathBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function matchesQuery(title: string, query: string): boolean {
  return query === "" || title.toLowerCase().includes(query);
}

/**
 * 议题完成度徽标。没有实施项时什么都不渲染——一排 `0/0` 只会增加噪音，
 * 「还没拆」和「一条都没做完」是两件不同的事。
 */
function TopicProgressPill({
  progress,
}: {
  progress: TopicSummary["workItemProgress"];
}) {
  const { t } = useI18n();
  if (!progress) {
    return null;
  }
  const done = progress.completed === progress.total;
  const tone = progress.openBlockingFindings > 0 || progress.blocked > 0
    ? "blocked"
    : done
      ? "done"
      : "active";
  return (
    <span
      className={`topic-progress topic-progress-${tone}`}
      title={
        progress.openBlockingFindings > 0
          ? t("{count} 条审核问题未关闭", { count: progress.openBlockingFindings })
          : progress.blocked > 0
            ? t("{count} 项受阻，需先解除依赖", { count: progress.blocked })
            : t("已完成 {completed}，共 {total} 项任务", {
              completed: progress.completed,
              total: progress.total,
            })
      }
    >
      {done ? <Check size={11} /> : null}
      {progress.completed} / {progress.total}
    </span>
  );
}

export function ConversationList({
  project,
  topics,
  tasks,
  pipelines,
  route,
  selectedTopicId,
  isOpen,
  searchQuery,
  desktopSettings,
  onSearchChange,
  onNavigate,
  onSelectTopic,
  onCreateTopic,
  onClose,
  onChooseProject,
  onChooseLogLibrary,
  onSelectRecentProject,
}: ConversationListProps) {
  const { t } = useI18n();
  // 任务/流水线 chip 由路由决定；全部/议题是本栏自己的过滤状态
  const [localFilter, setLocalFilter] = useState<"all" | "topics">("all");
  const [isProjectMenuOpen, setIsProjectMenuOpen] = useState(false);
  const projectShellRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 菜单打开时：点击菜单外或按 Esc 关闭
  useEffect(() => {
    if (!isProjectMenuOpen) {
      return;
    }
    function handlePointerDown(event: PointerEvent) {
      if (!projectShellRef.current?.contains(event.target as Node)) {
        setIsProjectMenuOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsProjectMenuOpen(false);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isProjectMenuOpen]);

  // ⌘K / Ctrl+K 聚焦搜索
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const currentProjectPath = desktopSettings?.currentProjectPath ?? null;
  const recentProjectPaths = (desktopSettings?.recentProjectPaths ?? []).filter(
    (path) => path !== currentProjectPath,
  );

  const activeFilter: StreamFilter =
    route.view === "tasks" ? "tasks" : route.view === "pipelines" ? "pipelines" : localFilter;
  const query = searchQuery.trim().toLowerCase();
  const matchedTasks = tasks.filter((task) => matchesQuery(task.title, query));
  const matchedPipelines = pipelines.filter((pipeline) => matchesQuery(pipeline.title, query));
  const showsTopics = activeFilter === "all" || activeFilter === "topics";
  const visibleTasks = activeFilter === "tasks"
    ? matchedTasks
    : activeFilter === "all" ? matchedTasks.slice(0, STREAM_PREVIEW_LIMIT) : [];
  const visiblePipelines = activeFilter === "pipelines"
    ? matchedPipelines
    : activeFilter === "all" ? matchedPipelines.slice(0, STREAM_PREVIEW_LIMIT) : [];
  const isEmpty = (!showsTopics || topics.length === 0)
    && visibleTasks.length === 0 && visiblePipelines.length === 0;
  const emptyLabel = activeFilter === "tasks"
    ? "没有匹配的任务"
    : activeFilter === "pipelines" ? "没有匹配的流水线" : "没有匹配的议题";

  function selectFilter(id: StreamFilter): void {
    if (id === "tasks") {
      onNavigate({ view: "tasks" });
      return;
    }
    if (id === "pipelines") {
      onNavigate({ view: "pipelines" });
      return;
    }
    setLocalFilter(id);
    // 从任务/流水线/其他视图点回「全部」或「议题」时带回讨论视图，主区才和本栏对得上
    if (route.view !== "discussion") {
      onNavigate({ view: "discussion", topicId: selectedTopicId || undefined });
    }
  }

  return (
    <aside className={`topic-sidebar ${isOpen ? "panel-open" : ""}`} aria-label={t("议题导航")}>
      <div className="sidebar-mobile-heading">
        <span>{t("议题导航")}</span>
        <button className="icon-button" type="button" aria-label={t("关闭议题导航")} onClick={onClose}>
          <X size={18} />
        </button>
      </div>

      <div className="stream-toolbar">
        <div className="project-switcher-shell" ref={projectShellRef}>
          {desktopSettings ? (
            <button
              className="project-switcher"
              type="button"
              aria-label={t("切换项目")}
              aria-haspopup="menu"
              aria-expanded={isProjectMenuOpen}
              title={currentProjectPath ?? project.name}
              onClick={() => setIsProjectMenuOpen((current) => !current)}
            >
              <span className="project-mark" aria-hidden="true" />
              <span>{project.name}</span>
              <ChevronDown size={15} />
            </button>
          ) : (
            <span className="project-switcher is-static" title={project.name}>
              <span className="project-mark" aria-hidden="true" />
              <span>{project.name}</span>
            </span>
          )}
          {desktopSettings && isProjectMenuOpen ? (
            <div className="project-menu" role="menu">
              <div className="project-menu-scroll">
                {currentProjectPath ? (
                  <>
                    <div className="project-menu-label">{t("当前项目")}</div>
                    <div className="project-menu-current">
                      <FolderOpen size={15} />
                      <span className="project-entry">
                        <span className="project-entry-name">{pathBasename(currentProjectPath)}</span>
                        <code className="project-entry-path">{currentProjectPath}</code>
                      </span>
                      <Check size={15} className="project-current-check" />
                    </div>
                  </>
                ) : null}
                {recentProjectPaths.length > 0 ? (
                  <>
                    <div className="project-menu-label">{t("最近项目")}</div>
                    {recentProjectPaths.map((path) => (
                      <button
                        type="button"
                        key={path}
                        title={path}
                        onClick={() => {
                          setIsProjectMenuOpen(false);
                          void onSelectRecentProject?.(path);
                        }}
                      >
                        <FolderOpen size={15} />
                        <span className="project-entry">
                          <span className="project-entry-name">{pathBasename(path)}</span>
                          <code className="project-entry-path">{path}</code>
                        </span>
                      </button>
                    ))}
                  </>
                ) : null}
              </div>
              <div className="project-menu-divider" />
              <button
                type="button"
                onClick={() => {
                  setIsProjectMenuOpen(false);
                  void onChooseProject?.();
                }}
              >
                <FolderOpen size={15} />
                <span>{t("打开其他项目…")}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsProjectMenuOpen(false);
                  void onChooseLogLibrary?.();
                }}
              >
                <Database size={15} />
                <span>{t("设置日志库…")}</span>
              </button>
            </div>
          ) : null}
        </div>
        <button
          className="icon-button new-topic-button"
          type="button"
          aria-label={t("新建议题")}
          title={t("新建议题")}
          onClick={onCreateTopic}
        >
          <Plus size={18} />
        </button>
      </div>

      <label className="global-search">
        <Search size={16} aria-hidden="true" />
        <span className="sr-only">{t("搜索议题")}</span>
        <input
          ref={searchInputRef}
          type="search"
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={t("搜索议题标题或问题…")}
        />
        <kbd>⌘ K</kbd>
      </label>

      <div className="stream-filter-chips" role="group" aria-label={t("筛选会话流")}>
        {streamFilterOptions.map((option) => (
          <button
            key={option.id}
            className={`filter-chip ${activeFilter === option.id ? "active" : ""}`}
            type="button"
            aria-pressed={activeFilter === option.id}
            onClick={() => selectFilter(option.id)}
          >
            {t(option.label)}
          </button>
        ))}
      </div>

      <div className="topic-list-scroll">
        <div className="topic-list" role="list">
          {showsTopics
            ? topics.map((topic) => (
              <div role="listitem" key={`topic:${topic.id}`}>
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
                  <TopicProgressPill progress={topic.workItemProgress} />
                </button>
              </div>
            ))
            : null}

          {visibleTasks.map((task) => {
            const selected = route.view === "tasks" && route.taskId === task.id;
            return (
              <div role="listitem" key={`task:${task.id}`}>
                <a
                  className={`stream-row ${selected ? "selected" : ""}`}
                  href={buildHash({ view: "tasks", taskId: task.id })}
                  aria-current={selected ? "page" : undefined}
                  onClick={onClose}
                >
                  <ListTodo size={14} aria-hidden="true" />
                  <span className="stream-row-body">
                    <span className="topic-title">{task.title}</span>
                    <span className="stream-row-meta">
                      {t(KIND_LABELS[task.kind])} · {t(WORK_ITEM_STATUS_LABELS[task.status])}
                    </span>
                  </span>
                </a>
              </div>
            );
          })}
          {activeFilter === "all" && matchedTasks.length > STREAM_PREVIEW_LIMIT ? (
            <div role="listitem">
              <a className="stream-more" href={buildHash({ view: "tasks" })} onClick={onClose}>
                {t("更多任务")} · {matchedTasks.length}
              </a>
            </div>
          ) : null}

          {visiblePipelines.map((pipeline) => {
            const selected = route.view === "pipelines" && route.pipelineId === pipeline.id;
            return (
              <div role="listitem" key={`pipeline:${pipeline.id}`}>
                <a
                  className={`stream-row ${selected ? "selected" : ""}`}
                  href={buildHash({ view: "pipelines", pipelineId: pipeline.id })}
                  aria-current={selected ? "page" : undefined}
                  onClick={onClose}
                >
                  <Workflow size={14} aria-hidden="true" />
                  <span className="stream-row-body">
                    <span className="topic-title">{pipeline.title}</span>
                    <span className="stream-row-meta">
                      {t(TEMPLATE_LABELS[pipeline.template])} · {t(STAGE_LABELS[pipeline.currentStageId])}
                      {" "}{t(STAGE_STATUS_LABELS[pipeline.currentStageStatus])}
                    </span>
                  </span>
                </a>
              </div>
            );
          })}
          {activeFilter === "all" && matchedPipelines.length > STREAM_PREVIEW_LIMIT ? (
            <div role="listitem">
              <a className="stream-more" href={buildHash({ view: "pipelines" })} onClick={onClose}>
                {t("更多流水线")} · {matchedPipelines.length}
              </a>
            </div>
          ) : null}

          {isEmpty ? (
            <div className="empty-topics">
              <SearchX size={24} />
              <p>{t(emptyLabel)}</p>
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
