/**
 * @input  依赖：AssetConfig（根目录、单文件/总配额）、CouncilDatabase 的未删除字节总量
 * @output 导出：AssetStorage（内容寻址写入、按相对路径读取、缩略图缓存路径、配额检查）与 assetExtension（MIME → 扩展名）
 * @pos    资产字节的唯一落盘所有者：布局 <asset-root>/<sha256 前 2 位>/<sha256>.<ext>，
 *         缩略图缓存 <asset-root>/thumbnails/<sha256>.png；先写同目录临时文件再 rename，进程崩溃不留半截文件。
 *         存储相对路径只在仓储内部流转，绝不进入公开 DTO 或日志
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CouncilDatabase } from "../database.js";
import type { AssetConfig } from "../types.js";
import { AssetRejectedError } from "./asset-errors.js";

// 扩展名由嗅探出的 MIME 决定，不沿用源文件扩展名（源扩展名可能是伪造的）。
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "model/gltf-binary": "glb",
  "application/pdf": "pdf",
};

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export function assetExtension(mime: string): string {
  const extension = EXTENSIONS[mime];
  if (!extension) {
    throw new AssetRejectedError("unsupported_type", `不支持的资产类型 ${mime}。`);
  }
  return extension;
}

export class AssetStorage {
  constructor(
    readonly config: AssetConfig,
    private readonly database: CouncilDatabase,
  ) {}

  /** 新增 incomingBytes 后是否超过总配额；按未删除行的 byte_size 求和。 */
  assertQuota(incomingBytes: number): void {
    if (this.database.totalActiveAssetBytes() + incomingBytes > this.config.maxTotalBytes) {
      throw new AssetRejectedError("quota_exceeded", "资产库总容量已达上限，请先删除不再需要的资产。");
    }
  }

  relativePathFor(sha256: string, mime: string): string {
    if (!SHA256_PATTERN.test(sha256)) {
      throw new Error("资产内容摘要格式无效。");
    }
    // 相对路径统一用 "/"，与平台分隔符解耦，Rust 侧也不读取它。
    return `${sha256.slice(0, 2)}/${sha256}.${assetExtension(mime)}`;
  }

  #absolute(relativePath: string): string {
    const absolute = path.resolve(this.config.rootDir, ...relativePath.split("/"));
    const rel = path.relative(this.config.rootDir, absolute);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("资产存储路径越出资产根目录。");
    }
    return absolute;
  }

  /** 内容寻址：目标已存在且大小一致视为同一内容，直接复用。 */
  async write(sha256: string, mime: string, bytes: Uint8Array): Promise<string> {
    const relativePath = this.relativePathFor(sha256, mime);
    const target = this.#absolute(relativePath);
    const existing = await stat(target).catch(() => undefined);
    if (existing?.isFile() && existing.size === bytes.byteLength) {
      return relativePath;
    }
    await this.#atomicWrite(target, bytes);
    return relativePath;
  }

  async read(relativePath: string): Promise<Buffer> {
    return readFile(this.#absolute(relativePath));
  }

  /** 供缩略图命令读取原图；返回值只在本进程内传给子进程，不出协议边界。 */
  absolutePath(relativePath: string): string {
    return this.#absolute(relativePath);
  }

  thumbnailRelativePath(sha256: string): string {
    if (!SHA256_PATTERN.test(sha256)) {
      throw new Error("资产内容摘要格式无效。");
    }
    return `thumbnails/${sha256}.png`;
  }

  async readThumbnail(sha256: string): Promise<Buffer | undefined> {
    try {
      return await readFile(this.#absolute(this.thumbnailRelativePath(sha256)));
    } catch {
      return undefined;
    }
  }

  /** 缩略图生成命令写到临时路径，校验后由这里原子挪进缓存。 */
  async thumbnailScratch(sha256: string): Promise<{ scratch: string; commit: () => Promise<void>; discard: () => Promise<void> }> {
    const target = this.#absolute(this.thumbnailRelativePath(sha256));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const scratch = path.join(path.dirname(target), `.${sha256}.${randomUUID()}.tmp.png`);
    return {
      scratch,
      commit: () => rename(scratch, target),
      discard: () => rm(scratch, { force: true }),
    };
  }

  async #atomicWrite(target: string, bytes: Uint8Array): Promise<void> {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}
