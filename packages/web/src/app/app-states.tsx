/**
 * @input  依赖：界面语言上下文、lucide 图标
 * @output 导出：RecoverableError 可恢复错误条、FatalState 致命加载失败页（含桌面重选日志库/项目）、LoadingState 加载页
 * @pos    App 壳的全局状态展示组件，不持有状态，只渲染并回调
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  Database,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
  X,
} from "lucide-react";
import { useI18n } from "../i18n/I18nProvider";

interface RecoverableErrorProps {
  message: string;
  onRetry: () => void;
  onClose: () => void;
}

export function RecoverableError({ message, onRetry, onClose }: RecoverableErrorProps) {
  const { t } = useI18n();
  return (
    <div className="error-banner" role="alert">
      <TriangleAlert size={17} />
      <span>{t(message)}</span>
      <button className="secondary-button" type="button" onClick={onRetry}>
        <RefreshCw size={15} />
        {t("重试")}
      </button>
      <button className="icon-button compact" type="button" aria-label={t("关闭错误提示")} onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  );
}

interface FatalStateProps {
  message: string;
  onRetry: () => void;
  busyAction?: "logs" | "project" | null;
  onChooseLogLibrary?: () => Promise<void>;
  onChooseProject?: () => Promise<void>;
}

export function FatalState({
  message,
  onRetry,
  busyAction,
  onChooseLogLibrary,
  onChooseProject,
}: FatalStateProps) {
  const { t } = useI18n();
  return (
    <main className="full-state">
      <TriangleAlert size={28} />
      <h1>{t("无法加载 Council")}</h1>
      <p>{t(message)}</p>
      <div className="full-state-actions">
        <button className="primary-button" type="button" disabled={Boolean(busyAction)} onClick={onRetry}>
          <RefreshCw size={17} />
          {t("重试")}
        </button>
        {onChooseLogLibrary ? (
          <button
            className="secondary-button"
            type="button"
            disabled={Boolean(busyAction)}
            onClick={() => void onChooseLogLibrary()}
          >
            {busyAction === "logs" ? <LoaderCircle className="spinner" size={17} /> : <Database size={17} />}
            {t("重选日志库")}
          </button>
        ) : null}
        {onChooseProject ? (
          <button
            className="secondary-button"
            type="button"
            disabled={Boolean(busyAction)}
            onClick={() => void onChooseProject()}
          >
            {busyAction === "project" ? <LoaderCircle className="spinner" size={17} /> : <FolderOpen size={17} />}
            {t("重选项目")}
          </button>
        ) : null}
      </div>
    </main>
  );
}

export function LoadingState() {
  const { t } = useI18n();
  return (
    <main className="full-state" aria-busy="true">
      <LoaderCircle className="spinner" size={28} />
      <h1>{t("正在连接 Council")}</h1>
      <p>{t("加载 Operator Console 工作区…")}</p>
    </main>
  );
}
