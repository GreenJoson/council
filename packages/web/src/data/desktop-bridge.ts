/**
 * @input  依赖：Tauri invoke、event 与原生目录对话框
 * @output 导出：可注入测试的 DesktopBridge（含实施项写入）、设置类型与本地 Agent 服务配置/健康解析
 * @pos    浏览器领域代码进入 Tauri IPC 的唯一低层边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

export interface DesktopSettings {
  logLibrary: string | null;
  currentProjectPath: string | null;
  recentProjectPaths: string[];
}

export interface DesktopOrchestrationConfig {
  baseUrl: string;
  autostartConfigured: boolean;
}

export interface DesktopOrchestrationHealth {
  baseUrl: string;
  reachable: boolean;
}

export interface DesktopRuntime {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn>;
  chooseDirectory(title: string): Promise<string | null>;
}

export interface DesktopBridge {
  getSettings(): Promise<DesktopSettings>;
  chooseLogLibrary(): Promise<DesktopSettings | undefined>;
  chooseProject(): Promise<DesktopSettings | undefined>;
  selectProject(path: string): Promise<DesktopSettings>;
  listTopics(args: Record<string, unknown>): Promise<unknown>;
  getTopic(args: Record<string, unknown>): Promise<unknown>;
  createTopic(args: Record<string, unknown>): Promise<unknown>;
  postMessage(args: Record<string, unknown>): Promise<unknown>;
  recordDecision(input: Record<string, unknown>): Promise<unknown>;
  addWorkItems(input: Record<string, unknown>): Promise<unknown>;
  updateWorkItem(input: Record<string, unknown>): Promise<unknown>;
  claimWorkItem(input: Record<string, unknown>): Promise<unknown>;
  getStatus(): Promise<unknown>;
  listenChanged(handler: (payload: unknown) => void): Promise<UnlistenFn>;
  getOrchestrationConfig(): Promise<DesktopOrchestrationConfig>;
  checkOrchestrationService(): Promise<DesktopOrchestrationHealth>;
  startOrchestrationService(): Promise<void>;
}

async function tauriListen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  return listen<T>(event, (message) => handler(message.payload));
}

const tauriRuntime: DesktopRuntime = {
  invoke: (command, args) => invoke(command, args),
  listen: tauriListen,
  chooseDirectory: async (title) => {
    const selected = await open({ directory: true, multiple: false, title });
    return typeof selected === "string" ? selected : null;
  },
};

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name}必须是对象`);
  }
  return value as Record<string, unknown>;
}

/** 校验本地 Agent 服务地址：必须是 http/https 绝对 URL；供仓储与测试直接复用。 */
export function parseOrchestrationBaseUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("编排服务地址必须是非空字符串");
  }
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("编排服务地址必须是有效的绝对 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("编排服务地址只允许 http 或 https 协议");
  }
  return trimmed;
}

function parseBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${name} 必须是布尔值`);
  }
  return value;
}

export function parseOrchestrationConfig(value: unknown): DesktopOrchestrationConfig {
  const record = asRecord(value, "编排服务配置响应");
  return {
    baseUrl: parseOrchestrationBaseUrl(record.baseUrl),
    autostartConfigured: parseBoolean(record.autostartConfigured, "autostartConfigured"),
  };
}

export function parseOrchestrationHealth(value: unknown): DesktopOrchestrationHealth {
  const record = asRecord(value, "编排服务健康响应");
  return {
    baseUrl: parseOrchestrationBaseUrl(record.baseUrl),
    reachable: parseBoolean(record.reachable, "reachable"),
  };
}

function parseSettings(value: unknown): DesktopSettings {
  const record = asRecord(value, "桌面设置响应");
  const parsePath = (key: string): string | null => {
    const path = record[key];
    if (path === null || path === undefined) {
      return null;
    }
    if (typeof path !== "string" || !path.trim()) {
      throw new Error(`${key} 必须是有效路径`);
    }
    return path;
  };
  const recent = record.recentProjectPaths;
  if (!Array.isArray(recent) || !recent.every((path) => typeof path === "string" && path.trim())) {
    throw new Error("recentProjectPaths 必须是路径数组");
  }
  return {
    logLibrary: parsePath("logLibrary"),
    currentProjectPath: parsePath("currentProjectPath"),
    recentProjectPaths: [...recent],
  };
}

export function createDesktopBridge(runtime: DesktopRuntime = tauriRuntime): DesktopBridge {
  const invokeSettings = async (
    command: string,
    args?: Record<string, unknown>,
  ): Promise<DesktopSettings> => parseSettings(await runtime.invoke(command, args));

  return {
    getSettings: () => invokeSettings("get_desktop_settings"),
    chooseLogLibrary: async () => {
      const path = await runtime.chooseDirectory("选择 Council 日志库");
      return path ? invokeSettings("configure_log_library", { path }) : undefined;
    },
    chooseProject: async () => {
      const path = await runtime.chooseDirectory("选择项目目录");
      return path ? invokeSettings("select_project", { path }) : undefined;
    },
    selectProject: (path) => invokeSettings("select_project", { path }),
    listTopics: (args) => runtime.invoke("list_topics", args),
    getTopic: (args) => runtime.invoke("get_topic", args),
    createTopic: (args) => runtime.invoke("create_topic", args),
    postMessage: (args) => runtime.invoke("post_message", args),
    recordDecision: (input) => runtime.invoke("record_decision", { input }),
    addWorkItems: (input) => runtime.invoke("add_work_items", { input }),
    updateWorkItem: (input) => runtime.invoke("update_work_item", { input }),
    claimWorkItem: (input) => runtime.invoke("claim_work_item", { input }),
    getStatus: () => runtime.invoke("get_status"),
    listenChanged: (handler) => runtime.listen("council://changed", handler),
    getOrchestrationConfig: async () =>
      parseOrchestrationConfig(await runtime.invoke("get_orchestration_config")),
    checkOrchestrationService: async () =>
      parseOrchestrationHealth(await runtime.invoke("check_orchestration_service")),
    startOrchestrationService: async () => {
      await runtime.invoke("start_orchestration_service");
    },
  };
}
