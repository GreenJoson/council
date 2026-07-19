/**
 * @input  依赖：可注入 DesktopRuntime 与目录选择结果
 * @output 导出：设置解析、取消语义和命令 payload 回归测试
 * @pos    Tauri 全局不可用的 Vitest 环境中验证 IPC 低层边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { describe, expect, it, vi } from "vitest";
import { createDesktopBridge, type DesktopRuntime } from "../src/data/desktop-bridge";

function runtime(selected: string | null): DesktopRuntime {
  return {
    invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "get_desktop_settings") {
        return { logLibrary: null, currentProjectPath: null, recentProjectPaths: [] };
      }
      return {
        logLibrary: command === "configure_log_library" ? args?.path : "/logs",
        currentProjectPath: command === "select_project" ? args?.path : null,
        recentProjectPaths: command === "select_project" ? [args?.path] : [],
      };
    }) as DesktopRuntime["invoke"],
    listen: vi.fn(async () => () => undefined) as DesktopRuntime["listen"],
    chooseDirectory: vi.fn(async () => selected),
  };
}

describe("DesktopBridge", () => {
  it("取消目录选择不会覆盖设置或调用写命令", async () => {
    const injected = runtime(null);
    const bridge = createDesktopBridge(injected);
    await expect(bridge.chooseLogLibrary()).resolves.toBeUndefined();
    expect(injected.invoke).not.toHaveBeenCalled();
  });

  it("用 path payload 配置日志库并严格解析返回值", async () => {
    const injected = runtime("/logs");
    const bridge = createDesktopBridge(injected);
    await expect(bridge.chooseLogLibrary()).resolves.toMatchObject({ logLibrary: "/logs" });
    expect(injected.invoke).toHaveBeenCalledWith("configure_log_library", { path: "/logs" });
  });

  it("拒绝非法设置响应", async () => {
    const injected = runtime(null);
    injected.invoke = vi.fn(async () => ({ recentProjectPaths: [1] })) as DesktopRuntime["invoke"];
    await expect(createDesktopBridge(injected).getSettings()).rejects.toThrow(/recentProjectPaths/);
  });
});
