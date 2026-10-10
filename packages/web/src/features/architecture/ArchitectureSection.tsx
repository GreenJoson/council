/**
 * @input  依赖：界面语言上下文、区块标题/图标/计数与折叠开关回调
 * @output 导出：ArchitectureSection 可折叠区块外壳
 * @pos    架构档案三个长区块共用的头部与折叠行为；标题栏整体可点，
 *         右侧箭头只是可见的抓手——长清单里让用户去瞄准一个小图标是刁难
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import type { SectionId } from "../../data/section-collapse";

export interface ArchitectureSectionProps {
  id: SectionId;
  className: string;
  icon: ReactNode;
  /** 中文文案作为词典 key，由本组件统一翻译 */
  title: string;
  count: number;
  isCollapsed: boolean;
  onToggle: (id: SectionId) => void;
  children: ReactNode;
}

export function ArchitectureSection({
  id,
  className,
  icon,
  title,
  count,
  isCollapsed,
  onToggle,
  children,
}: ArchitectureSectionProps) {
  const { t } = useI18n();
  const bodyId = `architecture-section-${id}`;
  const label = t(title);
  return (
    <section
      className={[className, isCollapsed ? "architecture-section-collapsed" : ""]
        .filter(Boolean).join(" ")}
      aria-label={label}
    >
      <header className="architecture-section-header">
        {/* 按钮放在 h2 里而不是反过来：h2 只能装 phrasing content，
            把标题塞进 button 会生成非法 HTML；这也是 ARIA accordion 的标准结构。 */}
        <h2>
          <button
            className="architecture-section-toggle"
            type="button"
            aria-expanded={!isCollapsed}
            aria-controls={bodyId}
            title={isCollapsed ? t("展开{title}", { title: label }) : t("收起{title}", { title: label })}
            onClick={() => onToggle(id)}
          >
            {icon}
            <span className="architecture-section-title">{label}</span>
            <span className="count-pill">{count}</span>
            <ChevronDown className="architecture-section-chevron" size={16} aria-hidden="true" />
          </button>
        </h2>
      </header>

      {isCollapsed ? null : <div id={bodyId}>{children}</div>}
    </section>
  );
}
