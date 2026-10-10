/**
 * @input  依赖：React、data/theme 主题偏好读写与系统深浅色监听
 * @output 导出：useThemePreference —— 当前主题偏好与 light → dark → system 循环切换
 * @pos    App 壳的主题状态；跟随系统时实时重放操作系统深浅色变化
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { useEffect, useState } from "react";
import {
  applyThemePreference,
  resolveInitialPreference,
  watchSystemTheme,
  type ThemePreference,
} from "../data/theme";

export function useThemePreference(): {
  themePreference: ThemePreference;
  cycleTheme: () => void;
} {
  const [themePreference, setThemePreference] = useState<ThemePreference>(resolveInitialPreference);

  // 跟随系统时监听操作系统深浅色变化并实时重放到根节点
  useEffect(() => {
    if (themePreference !== "system") {
      return;
    }
    return watchSystemTheme(() => applyThemePreference("system"));
  }, [themePreference]);

  function cycleTheme(): void {
    setThemePreference((current) => {
      const next: ThemePreference =
        current === "light" ? "dark" : current === "dark" ? "system" : "light";
      applyThemePreference(next);
      return next;
    });
  }

  return { themePreference, cycleTheme };
}
