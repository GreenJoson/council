/**
 * @input  依赖：mermaid 源码文本；动态 import("mermaid")（首屏不加载，仅遇到图时才拉取）；
 *         document.documentElement 的 data-theme 属性（浅/深主题联动）
 * @output 导出：MermaidDiagram —— 把 mermaid 源码渲染成有界缩略图，支持点击放大回调、
 *         主题切换即时重渲染，渲染失败时降级为原始代码块 + 错误提示，绝不白屏
 * @pos    MarkdownContent 内联 mermaid 围栏的渲染路径；架构档案图集复用同一份组件，
 *         保证消息流、决策详情与架构档案三处的图表渲染/主题联动逻辑完全一致
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { AlertTriangle, Maximize2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { MermaidConfig } from "mermaid";

// 动态 import 且模块级缓存：整个会话只会真正拉取一次 mermaid 包，
// 多个图表实例共享同一个 Promise，不会重复触发网络/解析开销。
let mermaidModulePromise: Promise<typeof import("mermaid")> | null = null;
function loadMermaidModule(): Promise<typeof import("mermaid")> {
  mermaidModulePromise ??= import("mermaid");
  return mermaidModulePromise;
}

function resolveMermaidTheme(): NonNullable<MermaidConfig["theme"]> {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "default";
}

type RenderState =
  | { status: "loading" }
  | { status: "ready"; svg: string }
  | { status: "error"; message: string };

export interface MermaidDiagramProps {
  code: string;
  /** 点击图表时回调渲染好的 SVG 字符串；不传则不可点击放大（例如渲染失败时不会调用） */
  onOpen?: (svg: string) => void;
}

export function MermaidDiagram({ code, onOpen }: MermaidDiagramProps) {
  const rawId = useId();
  const renderId = `mermaid-${rawId.replace(/[^a-zA-Z0-9-]/g, "")}`;
  const [themeName, setThemeName] = useState(resolveMermaidTheme);
  const [state, setState] = useState<RenderState>({ status: "loading" });

  // 主题切换（HeaderBar 循环按钮 / 跟随系统）通过 data-theme 属性生效，
  // MutationObserver 是唯一能感知"根节点属性被改写"的通用方式；组件卸载时断开。
  useEffect(() => {
    const target = document.documentElement;
    const observer = new MutationObserver(() => setThemeName(resolveMermaidTheme()));
    observer.observe(target, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    void loadMermaidModule()
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          // 显式声明为 strict（mermaid 默认值也是 strict）：渲染输出仍会经 mermaid 自身
          // DOMPurify 清洗后才允许注入 DOM，click 类交互指令被禁用；绝不使用 loose。
          securityLevel: "strict",
          theme: themeName,
        });
        const { svg } = await mermaid.render(renderId, code);
        return svg;
      })
      .then((svg) => {
        if (active) {
          setState({ status: "ready", svg });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : "Mermaid 图渲染失败",
          });
        }
      });
    return () => {
      active = false;
    };
  }, [code, renderId, themeName]);

  if (state.status === "error") {
    return (
      <div className="mermaid-fallback">
        <div className="mermaid-fallback-heading">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>架构图渲染失败：{state.message}</span>
        </div>
        <pre className="mermaid-fallback-source">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  if (state.status === "loading") {
    return (
      <div className="mermaid-loading" aria-busy="true" aria-label="正在渲染架构图">
        <span className="mermaid-loading-dot" aria-hidden="true" />
        正在渲染架构图…
      </div>
    );
  }

  const svg = state.svg;

  if (!onOpen) {
    return (
      // mermaid 渲染输出已经过其自身 securityLevel="strict" 的清洗，且渲染源仅来自受信的
      // fenced code 文本（不经 rehype-raw 的 HTML 注入路径），此处注入是安全的。
      <div className="mermaid-diagram-frame">
        <div className="mermaid-diagram-preview" dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
    );
  }

  return (
    <button
      type="button"
      className="mermaid-diagram-frame mermaid-diagram-frame-clickable"
      onClick={() => onOpen(svg)}
      aria-label="放大查看架构图"
    >
      {/* 同上：mermaid 自身已清洗过的 SVG，安全注入 */}
      <span
        className="mermaid-diagram-preview"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <span className="mermaid-diagram-zoom-hint" aria-hidden="true">
        <Maximize2 size={14} />
        点击放大
      </span>
    </button>
  );
}
