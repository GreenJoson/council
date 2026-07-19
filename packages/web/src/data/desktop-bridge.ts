/**
 * @input  依赖：Tauri invoke、event 与原生目录对话框
 * @output 导出：可注入测试的 DesktopBridge 和设置类型
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
  getStatus(): Promise<unknown>;
  listenChanged(handler: (payload: unknown) => void): Promise<UnlistenFn>;
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

function parseSettings(value: unknown): DesktopSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("桌面设置响应必须是对象");
  }
  const record = value as Record<string, unknown>;
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
    getStatus: () => runtime.invoke("get_status"),
    listenChanged: (handler) => runtime.listen("council://changed", handler),
  };
}
