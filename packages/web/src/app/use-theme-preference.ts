/**
 * @input  依赖：React、data/theme 主题偏好读写与系统深浅色监听
 * @output 导出：useThemePreference —— 当前主题偏好与 setThemePreference（偏好对话框直接选 light / dark / system）
 * @pos    App 壳的主题状态；跟随系统时实时重放操作系统深浅色变化
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { useCallback, useEffect, useState } from "react";
import {
  applyThemePreference,
  resolveInitialPreference,
  watchSystemTheme,
  type ThemePreference,
} from "../data/theme";

export function useThemePreference(): {
  themePreference: ThemePreference;
  setThemePreference: (next: ThemePreference) => void;
} {
  const [themePreference, setPreference] = useState<ThemePreference>(resolveInitialPreference);

  // 跟随系统时监听操作系统深浅色变化并实时重放到根节点
  useEffect(() => {
    if (themePreference !== "system") {
      return;
    }
    return watchSystemTheme(() => applyThemePreference("system"));
  }, [themePreference]);

  const setThemePreference = useCallback((next: ThemePreference): void => {
    applyThemePreference(next);
    setPreference(next);
  }, []);

  return { themePreference, setThemePreference };
}
