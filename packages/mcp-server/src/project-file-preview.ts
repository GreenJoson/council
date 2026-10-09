/**
 * @input  依赖：议题绑定项目、文件引用、集中预览预算与敏感路径策略
 * @output 导出：ProjectFilePreviewService，返回只读文本/Markdown/表格预览
 * @pos    HTTP 文件入口的业务边界；拒绝越界/敏感路径及符号链接逃逸，文件内容不写数据库与日志
 */
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { getAsset, isSea } from "node:sea";
import { HttpError } from "./http/responses.js";
import { isProtectedProjectRelativePath } from "./project-path-policy.js";
import { DEFAULT_PROJECT_FILE_PREVIEW_CONFIG, type ProjectFilePreviewConfig } from "./project-file-preview-config.js";

const TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
  ".xml", ".html", ".htm", ".css", ".scss", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py",
  ".rs", ".go", ".sql", ".sh", ".bash", ".zsh", ".log", ".csv", ".tsv", ".svg",
]);
const SPREADSHEET_EXTENSIONS = new Set([".xlsx", ".csv", ".tsv"]);

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
    if (!projectPath) throw new HttpError(409, "议题未绑定项目目录，无法预览项目文件。");
    let root: string;
    let absolute: string;
    let relativePath: string;
    try {
      root = await realpath(projectPath);
      const base = basePath ? path.resolve(root, localPath(basePath)) : root;
      const requested = path.resolve(basePath ? path.dirname(base) : base, localPath(href));
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
    const extension = path.extname(absolute).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension) && !SPREADSHEET_EXTENSIONS.has(extension) && !/^(readme|license|dockerfile|makefile)$/i.test(path.basename(absolute))) {
      throw new HttpError(415, "暂不支持此文件格式；可预览 XLSX、CSV、Markdown 和文本配置文件。");
    }
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
    return {
      ...metadata, kind: extension === ".md" || extension === ".markdown" ? "markdown" as const : "text" as const,
      text: text.slice(0, this.config.maxTextChars), truncated: text.length > this.config.maxTextChars,
    };
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
