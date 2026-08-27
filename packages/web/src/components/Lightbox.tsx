/**
 * @input  依赖：界面语言上下文、图片 URL 或已渲染的 mermaid SVG 字符串
 * @output 导出：LightboxContent 联合类型与 Lightbox 全屏大图浏览组件
 *         （body Portal、固定大视口、缩放、内部滚动、遮罩/Esc/关闭按钮）
 * @pos    MarkdownContent 图片缩略图与架构档案 mermaid 图集共用的唯一放大浏览入口；
 *         自研实现，不引入第三方弹层库
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { ImageOff, Minus, Plus, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/I18nProvider";

const DEFAULT_ZOOM_PERCENT = 100;
const MIN_ZOOM_PERCENT = 50;
const MAX_ZOOM_PERCENT = 300;
const ZOOM_STEP_PERCENT = 25;

export type LightboxContent =
  | { kind: "image"; src: string; alt: string }
  | { kind: "diagram"; svg: string; alt: string };

export interface LightboxProps {
  content: LightboxContent;
  onClose: () => void;
}

export function Lightbox({ content, onClose }: LightboxProps) {
  const { t } = useI18n();
  const [hasImageError, setHasImageError] = useState(false);
  const [zoomPercent, setZoomPercent] = useState(DEFAULT_ZOOM_PERCENT);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      } else if (event.key === "+" || event.key === "=") {
        setZoomPercent((current) =>
          Math.min(MAX_ZOOM_PERCENT, current + ZOOM_STEP_PERCENT));
      } else if (event.key === "-") {
        setZoomPercent((current) =>
          Math.max(MIN_ZOOM_PERCENT, current - ZOOM_STEP_PERCENT));
      } else if (event.key === "0") {
        setZoomPercent(DEFAULT_ZOOM_PERCENT);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const stageStyle = {
    "--lightbox-zoom": `${zoomPercent}%`,
    "--lightbox-scale": zoomPercent / 100,
  } as CSSProperties;

  return createPortal(
    <div
      className="markdown-lightbox-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={content.alt || t("查看大图")}
      onClick={onClose}
    >
      <div className="markdown-lightbox-frame" onClick={(event) => event.stopPropagation()}>
        <header className="markdown-lightbox-toolbar">
          <span className="markdown-lightbox-title">
            {content.alt || (content.kind === "diagram" ? t("架构图") : t("图片"))}
          </span>
          <div className="markdown-lightbox-controls" aria-label={t("大图缩放")}>
            <button
              type="button"
              aria-label={t("缩小")}
              title={t("缩小（-）")}
              disabled={zoomPercent === MIN_ZOOM_PERCENT}
              onClick={() =>
                setZoomPercent((current) =>
                  Math.max(MIN_ZOOM_PERCENT, current - ZOOM_STEP_PERCENT))}
            >
              <Minus size={16} />
            </button>
            <span aria-live="polite">{zoomPercent}%</span>
            <button
              type="button"
              aria-label={t("放大")}
              title={t("放大（+）")}
              disabled={zoomPercent === MAX_ZOOM_PERCENT}
              onClick={() =>
                setZoomPercent((current) =>
                  Math.min(MAX_ZOOM_PERCENT, current + ZOOM_STEP_PERCENT))}
            >
              <Plus size={16} />
            </button>
            <button
              type="button"
              aria-label={t("恢复默认大小")}
              title={t("恢复默认大小（0）")}
              onClick={() => setZoomPercent(DEFAULT_ZOOM_PERCENT)}
            >
              <RotateCcw size={15} />
            </button>
            <button
              className="markdown-lightbox-close"
              type="button"
              aria-label={t("关闭大图")}
              title={t("关闭（Esc）")}
              ref={closeButtonRef}
              onClick={onClose}
            >
              <X size={18} />
            </button>
          </div>
        </header>
        <div className="markdown-lightbox-canvas">
          <div className="markdown-lightbox-stage" style={stageStyle}>
            {content.kind === "image" ? (
              hasImageError ? (
                <div className="markdown-lightbox-fallback">
                  <ImageOff size={26} aria-hidden="true" />
                  <p>{t("图片加载失败")}</p>
                </div>
              ) : (
                <img
                  className="markdown-lightbox-image"
                  src={content.src}
                  alt={content.alt}
                  onError={() => setHasImageError(true)}
                />
              )
            ) : (
              // mermaid SVG 已经过 mermaid 自身 securityLevel="strict" 的清洗后才会被存入状态，
              // 且渲染源始终来自受信的 fenced code 文本（不经 rehype-raw），此处注入是安全的。
              <div
                className="markdown-lightbox-diagram"
                role="img"
                aria-label={content.alt || t("架构图放大视图")}
                dangerouslySetInnerHTML={{ __html: content.svg }}
              />
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
