/**
 * @input  依赖：Markdown AST、议题详情、HTTP/桌面桥与文件预览响应
 * @output 导出：本地文件引用聚合、预览类型（HTML 带页面视图地址）、文件/图片接口服务地址解析 resolveApiBaseUrl、
 *         预览数据访问入口与「在浏览器中打开」openProjectFileInBrowser
 * @pos    附件以项目文件引用存在；不上传、复制或隐式读取整棵目录；图片出站地址由 markdown-images.ts 复用 resolveApiBaseUrl 拼出
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { createDesktopBridge } from "./desktop-bridge";
import { createApiUrl, jsonRequest, requestApiData } from "./http-client";
import type { TopicDetail } from "../types/council";

export interface ProjectFileReference {
  topicId: string;
  href: string;
  label: string;
  basePath?: string;
}
export interface ArchitectureAttachment extends ProjectFileReference {
  topicTitle: string;
}
export interface PreviewSheet {
  name: string;
  rows: string[][];
  rowCount: number;
  columnCount: number;
  truncated: boolean;
}
export interface ProjectFilePreview {
  name: string;
  relativePath: string;
  sizeBytes: number;
  updatedAt: string;
  truncated: boolean;
  kind: "text" | "markdown" | "html" | "spreadsheet";
  text?: string;
  sheets?: PreviewSheet[];
  /** HTML 页面视图地址（本地服务的独立端口）；缺省表示页面视图不可用，只能看源码 */
  viewUrl?: string;
}

export function isProjectFileLink(href: string): boolean {
  const value = href.trim();
  if (!value || /^[#?]/.test(value) || value.startsWith("//") || value.startsWith("\\\\")) return false;
  return /^file:/i.test(value) || /^[a-z]:[\\/]/i.test(value) || !/^[a-z][a-z\d+.-]*:/i.test(value);
}

export function fileReferenceName(href: string): string {
  try { return decodeURIComponent(href.split(/[?#]/, 1)[0]!).split(/[\\/]/).filter(Boolean).at(-1) || href; }
  catch { return href; }
}

export function fileReferenceType(href: string): string {
  const name = fileReferenceName(href);
  const extension = name.includes(".") ? name.split(".").at(-1) : undefined;
  return extension && /^[a-z\d]{1,8}$/i.test(extension) ? extension.toUpperCase() : "FILE";
}

const parser = unified().use(remarkParse).use(remarkGfm);
type Node = { type: string; url?: string; value?: string; identifier?: string; children?: Node[] };

export function collectProjectAttachments(topics: readonly TopicDetail[]): ArchitectureAttachment[] {
  const result = new Map<string, ArchitectureAttachment>();
  for (const topic of topics) {
    const contents = [topic.question, ...topic.messages.map((message) => message.content),
      ...topic.decisions.flatMap((decision) => [decision.summary, decision.rationale])];
    for (const content of contents) {
      const tree = parser.parse(content) as Node;
      const definitions = new Map<string, string>();
      const walk = (node: Node, visit: (item: Node) => void) => {
        visit(node);
        node.children?.forEach((child) => walk(child, visit));
      };
      walk(tree, (node) => { if (node.type === "definition" && node.identifier && node.url) definitions.set(node.identifier, node.url); });
      const text = (node: Node): string => node.value ?? node.children?.map(text).join("") ?? "";
      walk(tree, (node) => {
        const href = node.type === "link" ? node.url : node.type === "linkReference" ? definitions.get(node.identifier ?? "") : undefined;
        if (!href || !isProjectFileLink(href)) return;
        let normalized = href;
        try { normalized = decodeURIComponent(href).replace(/^\.\//, "").split(/[?#]/, 1)[0]!; } catch { /* 预览接口负责错误反馈 */ }
        const key = `${topic.id}\0${normalized}`;
        if (!result.has(key)) result.set(key, { topicId: topic.id, topicTitle: topic.title, href, label: text(node) || fileReferenceName(href) });
      });
    }
  }
  return [...result.values()];
}

function parsePreview(value: unknown): ProjectFilePreview {
  if (!value || typeof value !== "object") throw new Error("文件预览响应无效");
  const data = value as ProjectFilePreview;
  if (typeof data.name !== "string" || typeof data.relativePath !== "string" || !Number.isSafeInteger(data.sizeBytes)
    || typeof data.updatedAt !== "string" || typeof data.truncated !== "boolean") throw new Error("文件预览元数据无效");
  if (data.kind === "spreadsheet") {
    if (!Array.isArray(data.sheets) || !data.sheets.every((sheet) => typeof sheet.name === "string" && Array.isArray(sheet.rows)
      && sheet.rows.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === "string"))
      && Number.isSafeInteger(sheet.rowCount) && Number.isSafeInteger(sheet.columnCount) && typeof sheet.truncated === "boolean")) {
      throw new Error("工作表预览响应无效");
    }
  } else if ((data.kind !== "text" && data.kind !== "markdown" && data.kind !== "html") || typeof data.text !== "string") {
    throw new Error("文件预览正文无效");
  }
  if (data.viewUrl !== undefined && (data.kind !== "html" || typeof data.viewUrl !== "string" || !/^https?:\/\//i.test(data.viewUrl))) {
    throw new Error("文件预览响应无效");
  }
  return data;
}

/**
 * 文件预览/图片接口的服务地址：mock 没有服务返回 undefined；桌面模式确保本地 Agent 服务可达
 * （不可达先拉起）后取其地址；http 模式读 VITE_COUNCIL_API_URL。
 */
export async function resolveApiBaseUrl(): Promise<string | undefined> {
  const mode = import.meta.env.VITE_COUNCIL_DATA_MODE ?? "mock";
  if (mode === "mock") return undefined;
  if (mode === "desktop") {
    const bridge = createDesktopBridge();
    if (!(await bridge.checkOrchestrationService()).reachable) await bridge.startOrchestrationService();
    return (await bridge.getOrchestrationConfig()).baseUrl;
  }
  return import.meta.env.VITE_COUNCIL_API_URL?.trim() || undefined;
}

async function fileServiceUrl(reference: ProjectFileReference, action: "preview" | "open"): Promise<URL> {
  if ((import.meta.env.VITE_COUNCIL_DATA_MODE ?? "mock") === "mock") throw new Error("演示模式没有本地文件；请连接项目后查看附件。");
  const baseUrl = await resolveApiBaseUrl();
  if (!baseUrl) throw new Error("未配置项目文件服务。");
  return createApiUrl(baseUrl, `/api/v1/topics/${encodeURIComponent(reference.topicId)}/files/${action}`);
}

function referenceBody(reference: ProjectFileReference): RequestInit {
  return jsonRequest({ href: reference.href, ...(reference.basePath ? { basePath: reference.basePath } : {}) });
}

export async function loadProjectFilePreview(reference: ProjectFileReference): Promise<ProjectFilePreview> {
  return requestApiData(globalThis.fetch.bind(globalThis), await fileServiceUrl(reference, "preview"), parsePreview, referenceBody(reference));
}

/** 项目内 HTML 交给本地服务用系统默认浏览器打开原文件（与双击同效）。 */
export async function openProjectFileInBrowser(reference: ProjectFileReference): Promise<void> {
  await requestApiData(globalThis.fetch.bind(globalThis), await fileServiceUrl(reference, "open"), () => undefined, referenceBody(reference));
}
