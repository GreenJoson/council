/**
 * @input  依赖：McpToolContext、Zod、资产常量、assets/AssetService、config.ts 的 loadAssetConfig 与 tool-support 共享件
 * @output 导出：registerAssetTools，注册 council_list_assets / council_get_asset / council_import_asset / council_attach_asset
 * @pos    资产库的 MCP 工具模块：stdio 进程直连数据库（与任务工具同模式），输出不含任何路径；
 *         导入以调用者 Actor 记作来源，拒绝规则与 REST 共用 assets/asset-ingest.ts
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import path from "node:path";
import { z } from "zod/v4";
import { AssetService } from "../../assets/asset-service.js";
import { loadAssetConfig } from "../../config.js";
import { CouncilValidationError } from "../../errors.js";
import {
  ASSET_KINDS,
  ASSET_LINK_ROLES,
  ASSET_LINK_TARGET_KINDS,
  DEFAULT_ASSET_PAGE_LIMIT,
  MAX_ASSET_PAGE_LIMIT,
  MAX_ID_CHARS,
  MAX_PATH_CHARS,
} from "../../constants.js";
import type { Asset } from "../../types.js";
import type { McpToolContext } from "../tool-context.js";
import { executeTool, success } from "../tool-support.js";

const assetIdField = z
  .string()
  .max(MAX_ID_CHARS)
  .regex(/^asset_[A-Za-z0-9-]+$/, "asset_id 格式无效")
  .describe("资产 ID（asset_<uuid>）");
const projectPathField = z
  .string()
  .min(1)
  .max(MAX_PATH_CHARS)
  .refine((value) => path.isAbsolute(value), "project_path 必须是绝对路径")
  .describe("项目根目录的绝对路径");
const targetIdField = z
  .string()
  .min(1)
  .max(MAX_ID_CHARS)
  .regex(/^[A-Za-z0-9_-]+$/, "target_id 格式无效");

const assetOutput = z.object({
  id: z.string(),
  kind: z.enum(ASSET_KINDS),
  mime: z.string(),
  byteSize: z.number(),
  sha256: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  prompt: z.string().optional(),
  origin: z.object({ delegationId: z.string().optional(), actorId: z.string().optional() }),
  createdAt: z.string(),
  deletedAt: z.string().optional(),
  links: z.array(z.object({
    targetKind: z.enum(ASSET_LINK_TARGET_KINDS),
    targetId: z.string(),
    role: z.enum(ASSET_LINK_ROLES),
    createdAt: z.string(),
  })),
});

function formatAsset(asset: Asset): string {
  const size = asset.width && asset.height ? ` ${asset.width}×${asset.height}` : "";
  const links = asset.links.length > 0
    ? ` 链接：${asset.links.map((link) => `${link.targetKind}:${link.targetId}(${link.role})`).join(", ")}`
    : "";
  return `- ${asset.id} [${asset.kind}] ${asset.mime}${size} ${asset.byteSize} 字节${links}`;
}

export function registerAssetTools(context: McpToolContext): void {
  const { server, database, caller, config } = context;
  // loadConfig 总会给出 assets；手工构造配置时按数据目录回落默认值。
  const assets = new AssetService(database, config.assets ?? loadAssetConfig({}, config.dataDir));

  server.registerTool(
    "council_list_assets",
    {
      title: "按项目查看资产",
      description:
        "列出某个项目资产库中的资产（新到旧，不含已删除），可按类型或链接目标（任务/消息/决策）过滤，"
        + "unlinked=true 只看未挂任何目标的资产。"
        + "结果只含元数据，图像字节请在 Council 界面查看。",
      inputSchema: {
        project_path: projectPathField,
        kind: z.enum(ASSET_KINDS).optional(),
        target_kind: z.enum(ASSET_LINK_TARGET_KINDS).optional(),
        target_id: targetIdField.optional(),
        unlinked: z.boolean().optional().describe("只看未挂任何目标的资产"),
        limit: z.number().int().min(1).max(MAX_ASSET_PAGE_LIMIT).optional(),
        offset: z.number().int().min(0).optional(),
      },
      outputSchema: {
        items: z.array(assetOutput),
        total: z.number(),
        count: z.number(),
        offset: z.number(),
        hasMore: z.boolean(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project_path, kind, target_kind, target_id, unlinked, limit, offset }) =>
      await executeTool("council_list_assets", () => {
        if ((target_kind === undefined) !== (target_id === undefined)) {
          throw new CouncilValidationError("资产过滤条件 target_kind 与 target_id 必须同时提供。");
        }
        if (unlinked && target_kind) {
          throw new CouncilValidationError("unlinked 与 target 过滤不能同时使用。");
        }
        const page = assets.list({
          projectPath: project_path,
          ...(kind ? { kind } : {}),
          ...(target_kind && target_id ? { target: { kind: target_kind, id: target_id } } : {}),
          ...(unlinked ? { unlinked: true } : {}),
          limit: limit ?? DEFAULT_ASSET_PAGE_LIMIT,
          offset: offset ?? 0,
        });
        const text = page.items.length > 0
          ? [`共 ${page.total} 个资产，本页 ${page.count} 个。`, ...page.items.map(formatAsset)].join("\n")
          : "该项目没有匹配的资产。";
        return success(text, page);
      }),
  );

  server.registerTool(
    "council_get_asset",
    {
      title: "查看资产详情",
      description: "读取一个资产的元数据与链接（任务/消息/决策）。已删除的资产视为不存在。",
      inputSchema: { asset_id: assetIdField },
      outputSchema: { asset: assetOutput },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ asset_id }) =>
      await executeTool("council_get_asset", () => {
        const asset = assets.get(asset_id);
        return success(formatAsset(asset), { asset });
      }),
  );

  server.registerTool(
    "council_import_asset",
    {
      title: "从项目导入资产",
      description:
        "把项目目录内的一个文件导入资产库。relative_path 相对项目根目录，不能越出项目、不能是符号链接或敏感文件；"
        + "类型按文件内容识别（PNG/JPEG/WebP/GIF/SVG/glb/PDF 中的允许项），同项目同内容只保留一份。",
      inputSchema: {
        project_path: projectPathField,
        relative_path: z.string().min(1).max(MAX_PATH_CHARS).describe("相对项目根目录的文件路径"),
      },
      outputSchema: { asset: assetOutput, deduplicated: z.boolean() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project_path, relative_path }) =>
      await executeTool("council_import_asset", async () => {
        const result = await assets.importFromProject({
          projectPath: project_path,
          relativePath: relative_path,
          actorId: caller.actorId,
        });
        return success(
          [result.deduplicated ? "项目中已有相同内容的资产。" : "资产已导入。", formatAsset(result.asset)].join("\n"),
          result,
        );
      }),
  );

  server.registerTool(
    "council_attach_asset",
    {
      title: "把资产挂到任务/消息/决策",
      description:
        "为资产添加一条链接：target_kind 为 work_item/message/decision，role 为 reference/output/final/brief。"
        + "目标必须存在且与资产属于同一项目；重复添加同一链接是幂等的。",
      inputSchema: {
        asset_id: assetIdField,
        target_kind: z.enum(ASSET_LINK_TARGET_KINDS),
        target_id: targetIdField,
        role: z.enum(ASSET_LINK_ROLES),
      },
      outputSchema: { asset: assetOutput },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ asset_id, target_kind, target_id, role }) =>
      await executeTool("council_attach_asset", () => {
        const asset = assets.addLink(asset_id, target_kind, target_id, role);
        return success(["资产链接已添加。", formatAsset(asset)].join("\n"), { asset });
      }),
  );
}
