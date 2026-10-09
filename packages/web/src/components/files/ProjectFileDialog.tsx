/**
 * @input  依赖：文件引用、加载/失败/预览状态、关闭与重试操作
 * @output 导出：软件内只读文件预览（工作表切换、网格、Markdown、原始文本）
 * @pos    不执行源文件；公式只展示缓存值；焦点限制在弹层内，关闭后回到原入口
 */
import { ExternalLink, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fileReferenceName, type ProjectFilePreview, type ProjectFileReference } from "../../data/project-files";
import { useI18n } from "../../i18n/I18nProvider";
import { MarkdownContent } from "../MarkdownContent";
import { ProjectFileIcon } from "./ProjectFileIcon";

export function ProjectFileDialog({ reference, preview, error, onClose, onRetry }: {
  reference: ProjectFileReference; preview: ProjectFilePreview | null; error: string | null;
  onClose: () => void; onRetry: () => void;
}) {
  const { t, locale } = useI18n();
  const frame = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [source, setSource] = useState(false);
  useEffect(() => { setSheetIndex(0); setSource(false); }, [preview]);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
      if (event.key === "Tab") {
        const elements = [...(frame.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], select, textarea, [tabindex="0"]') ?? [])];
        const first = elements[0]; const last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", handle);
    return () => {
      window.removeEventListener("keydown", handle); document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [onClose]);
  const sheet = preview?.sheets?.[sheetIndex];
  const name = preview?.name ?? fileReferenceName(reference.href);
  return createPortal(<div className="project-file-scrim" onClick={onClose}>
    <div className="project-file-dialog" role="dialog" aria-modal="true" aria-label={t("文件预览：{name}", { name })} ref={frame} onClick={(event) => event.stopPropagation()}>
      <header className="project-file-header">
        <ProjectFileIcon href={name} size={24} />
        <div className="project-file-heading"><h2>{reference.label || name}</h2><span>{name}</span></div>
        <span className="project-file-readonly">{t("只读预览")}</span>
        <button className="icon-button" ref={closeButton} type="button" aria-label={t("关闭文件预览")} onClick={onClose}><X size={20} /></button>
      </header>
      {preview ? <div className="project-file-metadata">
        <code>{preview.relativePath}</code>
        <span>{new Intl.NumberFormat(locale, { style: "unit", unit: "kilobyte", maximumFractionDigits: 1 }).format(preview.sizeBytes / 1000)}</span>
        <span>{t("文件更新：{time}", { time: new Date(preview.updatedAt).toLocaleString(locale) })}</span>
      </div> : null}
      <p className="project-file-notice">{t("项目文件引用 · 显示当前文件内容，不是归档副本。文件移动或删除后引用可能失效。")}</p>
      {!preview && !error ? <div className="project-file-state" role="status"><LoaderCircle className="spinner" size={24} />{t("正在读取文件…")}</div> : null}
      {error ? <div className="project-file-state" role="alert"><p>{t(error)}</p><button className="secondary-button" type="button" onClick={onRetry}><RefreshCw size={16} />{t("重试")}</button></div> : null}
      {preview?.kind === "spreadsheet" ? <>
        <div className="project-file-sheet-tabs" role="tablist" aria-label={t("工作表")}>
          {preview.sheets?.map((item, index) => <button type="button" role="tab" tabIndex={index === sheetIndex ? 0 : -1} aria-selected={index === sheetIndex} aria-controls="project-file-sheet" key={`${index}-${item.name}`} onClick={() => setSheetIndex(index)} onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const count = preview.sheets!.length;
            const next = event.key === "Home" ? 0 : event.key === "End" ? count - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + count) % count;
            setSheetIndex(next);
            (event.currentTarget.parentElement?.children[next] as HTMLButtonElement | undefined)?.focus();
          }}>{item.name}</button>)}
        </div>
        <p className="project-file-sheet-info">{sheet ? t("{rows} 行 × {columns} 列 · 公式显示文件保存时的值，不重新计算。", { rows: sheet.rowCount, columns: sheet.columnCount }) : t("没有可预览的工作表。")}</p>
        <div className="project-file-grid" id="project-file-sheet" role="tabpanel" aria-label={sheet?.name} tabIndex={0}>
          {sheet && sheet.columnCount > 0 ? <table><thead><tr><th scope="col">#</th>{Array.from({ length: Math.max(0, ...sheet.rows.map((row) => row.length)) }, (_, index) => <th scope="col" key={index}>{columnLabel(index)}</th>)}</tr></thead>
            <tbody>{sheet.rows.map((row, index) => <tr key={index}><th scope="row">{index + 1}</th>{row.map((cell, c) => <td key={c} title={cell}>{cell}</td>)}</tr>)}</tbody></table> : <p>{t("工作表为空。")}</p>}
        </div>
      </> : null}
      {preview && preview.kind !== "spreadsheet" ? <>
        {preview.kind === "markdown" ? <div className="project-file-text-tabs"><button className="secondary-button" type="button" aria-pressed={source} onClick={() => setSource(!source)}><ExternalLink size={14} />{t(source ? "阅读视图" : "查看源码")}</button></div> : null}
        <div className="project-file-text" tabIndex={0}>
          {preview.kind === "markdown" && !source ? <MarkdownContent content={preview.text ?? ""} topicId={reference.topicId} fileBasePath={preview.relativePath} localFilePreview /> : <pre>{preview.text}</pre>}
        </div>
      </> : null}
      {preview?.truncated || sheet?.truncated ? <p className="project-file-truncated" role="status">{t("预览已按大小或行列上限截取；原文件未修改。")}</p> : null}
    </div>
  </div>, document.body);
}

function columnLabel(index: number): string {
  let value = index + 1; let label = "";
  while (value > 0) { value--; label = String.fromCharCode(65 + value % 26) + label; value = Math.floor(value / 26); }
  return label;
}
