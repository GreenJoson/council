/**
 * @input  依赖：界面语言上下文、react-markdown、remark-gfm、rehype-raw、rehype-sanitize、MermaidDiagram、
 *         Lightbox 与 theme.css 语义类名
 * @output 导出：MarkdownContent 统一 Markdown 渲染组件（GFM、内嵌 HTML 安全渲染、
 *         ```mermaid 围栏内联渲染成缩略图、图片/图表大图浏览、长内容折叠）
 * @pos    讨论消息、议题问题与决策文本的唯一 Markdown 渲染入口；安全白名单集中维护于此；
 *         mermaid 走独立渲染路径（不经 rehype-raw 的 HTML 注入），架构档案图集复用同一份
 *         MermaidDiagram/Lightbox 保证渲染与主题联动逻辑一致
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { ChevronDown, ChevronUp, ImageOff } from "lucide-react";
import { isValidElement, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Options as Schema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { useI18n } from "../i18n/I18nProvider";
import { Lightbox, type LightboxContent } from "./Lightbox";
import { MermaidDiagram } from "./MermaidDiagram";

/** CSS token 缺失时的安全回退；正常路径从 --markdown-collapse-height 读取当前上下文阈值 */
const FALLBACK_COLLAPSE_THRESHOLD_PX = 420;

type MarkdownCollapseVariant = "content" | "topic";

const COLLAPSE_LABELS: Record<
  MarkdownCollapseVariant,
  { expand: string; collapse: string }
> = {
  content: { expand: "展开全文", collapse: "收起" },
  topic: { expand: "展开议题", collapse: "收起议题" },
};

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
  /** 议题摘要使用更紧凑的高度阈值和专属文案；正文默认使用 content */
  collapseVariant?: MarkdownCollapseVariant;
}

export function MarkdownContent({
  content,
  collapsible = false,
  collapseVariant = "content",
}: MarkdownContentProps) {
  const { t } = useI18n();
  const [lightboxContent, setLightboxContent] = useState<LightboxContent | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [needsCollapse, setNeedsCollapse] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  // 切换议题或替换正文后恢复默认收起，避免沿用上一条内容的展开状态。
  useEffect(() => {
    setIsExpanded(false);
  }, [collapseVariant, content]);

  // 用 ResizeObserver 测量未裁剪内容的真实高度：measureRef 自身不被裁剪（裁剪发生在其父级
  // .markdown-collapse-frame），所以 offsetHeight 始终反映内容真实高度，窗口宽度变化触发的
  // 重排也能被正确捕获。非浏览器环境（如未来的 SSR/测试）缺少 ResizeObserver 时优雅降级。
  useEffect(() => {
    if (!collapsible) {
      setNeedsCollapse(false);
      return;
    }
    const el = measureRef.current;
    const wrap = wrapRef.current;
    if (!el || !wrap) {
      return;
    }
    const evaluate = () => {
      const configuredHeight = Number.parseFloat(
        window.getComputedStyle(wrap).getPropertyValue("--markdown-collapse-height"),
      );
      const threshold =
        Number.isFinite(configuredHeight) && configuredHeight > 0
          ? configuredHeight
          : FALLBACK_COLLAPSE_THRESHOLD_PX;
      setNeedsCollapse(el.offsetHeight > threshold);
    };
    evaluate();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(evaluate);
    observer.observe(el);
    return () => observer.disconnect();
  }, [collapsible, collapseVariant, content]);

  const isClamped = collapsible && needsCollapse && !isExpanded;

  // 组件映射必须保持引用稳定：Mermaid 从加载态变为 SVG 后会改变正文高度并触发折叠测量，
  // 若每次渲染都创建新映射，ReactMarkdown 会重挂载 Mermaid，造成加载/测量循环和点击失效。
  const components = useMemo<Components>(() => ({
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
          onOpen={(svg) => setLightboxContent({ kind: "diagram", svg, alt: t("架构图放大视图") })}
        />
      );
    },
  }), [t]);

  const collapseLabels = COLLAPSE_LABELS[collapseVariant];
  const collapseToggle = collapsible && needsCollapse ? (
    <button
      className={`markdown-toggle ${isExpanded ? "is-expanded-toggle" : ""}`}
      type="button"
      aria-expanded={isExpanded}
      onClick={() => setIsExpanded((current) => !current)}
    >
      {collapseVariant === "topic" ? (
        isExpanded ? (
          <ChevronUp size={14} aria-hidden="true" />
        ) : (
          <ChevronDown size={14} aria-hidden="true" />
        )
      ) : null}
      {t(isExpanded ? collapseLabels.collapse : collapseLabels.expand)}
    </button>
  ) : null;
  const showTopicCollapseBeforeContent = collapseVariant === "topic" && isExpanded;

  return (
    <div
      className={`markdown-collapsible-wrap markdown-collapse-${collapseVariant}`}
      ref={wrapRef}
    >
      {/* 超长议题展开后，唯一的收起按钮若仍在正文末尾就等同于消失；移到顶部并交给 CSS 吸顶。 */}
      {showTopicCollapseBeforeContent ? collapseToggle : null}
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
      {showTopicCollapseBeforeContent ? null : collapseToggle}

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
  const { t } = useI18n();
  const [hasError, setHasError] = useState(false);

  if (!src || hasError) {
    return (
      <span className="markdown-image-fallback" role="img" aria-label={alt || t("图片加载失败")}>
        <ImageOff size={15} aria-hidden="true" />
        <span>{alt ? t("{alt}（加载失败）", { alt }) : t("图片加载失败")}</span>
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
