/**
 * @input  依赖：VITE_COUNCIL_DATA_MODE、VITE_COUNCIL_API_URL、VITE_COUNCIL_PROJECT_PATH（不新增环境变量）
 * @output 导出：当前环境对应的 PipelineRepository
 * @pos    流水线数据实现的集中式选择入口；desktop 模式全部经本地 Agent 服务 HTTP（Tauri 无流水线命令）。
 *         mock 模式返回模块级单例：状态机定时器挂在实例上，切换项目/视图重挂载时不丢进度（刷新页面即重置）
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { createDesktopBridge } from "../desktop-bridge";
import { readProjectPathConfig } from "../project-path";
import { DesktopPipelineRepository } from "./desktop-pipeline-repository";
import { HttpPipelineRepository } from "./http-pipeline-repository";
import { MockPipelineRepository } from "./mock-pipeline-repository";
import type { PipelineRepository } from "./pipeline-repository";

let mockSingleton: MockPipelineRepository | undefined;

export function createPipelineRepository(): PipelineRepository {
  const mode = import.meta.env.VITE_COUNCIL_DATA_MODE ?? "mock";
  if (mode === "mock") {
    mockSingleton ??= new MockPipelineRepository();
    return mockSingleton;
  }
  if (mode === "desktop") {
    // 项目路径与服务地址都只来自 Rust 设置层，不进入前端环境变量。
    return new DesktopPipelineRepository({ bridge: createDesktopBridge() });
  }
  if (mode !== "http") {
    throw new Error(`不支持的数据模式：${mode}，仅允许 mock、http 或 desktop`);
  }
  const baseUrl = import.meta.env.VITE_COUNCIL_API_URL?.trim();
  if (!baseUrl) {
    throw new Error("http 模式必须配置 VITE_COUNCIL_API_URL");
  }
  return new HttpPipelineRepository({
    baseUrl,
    projectPath: readProjectPathConfig(import.meta.env.VITE_COUNCIL_PROJECT_PATH),
  });
}
