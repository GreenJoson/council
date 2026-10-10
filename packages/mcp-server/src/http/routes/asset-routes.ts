/**
 * @input  依赖：HttpRouteContext（CouncilDatabase、HTTP 配置中的资产配置）、assets/AssetService、Zod schema 与统一响应
 * @output 导出：注册资产库 REST（列表、详情、原始内容、缩略图、项目内导入、链接增删、软删除）的 registerAssetRoutes
 * @pos    /api/v1/assets：资产字节只经这里出站，响应头固定 no-store/nosniff，SVG 额外加沙箱 CSP；
 *         入库拒绝原因按 AssetRejectedError 原因码映射为 403/404/413/415/507。写入沿用 council.changed
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import path from "node:path";
import type { Express, Response } from "express";
import { AssetRejectedError, assetRejectHttpStatus } from "../../assets/asset-errors.js";
import type { AssetPayload } from "../../assets/asset-preview.js";
import { AssetService } from "../../assets/asset-service.js";
import { loadAssetConfig } from "../../config.js";
import { HttpError, sendSuccess } from "../responses.js";
import {
  addAssetLinkBodySchema,
  assetLinkParamsSchema,
  assetParamsSchema,
  importAssetBodySchema,
  listAssetsQuerySchema,
} from "../schemas.js";
import { parse, type HttpRouteContext } from "./context.js";

const SVG_MIME = "image/svg+xml";

function sendPayload(response: Response, payload: AssetPayload): void {
  response.setHeader("Content-Type", payload.mime);
  response.setHeader("Content-Disposition", `inline; filename="${payload.filename}"`);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (payload.mime === SVG_MIME) {
    // SVG 可内嵌脚本：沙箱化并禁止脚本，即使被直接打开也不会在同源执行。
    response.setHeader("Content-Security-Policy", "sandbox; script-src 'none'");
  }
  response.status(200).end(payload.bytes);
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
  const assets = new AssetService(
    database,
    config.assets ?? loadAssetConfig({}, path.dirname(config.databasePath)),
  );

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
    sendSuccess(
      response,
      result.asset,
      result.deduplicated ? "项目中已有相同内容的资产。" : "资产已导入。",
      result.deduplicated ? 200 : 201,
    );
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
