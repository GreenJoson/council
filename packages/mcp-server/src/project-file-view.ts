/**
 * @input  依赖：ProjectFilePreviewService（项目内路径解析、敏感路径与大小上限）、loopback 主机、文件预览配置中的
 *         视图端口/令牌有效期/令牌数上限、系统默认打开命令（macOS open、Linux xdg-open、Windows explorer）
 * @output 导出：ProjectFileViewServer（issue 为项目签发令牌并返回 HTML 页面地址，close 关闭端口）与
 *         openInSystemBrowser（用系统默认程序打开已校验的项目 HTML 文件）
 * @pos    HTML 页面预览与「在浏览器中打开」的出站边界：页面跑在与 REST API 不同源的独立 loopback 端口上，
 *         页面脚本请求 API 会带上非白名单 Origin 而被拒绝；页面引用的相对 CSS/JS/图片按同一令牌在项目根内逐个解析，
 *         越界与受保护路径沿用预览策略。端口首次签发时才监听；只接受 GET/HEAD，不写库、不记录文件内容
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { HttpError } from "./http/responses.js";
import { logger } from "./logger.js";
import type { ProjectFilePreviewService } from "./project-file-preview.js";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".avif": "image/avif", ".ico": "image/x-icon", ".bmp": "image/bmp",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
  ".mp4": "video/mp4", ".webm": "video/webm", ".wasm": "application/wasm",
};

/** 平台默认打开命令：参数数组直传，不经 shell。 */
const SYSTEM_OPENERS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "open",
  linux: "xdg-open",
  win32: "explorer.exe",
};

export interface ProjectFileViewOptions {
  host: string;
  port: number;
  tokenTtlMs: number;
  maxTokens: number;
}

interface ViewGrant {
  projectPath: string;
  expiresAt: number;
}

export class ProjectFileViewServer {
  /** 令牌 → 项目；Map 插入序即最近使用序，超出上限时淘汰最久未用的。 */
  readonly #grants = new Map<string, ViewGrant>();
  #server: Server | undefined;
  #origin: Promise<string> | undefined;
  #closed = false;

  constructor(
    private readonly files: ProjectFilePreviewService,
    private readonly options: ProjectFileViewOptions,
  ) {}

  /** 同一项目复用仍有效的令牌（页面地址稳定，本地存储也延续），否则签发新令牌。 */
  async issue(projectPath: string, relativePath: string): Promise<string> {
    const origin = await this.#listen();
    const now = Date.now();
    for (const [token, grant] of this.#grants) {
      if (grant.expiresAt <= now) this.#grants.delete(token);
    }
    const token = [...this.#grants].find(([, grant]) => grant.projectPath === projectPath)?.[0]
      ?? randomBytes(24).toString("base64url");
    this.#touch(token, projectPath);
    while (this.#grants.size > this.options.maxTokens) {
      this.#grants.delete(this.#grants.keys().next().value!);
    }
    return `${origin}/${token}/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
  }

  close(): void {
    this.#closed = true;
    this.#grants.clear();
    this.#server?.close();
    this.#server?.closeAllConnections();
  }

  #touch(token: string, projectPath: string): void {
    this.#grants.delete(token);
    this.#grants.set(token, { projectPath, expiresAt: Date.now() + this.options.tokenTtlMs });
  }

  #listen(): Promise<string> {
    if (this.#closed) return Promise.reject(new Error("页面预览端口已关闭。"));
    this.#origin ??= new Promise<string>((resolve, reject) => {
      const server = createServer((request, response) => { void this.#handle(request, response); });
      server.once("error", (error) => { this.#origin = undefined; reject(error); });
      server.listen(this.options.port, this.options.host, () => {
        server.removeAllListeners("error");
        server.on("error", (error) => logger.error("file-view", "页面预览端口异常", error));
        // 主服务决定进程寿命；预览端口不单独拖住退出。
        server.unref();
        this.#server = server;
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : this.options.port;
        const host = this.options.host.includes(":") ? `[${this.options.host}]` : this.options.host;
        resolve(`http://${host}:${String(port)}`);
      });
    });
    return this.#origin;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const head = request.method === "HEAD";
    const fail = (status: number, message: string) => {
      response.writeHead(status, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...(status === 405 ? { Allow: "GET, HEAD" } : {}),
      });
      response.end(head ? undefined : message);
    };
    if (request.method !== "GET" && !head) return fail(405, "页面预览只支持读取。");
    let segments: string[];
    try {
      // URL 解析会先折叠 . 与 ..（含百分号编码形式），再逐段解码。
      segments = new URL(request.url ?? "/", "http://view.invalid").pathname.split("/").slice(1).map(decodeURIComponent);
    } catch {
      return fail(400, "页面预览地址无效。");
    }
    const [token = "", ...parts] = segments;
    const grant = this.#grants.get(token);
    if (!grant || grant.expiresAt <= Date.now()) return fail(404, "预览链接已失效，请回到 Council 重新打开预览。");
    if (parts.length === 0 || parts.some((part) => !part || part === "." || part === ".." || /[\\/\0]/u.test(part))) {
      return fail(404, "项目文件不存在。");
    }
    this.#touch(token, grant.projectPath);
    try {
      const { bytes, name } = await this.files.readProjectFile(grant.projectPath, parts.join("/"));
      response.writeHead(200, {
        "Content-Type": CONTENT_TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": String(bytes.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        // 令牌在路径里：页面加载外部资源时不带出完整地址。
        "Referrer-Policy": "no-referrer",
      });
      response.end(head ? undefined : bytes);
    } catch (error) {
      if (error instanceof HttpError) return fail(error.status, error.publicMessage);
      logger.error("file-view", "页面预览读取失败", error);
      fail(500, "读取项目文件失败。");
    }
  }
}

/** 交给系统默认程序打开（.html 通常即默认浏览器），与在访达里双击同效；只确认命令已启动，不等待浏览器。 */
export async function openInSystemBrowser(absolute: string): Promise<void> {
  const command = SYSTEM_OPENERS[process.platform];
  if (!command) throw new HttpError(501, "当前系统不支持从 Council 打开浏览器，请手动打开该文件。");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [absolute], { detached: true, stdio: "ignore" });
    child.once("error", (error) => {
      logger.warn("file-view", "系统打开命令启动失败", error);
      reject(new HttpError(502, "无法调用系统浏览器打开该文件。"));
    });
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
