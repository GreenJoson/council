/**
 * @input  依赖：界面语言上下文、构建期注入的 __COUNCIL_BUILD__、工作区同步状态与重试回调、可选的活动 Agent 数
 * @output 导出：StatusBar 底部状态条——左侧同步状态（离线可点击重试）与活动 Agent 计数（计数未知时不渲染），
 *         右侧构建身份（版本 · commit · 构建时间）
 * @pos    V2 壳把原顶栏的同步状态移到这里；让人一眼看出手上跑的是哪个构建，避免把旧包当新包排查；
 *         Agent 计数与图标栏「会话」徽标同源，离开讨论视图也知道后台有没有东西在跑
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { Bot, Sparkles } from "lucide-react";
import type { ReactElement } from "react";
import { useI18n } from "../i18n/I18nProvider";
import type { SyncState } from "../types/council";

export interface StatusBarProps {
  sync: SyncState;
  onRetrySync: () => void;
  /** 当前项目正在跑的 Agent 数；离线或未选题时为空，不渲染该段。 */
  activeAgents?: number;
}

/** 把 ISO 时间压成本地「MM-DD HH:mm」；解析不了就原样退回，不猜。 */
function formatBuiltAt(iso: string): string {
  const stamp = new Date(iso);
  if (Number.isNaN(stamp.getTime())) {
    return iso;
  }
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}`
    + ` ${pad(stamp.getHours())}:${pad(stamp.getMinutes())}`;
}

export function StatusBar({ sync, onRetrySync, activeAgents }: StatusBarProps): ReactElement {
  const { t } = useI18n();
  const build = __COUNCIL_BUILD__;
  const builtAt = formatBuiltAt(build.builtAt);
  return (
    <footer className="status-bar">
      {sync.status === "offline" ? (
        <button
          className="sync-state sync-offline"
          type="button"
          title={t("{label}，点击重试", { label: t(sync.label) })}
          onClick={onRetrySync}
        >
          <Sparkles size={13} aria-hidden="true" />
          <span>{t(sync.label)}</span>
        </button>
      ) : (
        <span className={`sync-state sync-${sync.status}`} title={t(sync.label)}>
          <Sparkles size={13} aria-hidden="true" />
          <span>{t(sync.label)}</span>
        </span>
      )}
      {activeAgents !== undefined ? (
        <span
          className={`status-agents ${activeAgents > 0 ? "status-agents-active" : ""}`}
          data-testid="status-active-agents"
        >
          <Bot size={13} aria-hidden="true" />
          <span>
            {activeAgents > 0
              ? t("{count} 个 Agent 运行中", { count: activeAgents })
              : t("没有 Agent 在运行")}
          </span>
        </span>
      ) : null}
      <span
        className="status-build"
        title={t("版本 {version} · 提交 {commit} · 构建于 {time}", {
          version: build.version,
          commit: build.commit,
          time: build.builtAt,
        })}
      >
        <span className="status-build-version">v{build.version}</span>
        <span className="status-build-sep" aria-hidden="true">·</span>
        <span className="status-build-commit">{build.commit}</span>
        <span className="status-build-sep" aria-hidden="true">·</span>
        <span className="status-build-time">{builtAt}</span>
      </span>
    </footer>
  );
}
