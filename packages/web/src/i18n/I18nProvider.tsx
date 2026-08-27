/**
 * @input  依赖：英文词典、Locale 持久化边界与 React Context
 * @output 导出：I18nProvider、useI18n、translate 与 TranslationParams
 * @pos    UI 固定文案的中英翻译入口；议题、消息、决策等用户内容不得传入
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { englishCatalog } from "./catalog.en";
import { applyLocale, resolveInitialLocale, type Locale } from "./locale";

export type TranslationParams = Readonly<Record<string, string | number>>;

function interpolate(template: string, params?: TranslationParams): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const dynamicEnglishCatalog = Object.entries(englishCatalog)
  .filter(([source]) => /\{[A-Za-z0-9_]+\}/u.test(source))
  .map(([source, target]) => {
    const names: string[] = [];
    let pattern = "^";
    let lastIndex = 0;
    for (const match of source.matchAll(/\{([A-Za-z0-9_]+)\}/gu)) {
      pattern += escapePattern(source.slice(lastIndex, match.index));
      pattern += "(.+?)";
      const name = match[1];
      if (!name) {
        continue;
      }
      names.push(name);
      lastIndex = match.index + match[0].length;
    }
    pattern += `${escapePattern(source.slice(lastIndex))}$`;
    return {
      names,
      pattern: new RegExp(pattern, "u"),
      target,
    };
  });

function translateRenderedMessage(source: string): string | undefined {
  for (const entry of dynamicEnglishCatalog) {
    const match = entry.pattern.exec(source);
    if (!match) {
      continue;
    }
    const params = Object.fromEntries(entry.names.map((name, index) => [name, match[index + 1] ?? ""]));
    return interpolate(entry.target, params);
  }
  return undefined;
}

export function translate(locale: Locale, source: string, params?: TranslationParams): string {
  const template = locale === "en"
    ? (englishCatalog[source] ?? translateRenderedMessage(source) ?? source)
    : source;
  return interpolate(template, params);
}

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (source: string, params?: TranslationParams) => string;
}

const defaultValue: I18nValue = {
  locale: "zh-CN",
  setLocale: () => undefined,
  t: (source, params) => translate("zh-CN", source, params),
};

const I18nContext = createContext<I18nValue>(defaultValue);

export interface I18nProviderProps {
  children: ReactNode;
  initialLocale?: Locale;
}

export function I18nProvider({ children, initialLocale }: I18nProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale ?? resolveInitialLocale);
  const setLocale = useCallback((nextLocale: Locale) => {
    applyLocale(nextLocale);
    setLocaleState(nextLocale);
  }, []);
  const t = useCallback(
    (source: string, params?: TranslationParams) => translate(locale, source, params),
    [locale],
  );
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
