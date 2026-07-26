/**
 * @input  依赖：构建期注入的 __COUNCIL_BUILD__
 * @output 导出：StatusBar 底部状态条
 * @pos    让人一眼看出手上跑的是哪个构建，避免把旧包当新包排查
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { ReactElement } from "react";

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
  const build = __COUNCIL_BUILD__;
  const builtAt = formatBuiltAt(build.builtAt);
  return (
    <footer className="status-bar">
      <span
        className="status-build"
        title={`版本 ${build.version} · 提交 ${build.commit} · 构建于 ${build.builtAt}`}
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
