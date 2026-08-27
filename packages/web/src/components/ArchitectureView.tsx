/**
 * @input  依赖：界面语言上下文、项目名/路径、议题摘要列表、只读议题详情懒加载回调（经共享的 useTopicDetails
 *         hook 一次性加载全部议题）、跳转讨论/决策记录/创建议题三个回调，以及
 *         data/selectors.ts 的架构档案聚合纯函数（buildArchitectureTimeline/
 *         aggregateConstraints/collectArchitectureDiagrams）
 * @output 导出：ArchitectureView 项目架构档案——从讨论决策中聚合生成的架构沉淀页，
 *         由项目概览、架构演进时间线、架构不变量、架构图/业务解析图集四个区块组成；
 *         后三个区块可折叠，折叠状态跨会话保留
 * @pos    Operator Console 架构档案视图：只读聚合已加载数据，不改变全局选中状态；
 *         四个内容区块拆分在 components/architecture/ 下，本文件只做数据编排、折叠状态与 Lightbox 状态
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { Boxes, Plus, RefreshCw, TriangleAlert } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { ArchitectureConstraints } from "./architecture/ArchitectureConstraints";
import { ArchitectureDiagramGallery } from "./architecture/ArchitectureDiagramGallery";
import { ArchitectureOverview } from "./architecture/ArchitectureOverview";
import { ArchitectureTimeline } from "./architecture/ArchitectureTimeline";
import { Lightbox, type LightboxContent } from "./Lightbox";
import { useTopicDetails } from "../hooks/useTopicDetails";
import {
  aggregateConstraints,
  buildArchitectureTimeline,
  collectArchitectureDiagrams,
} from "../data/selectors";
import {
  readCollapsedSections,
  writeCollapsedSections,
  type SectionId,
} from "../data/section-collapse";
import type { Participant, TopicDetail, TopicSummary } from "../types/council";
import { useI18n } from "../i18n/I18nProvider";

export interface ArchitectureViewProps {
  projectName: string;
  /** 桌面原生模式下的当前项目绝对路径；mock/http 模式下没有该信息 */
  projectPath?: string;
  /** 只读取摘要字段（id/title/status/updatedLabel），复用已加载的 workspace.topics，不发起请求 */
  topics: TopicSummary[];
  participants: Map<string, Participant>;
  /** 只读旁路加载完整详情；不改变 activeTopicId，不触发订阅（见 CouncilRepository.loadTopicDetail） */
  onLoadDetail: (topicId: string) => Promise<TopicDetail>;
  onOpenTopic: (topicId: string) => void;
  onOpenDecisionRecord: (topicId: string) => void;
  onCreateTopic: () => void;
}

export function ArchitectureView({
  projectName,
  projectPath,
  topics,
  participants,
  onLoadDetail,
  onOpenTopic,
  onOpenDecisionRecord,
  onCreateTopic,
}: ArchitectureViewProps) {
  const { t } = useI18n();
  const topicIds = useMemo(() => topics.map((topic) => topic.id), [topics]);
  const { details, errors, retry } = useTopicDetails(topicIds, onLoadDetail);
  const [lightboxContent, setLightboxContent] = useState<LightboxContent | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<SectionId>>(
    readCollapsedSections,
  );

  const toggleSection = useCallback((id: SectionId) => {
    setCollapsedSections((current) => {
      const next = new Set(current);
      if (!next.delete(id)) {
        next.add(id);
      }
      writeCollapsedSections(next);
      return next;
    });
  }, []);

  // 只用已经加载完成的议题详情聚合四个区块：不阻塞整页渲染，随加载进度逐步补全。
  const loadedTopics = useMemo(
    () =>
      topics
        .map((topic) => details.get(topic.id))
        .filter((detail): detail is TopicDetail => Boolean(detail)),
    [topics, details],
  );

  const timelineEntries = useMemo(() => buildArchitectureTimeline(loadedTopics), [loadedTopics]);
  const constraints = useMemo(() => aggregateConstraints(loadedTopics), [loadedTopics]);
  const diagrams = useMemo(() => collectArchitectureDiagrams(loadedTopics), [loadedTopics]);

  const acceptedCount = loadedTopics.filter((topic) => topic.decision?.status === "accepted").length;
  const proposedCount = loadedTopics.filter((topic) => topic.decision?.status === "proposed").length;

  const loadingProgressLabel =
    details.size < topics.length
      ? t("正在加载议题详情…（{loaded}/{total}）", {
        loaded: details.size,
        total: topics.length,
      })
      : null;

  if (topics.length === 0) {
    return (
      <section className="architecture-view" aria-label={t("项目架构档案")}>
        <div className="architecture-empty">
          <Boxes size={28} aria-hidden="true" />
          <h2>{t("这个工作区还没有议题")}</h2>
          <p>{t("架构档案来自讨论中的决策：在方案与综合消息里用 ```mermaid 围栏画图、在决策里写下约束，都会自动归档到这里。先创建第一个议题开始讨论吧。")}</p>
          <button className="primary-button" type="button" onClick={onCreateTopic}>
            <Plus size={17} />
            {t("创建议题")}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="architecture-view" aria-label={t("项目架构档案")}>
      <header className="architecture-view-header">
        <h1>{t("项目架构档案")}</h1>
        <p>{t("从讨论决策中聚合生成的架构沉淀页，随每一次接受决策自动更新")}</p>
      </header>

      {errors.size > 0 ? (
        <div className="architecture-error-banner" role="alert">
          <TriangleAlert size={16} aria-hidden="true" />
          <span>{t("{count} 个议题详情加载失败，架构档案可能不完整", { count: errors.size })}</span>
          <button
            className="secondary-button"
            type="button"
            onClick={() => errors.forEach((_message, topicId) => retry(topicId))}
          >
            <RefreshCw size={14} />
            {t("重试失败项")}
          </button>
        </div>
      ) : null}

      <div className="architecture-view-body">
        <ArchitectureOverview
          projectName={projectName}
          projectPath={projectPath}
          topicCount={topics.length}
          acceptedCount={acceptedCount}
          proposedCount={proposedCount}
          loadingProgressLabel={loadingProgressLabel}
        />
        <ArchitectureTimeline
          entries={timelineEntries}
          onOpenTopic={onOpenTopic}
          onOpenDecisionRecord={onOpenDecisionRecord}
          isCollapsed={collapsedSections.has("timeline")}
          onToggleCollapse={toggleSection}
        />
        <ArchitectureConstraints
          constraints={constraints}
          isCollapsed={collapsedSections.has("constraints")}
          onToggleCollapse={toggleSection}
        />
        <ArchitectureDiagramGallery
          diagrams={diagrams}
          participants={participants}
          onOpenLightbox={setLightboxContent}
          isCollapsed={collapsedSections.has("diagrams")}
          onToggleCollapse={toggleSection}
        />
      </div>

      {lightboxContent ? (
        <Lightbox content={lightboxContent} onClose={() => setLightboxContent(null)} />
      ) : null}
    </section>
  );
}
