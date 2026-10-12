/**
 * @input  依赖：界面语言上下文、图片 URL 或已渲染的 mermaid SVG 字符串、可选的序列导航（位置/总数/翻页回调）
 * @output 导出：LightboxContent 联合类型、LightboxNavigation 与 Lightbox 全屏大图浏览组件
 *         （body Portal、固定大视口、缩放按钮/快捷键/触控板捏合、内部滚动、遮罩/Esc/关闭按钮；
 *         传入导航时左右两侧显示上一张/下一张、工具栏显示位置、←/→ 翻页，换图时缩放与滚动复位；
 *         长标题单行省略、悬停看全文，不撑宽框体）
 * @pos    MarkdownContent 图片、架构档案 mermaid 图集、资产详情/任务产物/流水线对比共用的唯一放大浏览入口；
 *         只负责显示与交互，序列内容由调用方按位置换 content；自研实现，不引入第三方弹层库
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { ChevronLeft, ChevronRight, ImageOff, Minus, Plus, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/I18nProvider";

const DEFAULT_ZOOM_PERCENT = 100;
const MIN_ZOOM_PERCENT = 50;
const MAX_ZOOM_PERCENT = 300;
const ZOOM_STEP_PERCENT = 25;
/** 触控板双指捏合（浏览器上报为 ctrlKey + wheel）每单位 deltaY 的缩放指数；越大越灵敏。 */
const PINCH_ZOOM_SENSITIVITY = 0.01;

function clampZoom(percent: number): number {
  return Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, percent));
}

export type LightboxContent =
  | { kind: "image"; src: string; alt: string }
  | { kind: "diagram"; svg: string; alt: string };

export interface LightboxNavigation {
  /** 当前项在序列中的位置，从 0 开始。 */
  index: number;
  total: number;
  /** 翻到序列中的另一项；调用方据此换 content。 */
  onNavigate: (index: number) => void;
}

export interface LightboxProps {
  content: LightboxContent;
  onClose: () => void;
  /** 序列浏览：total > 1 时左右两侧显示上一张/下一张，←/→ 键翻页；单张不传。 */
  navigation?: LightboxNavigation;
}

export function Lightbox({ content, onClose, navigation }: LightboxProps) {
  const { t } = useI18n();
  // 记下加载失败的地址而不是布尔值：翻到下一张时自然复位，不需要额外 effect
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [zoomPercent, setZoomPercent] = useState(DEFAULT_ZOOM_PERCENT);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  // 键盘监听只在打开时挂一次，回调经 ref 读最新值：调用方翻页时 onClose/navigation 会换引用，
  // 不能因此重挂监听、把焦点抢回关闭按钮
  const onCloseRef = useRef(onClose);
  const navigationRef = useRef(navigation);
  useEffect(() => {
    onCloseRef.current = onClose;
    navigationRef.current = navigation;
  });

  // 翻页：换图时缩放与滚动位置回到默认，不沿用上一张的放大状态
  const step = useCallback((delta: -1 | 1) => {
    const current = navigationRef.current;
    if (!current) return;
    const next = current.index + delta;
    if (next < 0 || next >= current.total) return;
    setZoomPercent(DEFAULT_ZOOM_PERCENT);
    canvasRef.current?.scrollTo({ top: 0, left: 0 });
    current.onNavigate(next);
  }, []);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCloseRef.current();
      } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && (navigationRef.current?.total ?? 0) > 1) {
        event.preventDefault();
        step(event.key === "ArrowLeft" ? -1 : 1);
      } else if (event.key === "+" || event.key === "=") {
        setZoomPercent((current) => clampZoom(current + ZOOM_STEP_PERCENT));
      } else if (event.key === "-") {
        setZoomPercent((current) => clampZoom(current - ZOOM_STEP_PERCENT));
      } else if (event.key === "0") {
        setZoomPercent(DEFAULT_ZOOM_PERCENT);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [step]);

  // 捏合缩放必须用非 passive 监听才能 preventDefault，否则 WebView 会整页缩放；普通滚轮留给画布滚动
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    function handleWheel(event: WheelEvent) {
      if (!event.ctrlKey) return;
      event.preventDefault();
      setZoomPercent((current) => clampZoom(current * Math.exp(-event.deltaY * PINCH_ZOOM_SENSITIVITY)));
    }
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, []);

  const hasNavigation = navigation !== undefined && navigation.total > 1;
  const canGoPrevious = hasNavigation && navigation.index > 0;
  const canGoNext = hasNavigation && navigation.index < navigation.total - 1;
  const hasImageError = content.kind === "image" && failedSrc === content.src;
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
      <div
        className={`markdown-lightbox-frame${hasNavigation ? " has-navigation" : ""}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="markdown-lightbox-toolbar">
          <span className="markdown-lightbox-title" title={content.alt || undefined}>
            {content.alt || (content.kind === "diagram" ? t("架构图") : t("图片"))}
          </span>
          {hasNavigation ? (
            <span className="markdown-lightbox-position" aria-live="polite">
              {t("第 {index} / {total} 张", { index: navigation.index + 1, total: navigation.total })}
            </span>
          ) : null}
          <div className="markdown-lightbox-controls" aria-label={t("大图缩放")}>
            <button
              type="button"
              aria-label={t("缩小")}
              title={t("缩小（-）")}
              disabled={zoomPercent <= MIN_ZOOM_PERCENT}
              onClick={() => setZoomPercent((current) => clampZoom(current - ZOOM_STEP_PERCENT))}
            >
              <Minus size={16} />
            </button>
            <span aria-live="polite">{Math.round(zoomPercent)}%</span>
            <button
              type="button"
              aria-label={t("放大")}
              title={t("放大（+）")}
              disabled={zoomPercent >= MAX_ZOOM_PERCENT}
              onClick={() => setZoomPercent((current) => clampZoom(current + ZOOM_STEP_PERCENT))}
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
        <div className="markdown-lightbox-body">
          <div className="markdown-lightbox-canvas" ref={canvasRef}>
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
                    onError={() => setFailedSrc(content.src)}
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
          {/* 翻页按钮浮在画布两侧而不在画布里：放大后画布滚动时按钮位置不动 */}
          {canGoPrevious ? (
            <button
              className="markdown-lightbox-nav is-previous"
              type="button"
              aria-label={t("上一张")}
              title={t("上一张（←）")}
              onClick={() => step(-1)}
            >
              <ChevronLeft size={28} />
            </button>
          ) : null}
          {canGoNext ? (
            <button
              className="markdown-lightbox-nav is-next"
              type="button"
              aria-label={t("下一张")}
              title={t("下一张（→）")}
              onClick={() => step(1)}
            >
              <ChevronRight size={28} />
            </button>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
