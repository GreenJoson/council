/**
 * @input  依赖：selectors.ts 的 ArchitectureDiagramSource 列表、参与者展示名与 Lightbox 放大回调
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
import { AgentAvatar } from "../presentation";

export interface ArchitectureDiagramGalleryProps {
  diagrams: ArchitectureDiagramSource[];
  participants: Map<string, Participant>;
  onOpenLightbox: (content: LightboxContent) => void;
}

export function ArchitectureDiagramGallery({
  diagrams,
  participants,
  onOpenLightbox,
}: ArchitectureDiagramGalleryProps) {
  return (
    <section className="architecture-diagrams" aria-label="架构图与业务解析图">
      <header className="architecture-section-header">
        <h2>
          <Images size={17} aria-hidden="true" />
          架构图 / 业务解析图
        </h2>
        <span className="count-pill">{diagrams.length}</span>
      </header>

      {diagrams.length === 0 ? (
        <p className="architecture-section-empty">
          还没有架构图。在方案、综合消息或已接受决策里用 ```mermaid 围栏画图，会集中展示在这里。
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
    </section>
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
