/**
 * @input  依赖：议题绑定项目、文件引用、集中预览预算与敏感路径策略、assets/asset-sniff 的文件头嗅探
 * @output 导出：ProjectFilePreviewService（preview 只读文本/Markdown/HTML 源码/表格预览、image 项目内图片字节只读出站、
 *         readProjectFile 按项目相对路径读字节供 HTML 页面视图端口出站、resolveHtml 校验「在浏览器中打开」的目标）与 ProjectImagePayload
 * @pos    HTTP 文件入口的业务边界；解析与读取两段共用：拒绝越界/敏感路径及符号链接逃逸，文件内容不写数据库与日志；
 *         图片出站要求扩展名与文件头都是图片，大小沿用预览上限；HTML 页面引用的相对资源也逐个走同一套解析与读取
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { getAsset, isSea } from "node:sea";
import { sniffAssetMime } from "./assets/asset-sniff.js";
import { HttpError } from "./http/responses.js";
import { isProtectedProjectRelativePath } from "./project-path-policy.js";
import { DEFAULT_PROJECT_FILE_PREVIEW_CONFIG, type ProjectFilePreviewConfig } from "./project-file-preview-config.js";

const TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
  ".xml", ".html", ".htm", ".css", ".scss", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py",
  ".rs", ".go", ".sql", ".sh", ".bash", ".zsh", ".log", ".csv", ".tsv", ".svg",
]);
const SPREADSHEET_EXTENSIONS = new Set([".xlsx", ".csv", ".tsv"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);

export interface ProjectImagePayload {
  bytes: Buffer;
  mime: string;
  name: string;
}

function within(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function localPath(href: string): string {
  const value = href.trim();
  try {
    if (/^file:/i.test(value)) return fileURLToPath(new URL(value));
    if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) throw new Error();
    if (value.startsWith("//") || value.startsWith("\\\\")) throw new Error();
    return decodeURIComponent(value.split(/[?#]/, 1)[0]!);
  } catch {
    throw new HttpError(400, "文件引用无效，仅支持当前项目中的本地文件。");
  }
}

export class ProjectFilePreviewService {
  #active = false;
  constructor(readonly config: ProjectFilePreviewConfig = DEFAULT_PROJECT_FILE_PREVIEW_CONFIG) {}

  async preview(projectPath: string | undefined, href: string, basePath?: string) {
    const { absolute, relativePath } = await this.#resolve(projectPath, href, basePath);
    const extension = path.extname(absolute).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension) && !SPREADSHEET_EXTENSIONS.has(extension) && !/^(readme|license|dockerfile|makefile)$/i.test(path.basename(absolute))) {
      throw new HttpError(415, "暂不支持此文件格式；可预览 XLSX、CSV、Markdown 和文本配置文件。");
    }
    const { bytes, updatedAt } = await this.#readBytes(absolute);
    const metadata = { name: path.basename(absolute), relativePath, sizeBytes: bytes.length, updatedAt };
    if (SPREADSHEET_EXTENSIONS.has(extension)) {
      if (this.#active) throw new HttpError(429, "正在解析另一个表格，请稍后重试。");
      this.#active = true;
      try { return { ...metadata, kind: "spreadsheet" as const, ...await this.#spreadsheet(bytes, extension) }; }
      finally { this.#active = false; }
    }
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new HttpError(415, "文件不是 UTF-8 文本，暂时无法预览。"); }
    if (text.includes("\0")) throw new HttpError(415, "文件不是可预览的文本格式。");
    const kind = extension === ".md" || extension === ".markdown" ? "markdown" as const
      : HTML_EXTENSIONS.has(extension) ? "html" as const : "text" as const;
    return { ...metadata, kind, text: text.slice(0, this.config.maxTextChars), truncated: text.length > this.config.maxTextChars };
  }

  /**
   * HTML 页面视图端口按项目相对路径取文件（页面本身及其引用的 CSS/JS/图片/字体等）：路径已由 URL 段解码，
   * 不再做 href 式的二次解码；越界、敏感路径、大小上限与符号链接检查同预览。
   */
  async readProjectFile(projectPath: string, relativePath: string): Promise<{ bytes: Buffer; name: string }> {
    const { absolute } = await this.#resolveLocal(projectPath, relativePath);
    const { bytes } = await this.#readBytes(absolute);
    return { bytes, name: path.basename(absolute) };
  }

  /** 「在浏览器中打开」的目标：只接受项目内的 .html/.htm 普通文件，返回校验后的真实路径。 */
  async resolveHtml(projectPath: string | undefined, href: string, basePath?: string): Promise<string> {
    const { absolute } = await this.#resolve(projectPath, href, basePath);
    if (!HTML_EXTENSIONS.has(path.extname(absolute).toLowerCase())) {
      throw new HttpError(415, "只能在浏览器中打开 HTML 文件。");
    }
    if (!(await stat(absolute).then((info) => info.isFile(), () => false))) {
      throw new HttpError(404, "项目文件不存在或不可读取，可能已移动或删除。");
    }
    return absolute;
  }

  /** 消息正文里项目相对路径图片的只读出站：扩展名与文件头都必须是图片；字节不入库、不写日志。 */
  async image(projectPath: string | undefined, href: string, basePath?: string): Promise<ProjectImagePayload> {
    const { absolute } = await this.#resolve(projectPath, href, basePath);
    if (!IMAGE_EXTENSIONS.has(path.extname(absolute).toLowerCase())) {
      throw new HttpError(415, "该文件不是图片，无法作为图片显示。");
    }
    const { bytes } = await this.#readBytes(absolute);
    const mime = sniffAssetMime(bytes);
    if (!mime?.startsWith("image/")) throw new HttpError(415, "该文件内容不是图片，无法显示。");
    return { bytes, mime, name: path.basename(absolute) };
  }

  /** 消息里的引用（可能是 file: URL 或百分号编码）先还原成本地路径，再按项目根解析。 */
  async #resolve(projectPath: string | undefined, href: string, basePath?: string): Promise<{ absolute: string; relativePath: string }> {
    return this.#resolveLocal(projectPath, localPath(href), basePath === undefined ? undefined : localPath(basePath));
  }

  /** 议题项目根 + 本地路径 → 真实绝对路径；越界、敏感路径、符号链接逃逸一律 403，不存在 404。 */
  async #resolveLocal(projectPath: string | undefined, target: string, basePath?: string): Promise<{ absolute: string; relativePath: string }> {
    if (!projectPath) throw new HttpError(409, "议题未绑定项目目录，无法预览项目文件。");
    let absolute: string;
    let relativePath: string;
    try {
      const root = await realpath(projectPath);
      const base = basePath ? path.resolve(root, basePath) : root;
      const requested = path.resolve(basePath ? path.dirname(base) : base, target);
      const lexicalRoot = within(root, requested) ? root : path.resolve(projectPath);
      if (!within(lexicalRoot, requested) || isProtectedProjectRelativePath(path.relative(lexicalRoot, requested))) {
        throw new HttpError(403, "该文件位于项目之外或属于受保护路径，无法预览。");
      }
      absolute = await realpath(requested);
      relativePath = path.relative(root, absolute).split(path.sep).join("/");
      if (!within(root, absolute) || isProtectedProjectRelativePath(relativePath)) {
        throw new HttpError(403, "该文件位于项目之外或属于受保护路径，无法预览。");
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(404, "项目文件不存在或不可读取，可能已移动或删除。");
    }
    return { absolute, relativePath };
  }

  /** 校验后的路径读入内存：非阻塞打开、NOFOLLOW、inode 复核，超过预览上限 413。 */
  async #readBytes(absolute: string): Promise<{ bytes: Buffer; updatedAt: string }> {
    let bytes: Buffer;
    let updatedAt: string;
    try {
      // 非阻塞打开防止 FIFO 挂起，NOFOLLOW 防止校验后的末级链接替换。
      const handle = await open(absolute, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await handle.stat();
        const verifiedPath = await realpath(absolute);
        const verifiedInfo = await stat(verifiedPath);
        if (verifiedPath !== absolute || info.ino !== verifiedInfo.ino || info.dev !== verifiedInfo.dev) {
          throw new HttpError(403, "该文件位于项目之外或属于受保护路径，无法预览。");
        }
        if (!info.isFile()) throw new HttpError(415, "目标不是普通文件，无法预览。");
        if (info.size > this.config.maxBytes) throw new HttpError(413, "文件超过预览大小上限。");
        bytes = Buffer.alloc(Math.min(info.size + 1, this.config.maxBytes + 1));
        let offset = 0;
        while (offset < bytes.length) {
          const read = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!read.bytesRead) break;
          offset += read.bytesRead;
        }
        if (offset > this.config.maxBytes) throw new HttpError(413, "文件超过预览大小上限。");
        bytes = bytes.subarray(0, offset);
        updatedAt = info.mtime.toISOString();
      } finally { await handle.close(); }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(404, "项目文件不存在或不可读取，可能已移动或删除。");
    }
    return { bytes, updatedAt };
  }

  async #spreadsheet(bytes: Buffer, extension: string): Promise<{
    sheets: { name: string; rows: string[][]; rowCount: number; columnCount: number; truncated: boolean }[];
    truncated: boolean;
  }> {
    return new Promise((resolve, reject) => {
      const options = { workerData: { bytes, extension, config: this.config }, resourceLimits: { maxOldGenerationSizeMb: this.config.workerMemoryMb } };
      const worker = isSea()
        ? new Worker(getAsset("spreadsheet-worker.cjs", "utf8"), { ...options, eval: true })
        : new Worker(new URL(`./spreadsheet-preview-worker.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url), options);
      const timer = setTimeout(() => fail("表格解析超时，请缩小文件后重试。"), this.config.timeoutMs);
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        reject(new HttpError(422, message));
      };
      worker.once("message", (result) => {
        if (result.error) return fail("表格损坏、加密或超过解析预算，无法预览。");
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        resolve(result);
      });
      worker.once("error", () => fail("表格损坏或超过解析预算，无法预览。"));
      worker.once("exit", () => { if (!settled) fail("表格解析未完成，请稍后重试。"); });
    });
  }
}
