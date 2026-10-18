/**
 * @input  依赖：文件引用、加载/失败/预览状态、关闭、重试与「在浏览器中打开」操作
 * @output 导出：软件内只读文件预览（工作表切换、网格、Markdown、HTML 页面/源码、原始文本）
 * @pos    除 HTML 外不执行源文件：HTML 页面只在本地服务独立端口（与 API 不同源）的沙箱 iframe 里运行，
 *         不能导航或弹出 Council 窗口；公式只展示缓存值；焦点限制在弹层内，关闭后回到原入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */
import { CodeXml, ExternalLink, Eye, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fileReferenceName, type ProjectFilePreview, type ProjectFileReference } from "../../data/project-files";
import { getErrorMessage } from "../../data/error-message";
import { useI18n } from "../../i18n/I18nProvider";
import { MarkdownContent } from "../MarkdownContent";
import { ProjectFileIcon } from "./ProjectFileIcon";

// 页面与 Council 不同源，allow-same-origin 只保留它自己的源（本地存储等可用），不能触及父窗口；不给顶层导航与弹窗。
const PAGE_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock";

export function ProjectFileDialog({ reference, preview, error, onClose, onRetry, onOpenInBrowser }: {
  reference: ProjectFileReference; preview: ProjectFilePreview | null; error: string | null;
  onClose: () => void; onRetry: () => void; onOpenInBrowser: () => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const frame = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [source, setSource] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openMessage, setOpenMessage] = useState<string | null>(null);
  useEffect(() => { setSheetIndex(0); setSource(false); setOpenMessage(null); }, [preview]);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
      if (event.key === "Tab") {
        const elements = [...(frame.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], select, textarea, iframe, [tabindex="0"]') ?? [])];
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
  const showPage = preview?.kind === "html" && Boolean(preview.viewUrl) && !source;
  const openInBrowser = async () => {
    setOpening(true); setOpenMessage(null);
    try { await onOpenInBrowser(); setOpenMessage("已交给系统浏览器打开。"); }
    catch (failure: unknown) { setOpenMessage(getErrorMessage(failure)); }
    finally { setOpening(false); }
  };
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
        {preview.kind === "html" ? <div className="project-file-text-tabs">
          {preview.viewUrl ? <button className="secondary-button" type="button" aria-pressed={source} onClick={() => setSource(!source)}>{source ? <Eye size={14} /> : <CodeXml size={14} />}{t(source ? "查看页面" : "查看源码")}</button> : null}
          <button className="secondary-button" type="button" disabled={opening} aria-busy={opening} onClick={() => void openInBrowser()}>{opening ? <LoaderCircle className="spinner" size={14} /> : <ExternalLink size={14} />}{t("在浏览器中打开")}</button>
          <span className="project-file-hint" role="status">{openMessage ? t(openMessage) : t(preview.viewUrl ? "页面在沙箱中运行，可以交互，不会修改项目文件。" : "页面预览暂不可用，下面显示源码。")}</span>
        </div> : null}
        {showPage ? <iframe className="project-file-frame" src={preview.viewUrl} title={t("页面预览：{name}", { name })} sandbox={PAGE_SANDBOX} referrerPolicy="no-referrer" /> : <div className="project-file-text" tabIndex={0}>
          {preview.kind === "markdown" && !source ? <MarkdownContent content={preview.text ?? ""} topicId={reference.topicId} fileBasePath={preview.relativePath} localFilePreview /> : <pre>{preview.text}</pre>}
        </div>}
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
