/**
 * @input  依赖：界面语言上下文、构建期注入的 __COUNCIL_BUILD__
 * @output 导出：StatusBar 底部状态条
 * @pos    让人一眼看出手上跑的是哪个构建，避免把旧包当新包排查
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { ReactElement } from "react";
import { useI18n } from "../i18n/I18nProvider";

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

export function StatusBar(): ReactElement {
  const { t } = useI18n();
  const build = __COUNCIL_BUILD__;
  const builtAt = formatBuiltAt(build.builtAt);
  return (
    <footer className="status-bar">
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
