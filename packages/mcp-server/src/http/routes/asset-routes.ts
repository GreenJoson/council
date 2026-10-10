/**
 * @input  依赖：HttpRouteContext（CouncilDatabase、HTTP 配置中的资产配置）、assets/AssetService、Zod schema 与统一响应
 * @output 导出：注册资产库 REST（列表、详情、原始内容、缩略图、项目内导入、浏览器上传图片、本机图片入库、链接增删、软删除）的 registerAssetRoutes
 * @pos    /api/v1/assets：资产字节经 sendInlineBytes 出站（no-store/nosniff，SVG 沙箱 CSP）；
 *         upload 用路由级 raw 解析、上限与单文件配额一致，upload/ingest 只收 image 种类；
 *         入库拒绝原因按 AssetRejectedError 原因码映射为 403/404/413/415/507。写入沿用 council.changed
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import path from "node:path";
import express, { type Express, type Response } from "express";
import { AssetRejectedError, assetRejectHttpStatus } from "../../assets/asset-errors.js";
import type { IngestResult } from "../../assets/asset-ingest.js";
import type { AssetPayload } from "../../assets/asset-preview.js";
import { AssetService } from "../../assets/asset-service.js";
import { loadAssetConfig } from "../../config.js";
import { HttpError, sendInlineBytes, sendSuccess } from "../responses.js";
import {
  addAssetLinkBodySchema,
  assetLinkParamsSchema,
  assetParamsSchema,
  importAssetBodySchema,
  ingestAssetBodySchema,
  listAssetsQuerySchema,
  uploadAssetQuerySchema,
} from "../schemas.js";
import { parse, type HttpRouteContext } from "./context.js";

function sendPayload(response: Response, payload: AssetPayload): void {
  sendInlineBytes(response, payload);
}

/** 入库结果：命中去重返回 200 与既有资产，新建返回 201。 */
function sendIngestResult(response: Response, result: IngestResult, createdMessage: string): void {
  sendSuccess(
    response,
    result.asset,
    result.deduplicated ? "项目中已有相同内容的资产。" : createdMessage,
    result.deduplicated ? 200 : 201,
  );
}

/** 入库拒绝细化为具体状态码；其它错误交给统一错误中间件。 */
function rethrowAssetError(error: unknown): never {
  if (error instanceof AssetRejectedError) {
    throw new HttpError(assetRejectHttpStatus(error.reason), error.message);
  }
  throw error;
}

export function registerAssetRoutes(app: Express, context: HttpRouteContext): void {
  const { config, database } = context;
  // 测试夹具手工构造 HTTP 配置时没有 assets，按数据库所在目录回落到默认资产配置。
  const assetConfig = config.assets ?? loadAssetConfig({}, path.dirname(config.databasePath));
  const assets = new AssetService(database, assetConfig);

  app.get("/api/v1/assets", (request, response) => {
    const query = parse(listAssetsQuerySchema, request.query);
    sendSuccess(response, assets.list({
      projectPath: query.project,
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.target ? { target: query.target } : {}),
      ...(query.unlinked ? { unlinked: true } : {}),
      limit: query.limit,
      offset: query.offset,
    }));
  });

  app.post("/api/v1/assets/import", async (request, response) => {
    const input = parse(importAssetBodySchema, request.body);
    const result = await assets.importFromProject({
      projectPath: input.projectPath,
      relativePath: input.relativePath,
      actorId: "human",
    }).catch(rethrowAssetError);
    sendIngestResult(response, result, "资产已导入。");
  });

  // 浏览器上传（编辑器粘贴 / 文件选择）：正文是原始图片字节，全局 JSON 解析不会碰非 JSON 类型，
  // 这里按路由挂 raw 解析；超过单文件上限由 body-parser 直接 413。
  app.post(
    "/api/v1/assets/upload",
    express.raw({ type: () => true, limit: assetConfig.maxBytes }),
    async (request, response) => {
      const query = parse(uploadAssetQuerySchema, request.query);
      const bytes: unknown = request.body;
      if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) {
        throw new HttpError(400, "上传内容为空，请求正文应是图片文件字节。");
      }
      const result = await assets.ingestBytes({
        projectPath: query.project,
        bytes,
        origin: { actorId: "human" },
        acceptKinds: ["image"],
      }).catch(rethrowAssetError);
      sendIngestResult(response, result, "图片已加入资产库。");
    },
  );

  // 桌面壳：用户在原生选择器里选中的本机图片按绝对路径读入资产库，原文件不复制不移动。
  app.post("/api/v1/assets/ingest", async (request, response) => {
    const input = parse(ingestAssetBodySchema, request.body);
    const result = await assets.ingestFile({
      projectPath: input.projectPath,
      sourcePath: input.sourcePath,
      origin: { actorId: "human" },
      acceptKinds: ["image"],
    }).catch(rethrowAssetError);
    sendIngestResult(response, result, "图片已加入资产库。");
  });

  app.get("/api/v1/assets/:assetId", (request, response) => {
    const { assetId } = parse(assetParamsSchema, request.params);
    sendSuccess(response, assets.get(assetId));
  });

  app.get("/api/v1/assets/:assetId/content", async (request, response) => {
    const { assetId } = parse(assetParamsSchema, request.params);
    let payload: AssetPayload;
    try {
      payload = await assets.content(assetId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new HttpError(404, "资产文件已不在资产库中。");
      }
      throw error;
    }
    sendPayload(response, payload);
  });

  app.get("/api/v1/assets/:assetId/thumbnail", async (request, response) => {
    const { assetId } = parse(assetParamsSchema, request.params);
    const payload = await assets.thumbnail(assetId).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!payload) {
      throw new HttpError(404, "该资产没有可用的缩略图。");
    }
    sendPayload(response, payload);
  });

  app.post("/api/v1/assets/:assetId/links", (request, response) => {
    const { assetId } = parse(assetParamsSchema, request.params);
    const input = parse(addAssetLinkBodySchema, request.body);
    sendSuccess(response, assets.addLink(assetId, input.targetKind, input.targetId, input.role), "资产链接已添加。", 201);
  });

  app.delete("/api/v1/assets/:assetId/links/:targetKind/:targetId/:role", (request, response) => {
    const params = parse(assetLinkParamsSchema, request.params);
    assets.removeLink(params.assetId, params.targetKind, params.targetId, params.role);
    response.status(204).end();
  });

  app.delete("/api/v1/assets/:assetId", (request, response) => {
    const { assetId } = parse(assetParamsSchema, request.params);
    assets.softDelete(assetId);
    response.status(204).end();
  });
}
