/**
 * @input  依赖：VITE_COUNCIL_DATA_MODE、VITE_COUNCIL_API_URL、VITE_COUNCIL_PROJECT_PATH（不新增环境变量）
 * @output 导出：当前环境对应的 TaskRepository
 * @pos    任务数据实现的集中式选择入口；desktop 模式经 Tauri 桥接读、经本地 Agent 服务写。
 *         mock 模式返回模块级单例：任务存在实例内存里，会话流列表、编辑器派任务对话框与任务视图必须共用一份
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { createDesktopBridge } from "../desktop-bridge";
import { readProjectPathConfig } from "../project-path";
import { DesktopTaskRepository } from "./desktop-task-repository";
import { HttpTaskRepository } from "./http-task-repository";
import { MockTaskRepository } from "./mock-task-repository";
import type { TaskRepository } from "./task-repository";

let mockSingleton: MockTaskRepository | undefined;

export function createTaskRepository(): TaskRepository {
  const mode = import.meta.env.VITE_COUNCIL_DATA_MODE ?? "mock";
  if (mode === "mock") {
    mockSingleton ??= new MockTaskRepository();
    return mockSingleton;
  }
  if (mode === "desktop") {
    // 项目路径与服务地址都只来自 Rust 设置层，不进入前端环境变量。
    return new DesktopTaskRepository({ bridge: createDesktopBridge() });
  }
  if (mode !== "http") {
    throw new Error(`不支持的数据模式：${mode}，仅允许 mock、http 或 desktop`);
  }
  const baseUrl = import.meta.env.VITE_COUNCIL_API_URL?.trim();
  if (!baseUrl) {
    throw new Error("http 模式必须配置 VITE_COUNCIL_API_URL");
  }
  return new HttpTaskRepository({
    baseUrl,
    projectPath: readProjectPathConfig(import.meta.env.VITE_COUNCIL_PROJECT_PATH),
  });
}
