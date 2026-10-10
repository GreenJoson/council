/**
 * @input  依赖：界面语言上下文（locale/setLocale）、data/theme 的 ThemePreference、data/cycle-preferences 的圆桌轮次上限读写
 * @output 导出：PreferencesDialog —— 原生 dialog 偏好面板：主题（日光/暗黑/跟随系统）、界面语言（中/EN）、圆桌轮次上限
 * @pos    V2 壳把原顶栏的主题与语言切换收进这里；轮次上限写入全局偏好供 CyclePanel 读取，圆桌开局表单不再出现轮次输入
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { Monitor, Moon, Sun, X, type LucideIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import {
  MAX_CYCLE_ROUND_BUDGET,
  MIN_CYCLE_ROUND_BUDGET,
  useCycleRoundBudget,
  writeCycleRoundBudget,
} from "../data/cycle-preferences";
import type { ThemePreference } from "../data/theme";
import { useI18n } from "../i18n/I18nProvider";

const themeOptions: { value: ThemePreference; label: string; Icon: LucideIcon }[] = [
  { value: "light", label: "日光模式", Icon: Sun },
  { value: "dark", label: "暗黑模式", Icon: Moon },
  { value: "system", label: "跟随系统", Icon: Monitor },
];

export interface PreferencesDialogProps {
  isOpen: boolean;
  themePreference: ThemePreference;
  onThemeChange: (next: ThemePreference) => void;
  onClose: () => void;
}

export function PreferencesDialog({
  isOpen,
  themePreference,
  onThemeChange,
  onClose,
}: PreferencesDialogProps) {
  const { t, locale, setLocale } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const roundBudget = useCycleRoundBudget();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (isOpen && !dialog.open) {
      dialog.showModal();
    } else if (!isOpen && dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  return (
    <dialog
      className="create-topic-dialog preferences-dialog"
      ref={dialogRef}
      aria-labelledby="preferences-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="preferences-body">
        <header>
          <div>
            <span className="dialog-kicker">Preferences</span>
            <h2 id="preferences-title">{t("偏好")}</h2>
          </div>
          <button className="icon-button" type="button" aria-label={t("关闭偏好")} onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <section className="preference-row">
          <div className="preference-label">
            <span>{t("主题")}</span>
          </div>
          <div className="segment-control" role="group" aria-label={t("主题")}>
            {themeOptions.map(({ value, label, Icon }) => (
              <button
                key={value}
                className={`segment-option ${themePreference === value ? "active" : ""}`}
                type="button"
                aria-pressed={themePreference === value}
                onClick={() => onThemeChange(value)}
              >
                <Icon size={14} aria-hidden="true" />
                {t(label)}
              </button>
            ))}
          </div>
        </section>

        <section className="preference-row">
          <div className="preference-label">
            <span>{t("界面语言")}</span>
          </div>
          <div className="segment-control" role="group" aria-label={t("界面语言")}>
            <button
              className={`segment-option ${locale === "zh-CN" ? "active" : ""}`}
              type="button"
              aria-pressed={locale === "zh-CN"}
              aria-label={t("中文")}
              title={t("中文")}
              onClick={() => setLocale("zh-CN")}
            >
              中
            </button>
            <button
              className={`segment-option ${locale === "en" ? "active" : ""}`}
              type="button"
              aria-pressed={locale === "en"}
              aria-label={t("英文")}
              title={t("英文")}
              onClick={() => setLocale("en")}
            >
              EN
            </button>
          </div>
        </section>

        <section className="preference-row">
          <label className="preference-label" htmlFor="preferences-round-budget">
            <span>{t("圆桌轮次上限")}</span>
            <small>{t("讨论到没人再反对为止，最多 {count} 轮，超出交给你裁决", { count: roundBudget })}</small>
          </label>
          <input
            id="preferences-round-budget"
            className="preference-number"
            type="number"
            min={MIN_CYCLE_ROUND_BUDGET}
            max={MAX_CYCLE_ROUND_BUDGET}
            step={1}
            value={roundBudget}
            onChange={(event) => writeCycleRoundBudget(Number(event.target.value))}
          />
        </section>

        <footer>
          <button className="primary-button" type="button" onClick={onClose}>
            {t("完成")}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
