/**
 * @input  依赖：AssetStorage（原图与缩略图缓存）、AssetConfig 的缩略图命令/最长边/超时、process-utils 有界子进程
 * @output 导出：AssetPreviewer（content 原始字节、thumbnail 缩略图）与 AssetPayload
 * @pos    资产字节的只读出口：content 原样返回库中 MIME；thumbnail 位图走外部命令（sips 兼容参数）生成 PNG 并缓存，
 *         SVG 直接返回原文，非图像与生成失败返回 undefined（路由映射 404）。日志不含路径
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { readFile, stat } from "node:fs/promises";
import { logger } from "../logger.js";
import { runBoundedProcess } from "../process-utils.js";
import type { AssetStorageRecord } from "../database/asset-repository.js";
import { assetExtension, type AssetStorage } from "./asset-storage.js";
import { readImageDimensions } from "./asset-sniff.js";

export interface AssetPayload {
  mime: string;
  /** Content-Disposition 用的文件名：<assetId>.<ext>，不暴露原始文件名。 */
  filename: string;
  bytes: Buffer;
}

// 缩略图命令只产出文件，stdout/stderr 只用于判断失败，保留很小的窗口即可。
const THUMBNAIL_OUTPUT_CHARS = 16_384;
const THUMBNAIL_KILL_GRACE_MS = 1_000;
const RASTER_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export class AssetPreviewer {
  // 同一 sha 的并发缩略图请求合并为一次子进程。
  readonly #pending = new Map<string, Promise<Buffer | undefined>>();

  constructor(private readonly storage: AssetStorage) {}

  async content(record: AssetStorageRecord): Promise<AssetPayload> {
    const { asset } = record;
    return {
      mime: asset.mime,
      filename: `${asset.id}.${assetExtension(asset.mime)}`,
      bytes: await this.storage.read(record.storageRelPath),
    };
  }

  async thumbnail(record: AssetStorageRecord): Promise<AssetPayload | undefined> {
    const { asset } = record;
    if (asset.mime === "image/svg+xml") {
      return this.content(record);
    }
    if (!RASTER_MIMES.has(asset.mime)) {
      return undefined;
    }
    const cached = await this.storage.readThumbnail(asset.sha256);
    const bytes = cached ?? await this.#generateOnce(record);
    return bytes ? { mime: "image/png", filename: `${asset.id}.thumbnail.png`, bytes } : undefined;
  }

  #generateOnce(record: AssetStorageRecord): Promise<Buffer | undefined> {
    const key = record.asset.sha256;
    const inflight = this.#pending.get(key);
    if (inflight) return inflight;
    const task = this.#generate(record).finally(() => this.#pending.delete(key));
    this.#pending.set(key, task);
    return task;
  }

  async #generate(record: AssetStorageRecord): Promise<Buffer | undefined> {
    const { asset } = record;
    const { thumbnailCommand, thumbnailMaxEdge, thumbnailTimeoutMs } = this.storage.config;
    const fitsAlready = asset.width !== undefined && asset.height !== undefined
      && Math.max(asset.width, asset.height) <= thumbnailMaxEdge;
    if (fitsAlready && asset.mime === "image/png") {
      // 已经够小的 PNG 不必转码，直接作为缩略图。
      return this.storage.read(record.storageRelPath);
    }
    const source = this.storage.absolutePath(record.storageRelPath);
    const { scratch, commit, discard } = await this.storage.thumbnailScratch(asset.sha256);
    // sips 的 -Z 会放大小图，已经够小时只做格式转换。
    const args = fitsAlready
      ? ["-s", "format", "png", source, "--out", scratch]
      : ["-s", "format", "png", "-Z", String(thumbnailMaxEdge), source, "--out", scratch];
    try {
      const result = await runBoundedProcess({
        command: thumbnailCommand,
        args,
        input: "",
        timeoutMs: thumbnailTimeoutMs,
        killGraceMs: THUMBNAIL_KILL_GRACE_MS,
        maxOutputChars: THUMBNAIL_OUTPUT_CHARS,
        messages: {
          aborted: "缩略图生成已取消。",
          timeout: "缩略图生成超时。",
          outputLimit: "缩略图命令输出超限。",
          commandNotFound: "缩略图命令不可用。",
          spawnFailed: "缩略图命令启动失败。",
        },
      });
      const produced = await stat(scratch).catch(() => undefined);
      if (result.exitCode !== 0 || !produced?.isFile() || produced.size === 0) {
        logger.warn("assets", `资产 ${asset.id} 缩略图生成失败（退出码 ${String(result.exitCode)}）。`);
        await discard();
        return undefined;
      }
      const bytes = await readFile(scratch);
      // 只缓存确实是 PNG 且尺寸不超限的产物，命令行为异常时宁可 404。
      const dimensions = readImageDimensions("image/png", bytes);
      if (!dimensions || Math.max(dimensions.width, dimensions.height) > thumbnailMaxEdge) {
        logger.warn("assets", `资产 ${asset.id} 缩略图产物无效，已丢弃。`);
        await discard();
        return undefined;
      }
      await commit();
      return bytes;
    } catch (error) {
      logger.warn("assets", `资产 ${asset.id} 缩略图生成失败。`, error instanceof Error ? error.message : undefined);
      await discard();
      return undefined;
    }
  }
}
