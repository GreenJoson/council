/**
 * @input  依赖：React、桌面原生仓储（Tauri）、DesktopSettings、错误文案归一化
 * @output 导出：useDesktopSettings —— 桌面日志库/当前项目设置、加载与忙碌状态，以及选库、选项目、切换最近项目动作
 * @pos    App 壳的桌面设置控制器；非桌面（HTTP/mock）时恒为已加载且无设置。
 *         项目或日志库切换成功后通过 onWorkspaceReset 让内容控制器清空并重载工作区
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { useEffect, useState } from "react";
import type { DesktopSettings } from "../data/desktop-bridge";
import { getErrorMessage } from "../data/error-message";
import type { NativeCouncilRepository } from "../data/native-repository";

export type DesktopBusyAction = "logs" | "project";

export interface DesktopSettingsController {
  settings: DesktopSettings | null;
  setSettings: (settings: DesktopSettings) => void;
  loaded: boolean;
  /** 桌面模式下日志库和项目都已选定，可以加载工作区 */
  ready: boolean;
  busyAction: DesktopBusyAction | null;
  errorMessage: string | null;
  choose: (action: DesktopBusyAction, options?: { keepWorkspace?: boolean }) => Promise<void>;
  selectRecentProject: (path: string) => Promise<void>;
}

export function useDesktopSettings(
  nativeRepository: NativeCouncilRepository | undefined,
  onWorkspaceReset: () => void,
): DesktopSettingsController {
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [loaded, setLoaded] = useState(!nativeRepository);
  const [busyAction, setBusyAction] = useState<DesktopBusyAction | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!nativeRepository) {
      return;
    }
    let active = true;
    void nativeRepository.getDesktopSettings()
      .then((next) => {
        if (active) {
          setSettings(next);
          setLoaded(true);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setErrorMessage(getErrorMessage(error));
          setLoaded(true);
        }
      });
    return () => { active = false; };
  }, [nativeRepository]);

  async function choose(
    action: DesktopBusyAction,
    options?: { keepWorkspace?: boolean },
  ): Promise<void> {
    if (!nativeRepository) {
      return;
    }
    setBusyAction(action);
    setErrorMessage(null);
    try {
      const next = action === "logs"
        ? await nativeRepository.chooseLogLibrary()
        : await nativeRepository.chooseProject();
      if (next) {
        setSettings(next);
        // keepWorkspace：新建议题对话框内浏览目录时不清空工作区，
        // 避免对话框被卸载丢失草稿；工作区会因项目路径变化自动重载
        if (!options?.keepWorkspace && next.logLibrary && next.currentProjectPath) {
          onWorkspaceReset();
        }
      }
    } catch (error: unknown) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function selectRecentProject(path: string): Promise<void> {
    if (!nativeRepository) {
      return;
    }
    setBusyAction("project");
    try {
      const next = await nativeRepository.selectRecentProject(path);
      setSettings(next);
      onWorkspaceReset();
    } catch (error: unknown) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }

  return {
    settings,
    setSettings,
    loaded,
    ready: !nativeRepository || Boolean(settings?.logLibrary && settings.currentProjectPath),
    busyAction,
    errorMessage,
    choose,
    selectRecentProject,
  };
}
