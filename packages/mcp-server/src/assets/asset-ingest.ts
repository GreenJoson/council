/**
 * @input  依赖：CouncilDatabase（资产查重/新建/恢复）、AssetStorage（落盘与配额）、asset-sniff（MIME 与宽高）、
 *         project-path / project-path-policy（项目锚点规范化与敏感路径判定）
 * @output 导出：AssetIngestor（ingestFile 本机文件入库、ingestBytes 内存字节入库、importFromProject 项目内相对路径导入）、
 *         IngestFileInput、IngestBytesInput、IngestResult
 * @pos    资产入库的唯一入口：图像委派（C）收集产物、REST/MCP 导入、编辑器上传/粘贴图片都走这里，拒绝规则只有一份。
 *         拒绝符号链接与非普通文件，以文件头嗅探 MIME（不信扩展名），校验白名单、单文件与总配额；
 *         同项目同 sha256 只保留一行，命中时返回既有资产（软删除则恢复）。错误文案不含绝对路径
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { MAX_ASSET_PROMPT_CHARS } from "../constants.js";
import type { CouncilDatabase } from "../database.js";
import { CouncilValidationError } from "../errors.js";
import { normalizeProjectPath } from "../project-path.js";
import { isProtectedProjectRelativePath } from "../project-path-policy.js";
import type { Asset, AssetKind } from "../types.js";
import { AssetRejectedError } from "./asset-errors.js";
import { assetKindForMime, readImageDimensions, sniffAssetMime } from "./asset-sniff.js";
import type { AssetStorage } from "./asset-storage.js";

export interface IngestBytesInput {
  /** 资产所属项目（绝对路径），与 work_items.project_path 同一锚点。 */
  projectPath: string;
  /** 文件完整字节；调用方（HTTP raw body 上限 / 本机读取上限）已限定过大小。 */
  bytes: Uint8Array;
  origin: { delegationId?: string; actorId?: string };
  /** 已脱敏的生成提示词；超长部分截断。 */
  prompt?: string;
  /** 限定允许的资产种类（编辑器引用图片时只收 image）；不传则接受整个 MIME 白名单。 */
  acceptKinds?: readonly AssetKind[];
}

export interface IngestFileInput extends Omit<IngestBytesInput, "bytes"> {
  /** 待入库文件的绝对路径；末级不得是符号链接。 */
  sourcePath: string;
}

export interface IngestResult {
  asset: Asset;
  /** true：同项目已有同 sha256 资产（含软删除后恢复），本次没有新建行。 */
  deduplicated: boolean;
}

function within(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/u.test(error.message);
}

export class AssetIngestor {
  constructor(
    private readonly database: CouncilDatabase,
    private readonly storage: AssetStorage,
  ) {}

  /** 读入完整字节：O_NOFOLLOW 防末级链接替换，O_NONBLOCK 防 FIFO 挂起，打开后再核对 inode。 */
  async #readRegularFile(sourcePath: string): Promise<Buffer> {
    const maxBytes = this.storage.config.maxBytes;
    let info;
    try {
      info = await lstat(sourcePath);
    } catch {
      throw new AssetRejectedError("not_found", "待导入文件不存在或不可读取。");
    }
    if (info.isSymbolicLink()) {
      throw new AssetRejectedError("symlink", "拒绝导入符号链接。");
    }
    if (!info.isFile()) {
      throw new AssetRejectedError("not_file", "待导入目标不是普通文件。");
    }
    if (info.size > maxBytes) {
      throw new AssetRejectedError("too_large", `文件超过单个资产大小上限（${maxBytes} 字节）。`);
    }
    let handle;
    try {
      handle = await open(sourcePath, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new AssetRejectedError("symlink", "拒绝导入符号链接。");
      }
      throw new AssetRejectedError("not_found", "待导入文件不存在或不可读取。");
    }
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) {
        throw new AssetRejectedError("symlink", "待导入文件在校验期间被替换，已拒绝。");
      }
      const buffer = Buffer.alloc(Math.min(opened.size, maxBytes) + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset > maxBytes) {
        throw new AssetRejectedError("too_large", `文件超过单个资产大小上限（${maxBytes} 字节）。`);
      }
      return buffer.subarray(0, offset);
    } finally {
      await handle.close();
    }
  }

  async ingestFile(input: IngestFileInput): Promise<IngestResult> {
    const projectPath = normalizeProjectPath(input.projectPath);
    if (!projectPath) {
      throw new CouncilValidationError("资产必须归属一个项目目录。");
    }
    if (!path.isAbsolute(input.sourcePath)) {
      throw new CouncilValidationError("待导入文件路径必须是绝对路径。");
    }
    const { sourcePath, ...rest } = input;
    const bytes = await this.#readRegularFile(sourcePath);
    return this.ingestBytes({ ...rest, projectPath, bytes });
  }

  /**
   * 内存字节入库：本机文件读取与浏览器上传（粘贴 / 文件选择器）共用的后半段。
   * 嗅探 MIME → 白名单与种类限定 → 同项目同内容去重（软删除则恢复）→ 配额 → 落盘 → 插入。
   */
  async ingestBytes(input: IngestBytesInput): Promise<IngestResult> {
    const projectPath = normalizeProjectPath(input.projectPath);
    if (!projectPath) {
      throw new CouncilValidationError("资产必须归属一个项目目录。");
    }
    const { bytes } = input;
    const mime = sniffAssetMime(bytes);
    if (!mime || !this.storage.config.mimeAllowlist.includes(mime)) {
      throw new AssetRejectedError(
        "unsupported_type",
        `文件内容不是允许的资产类型（允许：${this.storage.config.mimeAllowlist.join(", ")}）。`,
      );
    }
    if (input.acceptKinds && !input.acceptKinds.includes(assetKindForMime(mime))) {
      throw new AssetRejectedError(
        "unsupported_type",
        `当前文件类型 ${mime} 不属于本次允许的资产种类（${input.acceptKinds.join("、")}）。`,
      );
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    const existing = this.database.findAssetByContent(projectPath, sha256);
    if (existing) {
      if (existing.asset.deletedAt) {
        // 恢复等于重新占用配额。
        this.storage.assertQuota(existing.asset.byteSize);
      }
      // 文件可能被手工清理过：内容寻址，按需补写即可。
      await this.storage.write(sha256, existing.asset.mime, bytes);
      const asset = existing.asset.deletedAt ? this.database.restoreAsset(existing.asset.id) : existing.asset;
      return { asset, deduplicated: true };
    }

    this.storage.assertQuota(bytes.byteLength);
    const storageRelPath = await this.storage.write(sha256, mime, bytes);
    const dimensions = readImageDimensions(mime, bytes);
    const prompt = input.prompt?.trim() ? input.prompt.trim().slice(0, MAX_ASSET_PROMPT_CHARS) : undefined;
    try {
      const asset = this.database.insertAsset({
        projectPath,
        kind: assetKindForMime(mime),
        mime,
        byteSize: bytes.byteLength,
        sha256,
        storageRelPath,
        ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
        ...(input.origin.delegationId ? { delegationId: input.origin.delegationId } : {}),
        ...(input.origin.actorId ? { actorId: input.origin.actorId } : {}),
        ...(prompt ? { prompt } : {}),
      });
      return { asset, deduplicated: false };
    } catch (error) {
      // stdio MCP 与 HTTP 两个进程并发导入同一内容：输方读回赢方的行。
      if (isUniqueViolation(error)) {
        const winner = this.database.findAssetByContent(projectPath, sha256);
        if (winner) return { asset: winner.asset, deduplicated: true };
      }
      throw error;
    }
  }

  /**
   * 从项目目录按相对路径导入：先做词法越界与敏感路径判定，再用 realpath 复核真实落点，
   * 中间目录的符号链接也不能把目标带出项目或带进受保护目录。
   */
  async importFromProject(input: { projectPath: string; relativePath: string; actorId?: string }): Promise<IngestResult> {
    const projectPath = normalizeProjectPath(input.projectPath);
    if (!projectPath) {
      throw new CouncilValidationError("资产必须归属一个项目目录。");
    }
    const relative = input.relativePath.trim();
    if (!relative || path.isAbsolute(relative) || relative.includes("\0")) {
      throw new AssetRejectedError("outside_project", "relativePath 必须是项目内的相对路径。");
    }
    let root: string;
    try {
      root = await realpath(projectPath);
    } catch {
      throw new CouncilValidationError("项目路径不存在或不可读取。");
    }
    const requested = path.resolve(root, relative);
    if (!within(root, requested) || requested === root) {
      throw new AssetRejectedError("outside_project", "该文件位于项目之外，拒绝导入。");
    }
    if (isProtectedProjectRelativePath(path.relative(root, requested))) {
      throw new AssetRejectedError("protected_path", "该文件属于受保护路径，拒绝导入。");
    }
    const linkInfo = await lstat(requested).catch(() => undefined);
    if (!linkInfo) {
      throw new AssetRejectedError("not_found", "项目文件不存在或不可读取。");
    }
    if (linkInfo.isSymbolicLink()) {
      throw new AssetRejectedError("symlink", "拒绝导入符号链接。");
    }
    let real: string;
    try {
      real = await realpath(requested);
    } catch {
      throw new AssetRejectedError("not_found", "项目文件不存在或不可读取。");
    }
    if (!within(root, real)) {
      throw new AssetRejectedError("outside_project", "该文件位于项目之外，拒绝导入。");
    }
    if (isProtectedProjectRelativePath(path.relative(root, real))) {
      throw new AssetRejectedError("protected_path", "该文件属于受保护路径，拒绝导入。");
    }
    return this.ingestFile({
      projectPath,
      sourcePath: real,
      origin: input.actorId ? { actorId: input.actorId } : {},
    });
  }
}
