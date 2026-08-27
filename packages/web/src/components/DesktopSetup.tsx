/**
 * @input  依赖：界面语言上下文、桌面设置状态与原生目录选择回调
 * @output 导出：DesktopSetup 首次运行引导
 * @pos    日志库或项目未配置时阻止错误内容请求的桌面启动门
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { Check, Database, FolderOpen, LoaderCircle } from "lucide-react";
import { useI18n } from "../i18n/I18nProvider";
import { BrandLogo } from "./presentation";

export interface DesktopSetupProps {
  hasLogLibrary: boolean;
  hasProject: boolean;
  busyAction: "logs" | "project" | null;
  errorMessage: string | null;
  onChooseLogLibrary: () => Promise<void>;
  onChooseProject: () => Promise<void>;
}

export function DesktopSetup({
  hasLogLibrary,
  hasProject,
  busyAction,
  errorMessage,
  onChooseLogLibrary,
  onChooseProject,
}: DesktopSetupProps) {
  const { t } = useI18n();
  return (
    <main className="desktop-setup">
      <div className="desktop-setup-card">
        <div className="desktop-setup-brand">
          <BrandLogo size={40} />
          <span className="desktop-setup-kicker">Council Desktop</span>
        </div>
        <h1>{t("把议事厅接到你的项目")}</h1>
        <p>{t("日志库保存共享讨论，项目目录决定 Agent 检查哪一份代码。两者都只记录在本机。")}</p>
        <div className="desktop-setup-steps">
          <button
            className={hasLogLibrary ? "is-complete" : ""}
            type="button"
            disabled={busyAction !== null}
            onClick={() => void onChooseLogLibrary()}
          >
            <span className="setup-icon"><Database size={20} /></span>
            <span><strong>{t("1. 选择日志库")}</strong><small>{t("读取或创建共享 council.sqlite3")}</small></span>
            {busyAction === "logs" ? <LoaderCircle className="spinning" size={18} /> : hasLogLibrary ? <Check size={18} /> : null}
          </button>
          <button
            className={hasProject ? "is-complete" : ""}
            type="button"
            disabled={busyAction !== null || !hasLogLibrary}
            onClick={() => void onChooseProject()}
          >
            <span className="setup-icon"><FolderOpen size={20} /></span>
            <span><strong>{t("2. 选择当前项目")}</strong><small>{t("以后可从左上角随时切换")}</small></span>
            {busyAction === "project" ? <LoaderCircle className="spinning" size={18} /> : hasProject ? <Check size={18} /> : null}
          </button>
        </div>
        {errorMessage ? <p className="desktop-setup-error" role="alert">{t(errorMessage)}</p> : null}
      </div>
    </main>
  );
}
