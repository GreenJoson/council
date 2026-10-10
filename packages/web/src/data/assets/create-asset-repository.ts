/**
 * @input  依赖：VITE_COUNCIL_DATA_MODE、VITE_COUNCIL_API_URL、VITE_COUNCIL_PROJECT_PATH、
 *         VITE_COUNCIL_ASSET_PAGE_SIZE（留空为 60）
 * @output 导出：当前环境对应的 AssetRepository
 * @pos    资产数据实现的集中式选择入口；desktop 模式经 Tauri 桥接读、经本地 Agent 服务写。
 *         mock 模式返回模块级单例，让资产页与任务产物区看到同一份内存数据（刷新页面即重置）
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { COUNCIL_API_MAX_PAGE_SIZE } from "../api-constants";
import { readIntegerConfig } from "../create-repository";
import { createDesktopBridge } from "../desktop-bridge";
import { readProjectPathConfig } from "../project-path";
import type { AssetRepository } from "./asset-repository";
import { DesktopAssetRepository } from "./desktop-asset-repository";
import { HttpAssetRepository } from "./http-asset-repository";
import { MockAssetRepository } from "./mock-asset-repository";

const DEFAULT_ASSET_PAGE_SIZE = 60;

let mockSingleton: MockAssetRepository | undefined;

function readAssetPageSize(): number {
  const raw = import.meta.env.VITE_COUNCIL_ASSET_PAGE_SIZE?.trim();
  return raw
    ? readIntegerConfig(raw, "VITE_COUNCIL_ASSET_PAGE_SIZE", 1, COUNCIL_API_MAX_PAGE_SIZE)
    : DEFAULT_ASSET_PAGE_SIZE;
}

export function createAssetRepository(): AssetRepository {
  const mode = import.meta.env.VITE_COUNCIL_DATA_MODE ?? "mock";
  const pageSize = readAssetPageSize();
  if (mode === "mock") {
    mockSingleton ??= new MockAssetRepository({ pageSize });
    return mockSingleton;
  }
  if (mode === "desktop") {
    // 项目路径与服务地址都只来自 Rust 设置层，不进入前端环境变量。
    return new DesktopAssetRepository({ bridge: createDesktopBridge(), pageSize });
  }
  if (mode !== "http") {
    throw new Error(`不支持的数据模式：${mode}，仅允许 mock、http 或 desktop`);
  }
  const baseUrl = import.meta.env.VITE_COUNCIL_API_URL?.trim();
  if (!baseUrl) {
    throw new Error("http 模式必须配置 VITE_COUNCIL_API_URL");
  }
  return new HttpAssetRepository({
    baseUrl,
    projectPath: readProjectPathConfig(import.meta.env.VITE_COUNCIL_PROJECT_PATH),
    pageSize,
  });
}
