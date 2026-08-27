/**
 * @input  依赖：项目、同步状态、主题、界面语言、搜索与面板操作回调
 * @output 导出：HeaderBar 顶部命令栏与中英双语切换入口
 * @pos    Operator Console 的全局导航和状态入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  Check,
  ChevronDown,
  Database,
  FolderOpen,
  Menu,
  Monitor,
  Moon,
  PanelRight,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Sun,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DesktopSettings } from "../data/desktop-bridge";
import type { ThemePreference } from "../data/theme";
import { useI18n } from "../i18n/I18nProvider";
import type { ProjectSummary, SyncState } from "../types/council";
import { BrandLogo } from "./presentation";

function pathBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

const themePreferenceLabels: Record<ThemePreference, string> = {
  light: "日光模式",
  dark: "暗黑模式",
  system: "跟随系统",
};

const nextThemePreference: Record<ThemePreference, ThemePreference> = {
  light: "dark",
  dark: "system",
  system: "light",
};

function ThemePreferenceIcon({ preference }: { preference: ThemePreference }) {
  if (preference === "light") {
    return <Sun size={18} />;
  }
  if (preference === "dark") {
    return <Moon size={18} />;
  }
  return <Monitor size={18} />;
}

export interface HeaderBarProps {
  project: ProjectSummary;
  sync: SyncState;
  searchQuery: string;
  themePreference: ThemePreference;
  onCycleTheme: () => void;
  onSearchChange: (query: string) => void;
  onCreateTopic: () => void;
  onRetrySync: () => void;
  onOpenTopics: () => void;
  onOpenInspector: () => void;
  onOpenSettings: () => void;
  desktopSettings?: DesktopSettings;
  onChooseProject?: () => Promise<void>;
  onChooseLogLibrary?: () => Promise<void>;
  onSelectRecentProject?: (path: string) => Promise<void>;
}

export function HeaderBar({
  project,
  sync,
  searchQuery,
  themePreference,
  onCycleTheme,
  onSearchChange,
  onCreateTopic,
  onRetrySync,
  onOpenTopics,
  onOpenInspector,
  onOpenSettings,
  desktopSettings,
  onChooseProject,
  onChooseLogLibrary,
  onSelectRecentProject,
}: HeaderBarProps) {
  const { locale, setLocale, t } = useI18n();
  const [isProjectMenuOpen, setIsProjectMenuOpen] = useState(false);
  const projectShellRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 菜单打开时：点击菜单外或按 Esc 关闭
  useEffect(() => {
    if (!isProjectMenuOpen) {
      return;
    }
    function handlePointerDown(event: PointerEvent) {
      if (!projectShellRef.current?.contains(event.target as Node)) {
        setIsProjectMenuOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsProjectMenuOpen(false);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isProjectMenuOpen]);

  // ⌘K / Ctrl+K 聚焦全局搜索
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const currentProjectPath = desktopSettings?.currentProjectPath ?? null;
  const recentProjectPaths = (desktopSettings?.recentProjectPaths ?? []).filter(
    (path) => path !== currentProjectPath,
  );

  return (
    <header className="header-bar">
      <div className="brand-cluster">
        <button
          className="icon-button mobile-panel-button"
          type="button"
          aria-label={t("打开议题导航")}
          onClick={onOpenTopics}
        >
          <Menu size={19} />
        </button>
        <a className="brand" href="#main-content" aria-label={t("Council 首页")}>
          <BrandLogo size={24} />
          <span>Council</span>
        </a>
        <div className="project-switcher-shell" ref={projectShellRef}>
          {desktopSettings ? (
            <button
              className="project-switcher"
              type="button"
              aria-label={t("切换项目")}
              aria-haspopup="menu"
              aria-expanded={isProjectMenuOpen}
              title={currentProjectPath ?? project.name}
              onClick={() => setIsProjectMenuOpen((current) => !current)}
            >
              <span className="project-mark" aria-hidden="true" />
              <span>{project.name}</span>
              <ChevronDown size={15} />
            </button>
          ) : (
            <span className="project-switcher is-static" title={project.name}>
              <span className="project-mark" aria-hidden="true" />
              <span>{project.name}</span>
            </span>
          )}
          {desktopSettings && isProjectMenuOpen ? (
            <div className="project-menu" role="menu">
              <div className="project-menu-scroll">
                {currentProjectPath ? (
                  <>
                    <div className="project-menu-label">{t("当前项目")}</div>
                    <div className="project-menu-current">
                      <FolderOpen size={15} />
                      <span className="project-entry">
                        <span className="project-entry-name">{pathBasename(currentProjectPath)}</span>
                        <code className="project-entry-path">{currentProjectPath}</code>
                      </span>
                      <Check size={15} className="project-current-check" />
                    </div>
                  </>
                ) : null}
                {recentProjectPaths.length > 0 ? (
                  <>
                    <div className="project-menu-label">{t("最近项目")}</div>
                    {recentProjectPaths.map((path) => (
                      <button
                        type="button"
                        key={path}
                        title={path}
                        onClick={() => {
                          setIsProjectMenuOpen(false);
                          void onSelectRecentProject?.(path);
                        }}
                      >
                        <FolderOpen size={15} />
                        <span className="project-entry">
                          <span className="project-entry-name">{pathBasename(path)}</span>
                          <code className="project-entry-path">{path}</code>
                        </span>
                      </button>
                    ))}
                  </>
                ) : null}
              </div>
              <div className="project-menu-divider" />
              <button type="button" onClick={() => {
                setIsProjectMenuOpen(false);
                void onChooseProject?.();
              }}><FolderOpen size={15} /><span>{t("打开其他项目…")}</span></button>
              <button type="button" onClick={() => {
                setIsProjectMenuOpen(false);
                void onChooseLogLibrary?.();
              }}><Database size={15} /><span>{t("设置日志库…")}</span></button>
            </div>
          ) : null}
        </div>
      </div>

      <label className="global-search">
        <Search size={17} aria-hidden="true" />
        <span className="sr-only">{t("搜索议题")}</span>
        <input
          ref={searchInputRef}
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={t("搜索议题标题或问题…")}
        />
        <kbd>⌘ K</kbd>
      </label>

      <div className="header-actions">
        {sync.status === "offline" ? (
          <button
            className={`sync-state sync-${sync.status}`}
            type="button"
            title={t("{label}，点击重试", { label: t(sync.label) })}
            onClick={onRetrySync}
          >
            <Sparkles size={14} aria-hidden="true" />
            <span>{t(sync.label)}</span>
          </button>
        ) : (
          <span className={`sync-state sync-${sync.status}`} title={t(sync.label)}>
            <Sparkles size={14} aria-hidden="true" />
            <span>{t(sync.label)}</span>
          </span>
        )}
        <button className="primary-button" type="button" onClick={onCreateTopic}>
          <Plus size={17} />
          <span>{t("新建议题")}</span>
        </button>
        <div className="language-switcher" role="group" aria-label={t("界面语言")}>
          <button
            type="button"
            className={locale === "zh-CN" ? "active" : ""}
            aria-pressed={locale === "zh-CN"}
            aria-label={t("中文")}
            title={t("中文")}
            onClick={() => setLocale("zh-CN")}
          >
            中
          </button>
          <button
            type="button"
            className={locale === "en" ? "active" : ""}
            aria-pressed={locale === "en"}
            aria-label={t("英文")}
            title={t("英文")}
            onClick={() => setLocale("en")}
          >
            EN
          </button>
        </div>
        <button
          className="icon-button desktop-action"
          type="button"
          aria-label={t("主题：{current}，点击切换为{next}", {
            current: t(themePreferenceLabels[themePreference]),
            next: t(themePreferenceLabels[nextThemePreference[themePreference]]),
          })}
          title={t("主题：{current}，点击切换为{next}", {
            current: t(themePreferenceLabels[themePreference]),
            next: t(themePreferenceLabels[nextThemePreference[themePreference]]),
          })}
          onClick={onCycleTheme}
        >
          <ThemePreferenceIcon preference={themePreference} />
        </button>
        <button
          className="icon-button desktop-action"
          type="button"
          aria-label={t("打开模型与 Provider 设置")}
          title={t("模型与 Provider 设置")}
          onClick={onOpenSettings}
        >
          <Settings2 size={18} />
        </button>
        <button
          className="icon-button inspector-mobile-button"
          type="button"
          aria-label={t("打开议题摘要")}
          onClick={onOpenInspector}
        >
          <PanelRight size={18} />
        </button>
      </div>
    </header>
  );
}
