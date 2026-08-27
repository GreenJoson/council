/**
 * @input  依赖：浏览器语言、document 根节点与 localStorage
 * @output 导出：Locale、resolveInitialLocale、initLocale 与 applyLocale
 * @pos    中英界面语言的唯一探测、应用和持久化边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

export type Locale = "zh-CN" | "en";

const LOCALE_STORAGE_KEY = "council.locale";

function readStoredLocale(): Locale | null {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return stored === "zh-CN" || stored === "en" ? stored : null;
  } catch {
    return null;
  }
}

export function resolveLocalePreference(
  stored: string | null,
  languages: readonly string[],
): Locale {
  if (stored === "zh-CN" || stored === "en") {
    return stored;
  }
  return languages.some((language) => language.toLowerCase().startsWith("zh"))
    ? "zh-CN"
    : "en";
}

function resolveSystemLanguages(): readonly string[] {
  if (typeof navigator === "undefined") {
    return ["zh-CN"];
  }
  return navigator.languages.length > 0
    ? navigator.languages
    : [navigator.language];
}

export function resolveInitialLocale(): Locale {
  if (typeof window === "undefined") {
    return "zh-CN";
  }
  return resolveLocalePreference(readStoredLocale(), resolveSystemLanguages());
}

function setDocumentLocale(locale: Locale): void {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.lang = locale;
  document.documentElement.dataset.locale = locale;
}

export function initLocale(): Locale {
  const locale = resolveInitialLocale();
  setDocumentLocale(locale);
  return locale;
}

export function applyLocale(locale: Locale, persist = true): void {
  setDocumentLocale(locale);
  if (!persist || typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // 本地存储不可用时，语言选择仍在当前 React 会话内生效。
  }
}
