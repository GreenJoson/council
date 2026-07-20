/**
 * @input  依赖：图片 URL 或已渲染的 mermaid SVG 字符串
 * @output 导出：LightboxContent 联合类型与 Lightbox 全屏放大组件（遮罩/Esc/关闭按钮三种退出方式）
 * @pos    MarkdownContent 图片缩略图与架构档案 mermaid 图集共用的唯一放大浏览入口；
 *         自研实现，不引入第三方弹层库
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { ImageOff, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type LightboxContent =
  | { kind: "image"; src: string; alt: string }
  | { kind: "diagram"; svg: string; alt: string };

export interface LightboxProps {
  content: LightboxContent;
  onClose: () => void;
}

export function Lightbox({ content, onClose }: LightboxProps) {
  const [hasImageError, setHasImageError] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="markdown-lightbox-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={content.alt || "查看大图"}
      onClick={onClose}
    >
      <div className="markdown-lightbox-frame" onClick={(event) => event.stopPropagation()}>
        <button
          className="markdown-lightbox-close"
          type="button"
          aria-label="关闭大图"
          ref={closeButtonRef}
          onClick={onClose}
        >
          <X size={18} />
        </button>
        {content.kind === "image" ? (
          hasImageError ? (
            <div className="markdown-lightbox-fallback">
              <ImageOff size={26} aria-hidden="true" />
              <p>图片加载失败</p>
            </div>
          ) : (
            <img src={content.src} alt={content.alt} onError={() => setHasImageError(true)} />
          )
        ) : (
          // mermaid SVG 已经过 mermaid 自身 securityLevel="strict" 的清洗后才会被存入状态，
          // 且渲染源始终来自受信的 fenced code 文本（不经 rehype-raw），此处注入是安全的。
          <div
            className="markdown-lightbox-diagram"
            role="img"
            aria-label={content.alt || "架构图放大视图"}
            dangerouslySetInnerHTML={{ __html: content.svg }}
          />
        )}
      </div>
    </div>
  );
}
