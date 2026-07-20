/**
 * @input  依赖：react-markdown、remark-gfm、rehype-raw、rehype-sanitize、MermaidDiagram、
 *         Lightbox 与 theme.css 语义类名
 * @output 导出：MarkdownContent 统一 Markdown 渲染组件（GFM、内嵌 HTML 安全渲染、
 *         ```mermaid 围栏内联渲染成图、图片/图表 Lightbox、长内容折叠）
 * @pos    讨论消息、议题问题与决策文本的唯一 Markdown 渲染入口；安全白名单集中维护于此；
 *         mermaid 走独立渲染路径（不经 rehype-raw 的 HTML 注入），架构档案图集复用同一份
 *         MermaidDiagram/Lightbox 保证渲染与主题联动逻辑一致
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { ImageOff } from "lucide-react";
import { isValidElement, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Options as Schema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { Lightbox, type LightboxContent } from "./Lightbox";
import { MermaidDiagram } from "./MermaidDiagram";

/** 折叠阈值：需与 components.css 里 .markdown-collapse-frame.is-clamped 的 max-height 保持一致 */
const COLLAPSE_THRESHOLD_PX = 420;

/**
 * 安全白名单：以默认 schema（对齐 GitHub 的清洗规则，已包含 table/thead/tbody/tr/td/th、
 * 标题、列表、引用块等常见标签，且不含 script/iframe/on* 事件属性）为基础做最小追加：
 * - img 显式补充 alt/title（默认 schema 通过通配符 "*" 已隐式允许，这里显式声明便于审计）；
 * - img 的 src 额外放行 data: 协议，用于消息里内嵌的 data URI 缩略图（例如小型 SVG 图标），
 *   避免真实场景下必须外链图床。绝不放行 script、事件属性或未在白名单内的标签。
 *
 * 注意：react-markdown 在这层 sanitize 之前，还会用自带的 urlTransform 预先过滤 href/src——
 * 默认白名单只有 http(s)/ircs?/mailto/xmpp，data: 会被提前清空，光改这里的 protocols 不够，
 * 必须配合下面的 markdownUrlTransform 一起放行，两层都要同意。
 */
const markdownSanitizeSchema: Schema = {
  ...defaultSchema,
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    img: [...(defaultSchema.attributes?.img ?? []), "alt", "title"],
  },
  protocols: {
    ...(defaultSchema.protocols ?? {}),
    src: [...(defaultSchema.protocols?.src ?? []), "data"],
  },
};

/** 只放行 img 标签的 data:image/* 图片 URI；其余属性/标签一律走默认安全协议白名单 */
const SAFE_DATA_IMAGE_SRC = /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,/i;

const markdownUrlTransform: UrlTransform = (url, key, node) => {
  if (key === "src" && node.tagName === "img" && SAFE_DATA_IMAGE_SRC.test(url)) {
    return url;
  }
  return defaultUrlTransform(url);
};

export interface MarkdownContentProps {
  content: string;
  /** 超过折叠阈值时默认收起并显示"展开全文"；默认 false（如决策详情，需要完整展示） */
  collapsible?: boolean;
}

export function MarkdownContent({ content, collapsible = false }: MarkdownContentProps) {
  const [lightboxContent, setLightboxContent] = useState<LightboxContent | null>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [needsCollapse, setNeedsCollapse] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  // 用 ResizeObserver 测量未裁剪内容的真实高度：measureRef 自身不被裁剪（裁剪发生在其父级
  // .markdown-collapse-frame），所以 offsetHeight 始终反映内容真实高度，窗口宽度变化触发的
  // 重排也能被正确捕获。非浏览器环境（如未来的 SSR/测试）缺少 ResizeObserver 时优雅降级。
  useEffect(() => {
    if (!collapsible) {
      setNeedsCollapse(false);
      return;
    }
    const el = measureRef.current;
    if (!el) {
      return;
    }
    const evaluate = () => setNeedsCollapse(el.offsetHeight > COLLAPSE_THRESHOLD_PX);
    evaluate();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(evaluate);
    observer.observe(el);
    return () => observer.disconnect();
  }, [collapsible, content]);

  const isClamped = collapsible && needsCollapse && !isExpanded;

  const components: Components = {
    h1: ({ node: _node, ...props }) => (
      <h1 className="markdown-heading markdown-heading-1" {...props} />
    ),
    h2: ({ node: _node, ...props }) => (
      <h2 className="markdown-heading markdown-heading-2" {...props} />
    ),
    h3: ({ node: _node, ...props }) => (
      <h3 className="markdown-heading markdown-heading-3" {...props} />
    ),
    h4: ({ node: _node, ...props }) => (
      <h4 className="markdown-heading markdown-heading-4" {...props} />
    ),
    h5: ({ node: _node, ...props }) => (
      <h5 className="markdown-heading markdown-heading-5" {...props} />
    ),
    h6: ({ node: _node, ...props }) => (
      <h6 className="markdown-heading markdown-heading-6" {...props} />
    ),
    a: ({ node: _node, href, children, ...props }) => (
      <a
        {...props}
        href={href}
        rel="noopener noreferrer"
        onClick={(event) => {
          // 桌面端 WebView 内不做应用内导航，一律交给系统默认浏览器打开
          event.preventDefault();
          if (href) {
            window.open(href, "_blank", "noopener");
          }
        }}
      >
        {children}
      </a>
    ),
    table: ({ node: _node, children, ...props }) => (
      <div className="markdown-table-scroll">
        <table {...props}>{children}</table>
      </div>
    ),
    img: ({ src, alt, title }) => (
      <MarkdownImage
        src={typeof src === "string" ? src : ""}
        alt={alt ?? ""}
        title={title}
        onOpen={(openedSrc, openedAlt) =>
          setLightboxContent({ kind: "image", src: openedSrc, alt: openedAlt })}
      />
    ),
    // ```mermaid 围栏走独立渲染路径：source 从 fenced code 的纯文本里拍平取得，
    // 从未经过 rehype-raw 的 HTML 注入通道，MermaidDiagram 内部再由 mermaid 自身
    // securityLevel="strict" 清洗一遍渲染结果，双重把关后才注入 DOM。
    pre: ({ node: _node, children, ...props }) => {
      const mermaidSource = getMermaidSource(children);
      if (mermaidSource === null) {
        return <pre {...props}>{children}</pre>;
      }
      return (
        <MermaidDiagram
          code={mermaidSource}
          onOpen={(svg) => setLightboxContent({ kind: "diagram", svg, alt: "架构图放大视图" })}
        />
      );
    },
  };

  return (
    <div className="markdown-collapsible-wrap">
      <div className={`markdown-collapse-frame ${isClamped ? "is-clamped" : ""}`}>
        <div className="markdown-content" ref={measureRef}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw, [rehypeSanitize, markdownSanitizeSchema]]}
            urlTransform={markdownUrlTransform}
            components={components}
          >
            {content}
          </ReactMarkdown>
        </div>
        {isClamped ? <div className="markdown-fade" aria-hidden="true" /> : null}
      </div>
      {collapsible && needsCollapse ? (
        <button
          className="markdown-toggle"
          type="button"
          onClick={() => setIsExpanded((current) => !current)}
        >
          {isExpanded ? "收起" : "展开全文"}
        </button>
      ) : null}

      {lightboxContent ? (
        <Lightbox content={lightboxContent} onClose={() => setLightboxContent(null)} />
      ) : null}
    </div>
  );
}

interface MarkdownImageProps {
  src: string;
  alt: string;
  title?: string;
  onOpen: (src: string, alt: string) => void;
}

/** 缩略图：加载失败时退化为占位提示，不留一个破图标 */
function MarkdownImage({ src, alt, title, onOpen }: MarkdownImageProps) {
  const [hasError, setHasError] = useState(false);

  if (!src || hasError) {
    return (
      <span className="markdown-image-fallback" role="img" aria-label={alt || "图片加载失败"}>
        <ImageOff size={15} aria-hidden="true" />
        <span>{alt ? `${alt}（加载失败）` : "图片加载失败"}</span>
      </span>
    );
  }

  return (
    <img
      className="markdown-image"
      src={src}
      alt={alt}
      title={title}
      loading="lazy"
      decoding="async"
      onError={() => setHasError(true)}
      onClick={() => onOpen(src, alt)}
    />
  );
}

/**
 * 从 fenced code 块的 React 子树里拍平出纯文本：代码块内容本身不会被 remark 再解析出
 * 内联格式，正常情况下 children 只是一个字符串，这里的递归只是为了防御性地兼容
 * react-markdown 未来可能产出的数组/嵌套元素形态，不代表当前会真的走到那些分支。
 */
function flattenReactNodeText(node: ReactNode): string {
  if (typeof node === "string") {
    return node;
  }
  if (typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(flattenReactNodeText).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return flattenReactNodeText(node.props.children);
  }
  return "";
}

/**
 * 判断一个 <pre> 的子元素是不是 rehype 为 ```mermaid 围栏产出的 <code className="language-mermaid">，
 * 是则返回其纯文本源码，否则返回 null（交回默认 <pre><code> 渲染）。
 */
function getMermaidSource(children: ReactNode): string | null {
  const child = Array.isArray(children) ? children[0] : children;
  if (!isValidElement<{ className?: unknown; children?: ReactNode }>(child)) {
    return null;
  }
  const className = child.props.className;
  if (typeof className !== "string" || !/(?:^|\s)language-mermaid(?:\s|$)/.test(className)) {
    return null;
  }
  return flattenReactNodeText(child.props.children).replace(/\n$/, "");
}
