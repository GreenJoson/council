/**
 * @input  依赖：界面语言上下文、selectors.ts 的 ArchitectureDiagramSource 列表、参与者展示名、Lightbox 放大回调与折叠开关
 * @output 导出：ArchitectureDiagramGallery 架构档案第四区块——聚合渲染的架构图/业务解析图集
 * @pos    ArchitectureView 的第四区块；每张图复用 MermaidDiagram（含首屏懒加载、主题联动、
 *         渲染失败降级）渲染并标注来源（ADR 编号或消息作者 + 时间），点击复用共享 Lightbox 放大
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { Images } from "lucide-react";
import type { LightboxContent } from "../Lightbox";
import { MermaidDiagram } from "../MermaidDiagram";
import type { ArchitectureDiagramSource } from "../../data/selectors";
import type { Participant } from "../../types/council";
import type { SectionId } from "../../data/section-collapse";
import { AgentAvatar } from "../presentation";
import { useI18n } from "../../i18n/I18nProvider";
import { ArchitectureSection } from "./ArchitectureSection";

export interface ArchitectureDiagramGalleryProps {
  diagrams: ArchitectureDiagramSource[];
  participants: Map<string, Participant>;
  onOpenLightbox: (content: LightboxContent) => void;
  isCollapsed: boolean;
  onToggleCollapse: (id: SectionId) => void;
}

export function ArchitectureDiagramGallery({
  diagrams,
  participants,
  onOpenLightbox,
  isCollapsed,
  onToggleCollapse,
}: ArchitectureDiagramGalleryProps) {
  const { t } = useI18n();
  return (
    <ArchitectureSection
      id="diagrams"
      className="architecture-diagrams"
      icon={<Images size={17} aria-hidden="true" />}
      title="架构图 / 业务解析图"
      count={diagrams.length}
      isCollapsed={isCollapsed}
      onToggle={onToggleCollapse}
    >
      {diagrams.length === 0 ? (
        <p className="architecture-section-empty">
          {t("还没有架构图。在方案、综合消息或已接受决策里用 ```mermaid 围栏画图，会集中展示在这里。")}
        </p>
      ) : (
        <div className="architecture-diagram-grid">
          {diagrams.map((diagram, index) => (
            <figure className="architecture-diagram-card" key={`${diagram.topicId}-${String(index)}`}>
              <MermaidDiagram
                code={diagram.code}
                onOpen={(svg) => {
                  const sourceLabel = formatDiagramSourceLabel(diagram, participants);
                  onOpenLightbox({ kind: "diagram", svg, alt: sourceLabel });
                }}
              />
              <figcaption className="architecture-diagram-caption">
                {diagram.origin.kind === "message" ? (
                  <AgentAvatar agent={diagram.origin.author} size="small" />
                ) : null}
                <span>{formatDiagramSourceLabel(diagram, participants)}</span>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </ArchitectureSection>
  );
}

function formatDiagramSourceLabel(
  diagram: ArchitectureDiagramSource,
  participants: Map<string, Participant>,
): string {
  if (diagram.origin.kind === "decision") {
    return diagram.origin.adrNumber
      ? `${diagram.origin.adrNumber} · ${diagram.topicTitle}`
      : diagram.topicTitle;
  }
  const authorName = participants.get(diagram.origin.author)?.name ?? diagram.origin.author;
  return `${authorName} · Synthesis · ${diagram.origin.timeLabel}`;
}
