/**
 * @input  依赖：从议题链接聚合的文件引用、折叠与跳转回调
 * @output 导出：架构档案附件卡片（类型、文件名、来源议题与内部预览入口）
 * @pos    引用列表无需预读文件；只有用户点击才访问文件服务
 */
import { ArrowUpRight, Paperclip } from "lucide-react";
import { fileReferenceName, fileReferenceType, type ArchitectureAttachment } from "../../data/project-files";
import type { SectionId } from "../../data/section-collapse";
import { useI18n } from "../../i18n/I18nProvider";
import { useOpenProjectFile } from "../../hooks/useProjectFiles";
import { ProjectFileIcon } from "../files/ProjectFileIcon";
import { ArchitectureSection } from "./ArchitectureSection";

export function ArchitectureAttachments({ attachments, isCollapsed, onToggleCollapse, onOpenTopic }: {
  attachments: ArchitectureAttachment[]; isCollapsed: boolean;
  onToggleCollapse: (id: SectionId) => void; onOpenTopic: (topicId: string) => void;
}) {
  const { t } = useI18n();
  const openFile = useOpenProjectFile();
  return <ArchitectureSection id="attachments" className="architecture-attachments" icon={<Paperclip size={17} />} title="项目附件" count={attachments.length} isCollapsed={isCollapsed} onToggle={onToggleCollapse}>
    <p className="architecture-attachment-hint">{t("自动汇总议题、消息和决策中的本地文件链接。引用当前项目文件，不复制文件，也不是固定版本备份。")}</p>
    {attachments.length ? <div className="architecture-attachment-list">
      {attachments.map((attachment) => <article className="architecture-attachment" key={`${attachment.topicId}:${attachment.href}`}>
        <button className="architecture-attachment-open" type="button" onClick={() => openFile?.(attachment)} disabled={!openFile} aria-label={t("预览附件：{name}", { name: attachment.label })}>
          <span className="architecture-attachment-icon"><ProjectFileIcon href={attachment.href} size={25} /></span>
          <span className="architecture-attachment-title"><strong>{attachment.label}</strong><span>{fileReferenceName(attachment.href)}</span></span>
          <span className="architecture-attachment-type">{fileReferenceType(attachment.href)}</span>
        </button>
        <button className="architecture-attachment-origin" type="button" title={attachment.topicTitle} onClick={() => onOpenTopic(attachment.topicId)}>{attachment.topicTitle}<ArrowUpRight size={13} /></button>
      </article>)}
    </div> : <p className="architecture-section-empty">{t("还没有附件。在议题或消息中添加 Markdown 本地文件链接，例如 [设计表](docs/design.xlsx)，即可在这里查看。")}</p>}
  </ArchitectureSection>;
}
