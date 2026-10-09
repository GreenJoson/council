/** @input 文件引用 @output 文件类型图标 @pos 附件卡片与正文链接共享展示 */
import { Braces, FileCode2, FileText, Sheet } from "lucide-react";
import { fileReferenceType } from "../../data/project-files";

export function ProjectFileIcon({ href, size = 20 }: { href: string; size?: number }) {
  const extension = fileReferenceType(href);
  const Icon = ["XLSX", "XLS", "CSV", "TSV"].includes(extension) ? Sheet
    : ["JSON", "JSONC", "YAML", "YML", "TOML", "XML"].includes(extension) ? Braces
    : ["JS", "MJS", "TS", "TSX", "PY", "SH", "HTML", "RS", "GO"].includes(extension) ? FileCode2 : FileText;
  return <Icon size={size} aria-hidden="true" />;
}
