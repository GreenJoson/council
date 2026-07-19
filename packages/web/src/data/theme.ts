/**
 * @input  依赖：document 根节点 dataset、matchMedia 与 localStorage
 * @output 导出：ThemePreference、initTheme、applyThemePreference、watchSystemTheme
 * @pos    日光/暗黑/跟随系统三态主题的唯一读写边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

export type ThemePreference = "light" | "dark" | "system";
export type ThemeName = "light" | "dark";

const THEME_STORAGE_KEY = "council.theme";
const DEFAULT_PREFERENCE: ThemePreference = "light";
const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

function readStoredPreference(): ThemePreference | null {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" || stored === "system" ? stored : null;
  } catch {
    return null;
  }
}

export function resolveInitialPreference(): ThemePreference {
  return readStoredPreference() ?? DEFAULT_PREFERENCE;
}

export function resolveTheme(preference: ThemePreference): ThemeName {
  if (preference === "system") {
    return window.matchMedia(DARK_MEDIA_QUERY).matches ? "dark" : "light";
  }
  return preference;
}

function setDocumentTheme(preference: ThemePreference): void {
  document.documentElement.dataset.theme = resolveTheme(preference);
}

/** 仅设置根节点属性，不写入偏好；用于应用启动，避免把默认值当成用户选择持久化 */
export function initTheme(): ThemePreference {
  const preference = resolveInitialPreference();
  setDocumentTheme(preference);
  return preference;
}

/** 用户显式切换时调用：解析并设置根节点属性，同时持久化偏好 */
export function applyThemePreference(preference: ThemePreference): void {
  setDocumentTheme(preference);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // 本地存储不可用时静默降级为会话内主题
  }
}

/** 订阅操作系统深浅色变化；仅在偏好为 system 时需要，返回取消订阅函数 */
export function watchSystemTheme(onSystemChange: () => void): () => void {
  const media = window.matchMedia(DARK_MEDIA_QUERY);
  media.addEventListener("change", onSystemChange);
  return () => media.removeEventListener("change", onSystemChange);
}
