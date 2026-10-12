/**
 * @input  依赖：界面语言（展开/收起与搜索文案）、lucide 图标
 * @output 导出：normalizeQuery/textMatches 匹配工具、Highlight（命中片段包 <mark>）、SectionSearch（区块内搜索框，Esc 清空）、
 *         FoldToggle（展开/收起按钮）、FoldList（超过 limit 项时只露前几项 +「展开其余 N 项 / 收起」）、
 *         FoldText（长文本/长 JSON 按行数与字数截断 + 展开/收起）
 * @pos    详情页长内容的统一折叠与区块内搜索：任务简报与正文、流水线复盘记录与约束共用。搜索只做前端子串匹配（不区分大小写）；
 *         有查询时 FoldList/FoldText 不再折叠，免得命中项被收起藏住
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { ChevronDown, ChevronUp, Search } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useI18n } from "../i18n/I18nProvider";

export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

/** 空查询视为全部命中；任一文本包含查询即命中。 */
export function textMatches(query: string, ...texts: readonly (string | undefined)[]): boolean {
  const needle = normalizeQuery(query);
  if (!needle) return true;
  return texts.some((text) => text?.toLowerCase().includes(needle) ?? false);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 用带捕获组的正则切分：奇数下标即命中片段，避免 toLowerCase 改变长度时下标错位。 */
export function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (!needle) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRegExp(needle)})`, "gi"));
  return <>{parts.map((part, index) => (index % 2 === 1 ? <mark key={index} className="fold-search-hit">{part}</mark> : part))}</>;
}

export interface SectionSearchProps {
  value: string;
  onChange: (value: string) => void;
  /** 读屏标签。 */
  label: string;
  placeholder: string;
  /** 有查询时显示在框尾的结果说明，如「3 项匹配」。 */
  status?: string;
}

export function SectionSearch({ value, onChange, label, placeholder, status }: SectionSearchProps) {
  return (
    <label className="section-search">
      <Search size={13} aria-hidden="true" />
      <span className="sr-only">{label}</span>
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.stopPropagation();
            onChange("");
          }
        }}
      />
      {status ? <small aria-live="polite">{status}</small> : null}
    </label>
  );
}

export function FoldToggle({ expanded, hiddenCount, onToggle }: { expanded: boolean; hiddenCount?: number; onToggle: () => void }) {
  const { t } = useI18n();
  return (
    <button className="fold-toggle" type="button" aria-expanded={expanded} onClick={onToggle}>
      {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      {expanded
        ? t("收起")
        : hiddenCount !== undefined ? t("展开其余 {count} 项", { count: hiddenCount }) : t("展开全部")}
    </button>
  );
}

export interface FoldListProps<T> {
  items: readonly T[];
  getKey: (item: T, index: number) => string | number;
  renderItem: (item: T, index: number) => ReactNode;
  /** 收起时露出的项数；只多出 1 项时不折叠，省得为一行多点一次。 */
  limit?: number;
  /** 搜索中等场景强制全部展开。 */
  forceOpen?: boolean;
  className?: string;
}

export function FoldList<T>({ items, getKey, renderItem, limit = 5, forceOpen = false, className }: FoldListProps<T>) {
  const [expanded, setExpanded] = useState(false);
  const foldable = !forceOpen && items.length > limit + 1;
  const visible = foldable && !expanded ? items.slice(0, limit) : items;
  return (
    <>
      <ul className={className}>
        {visible.map((item, index) => <li key={getKey(item, index)}>{renderItem(item, index)}</li>)}
      </ul>
      {foldable ? (
        <FoldToggle expanded={expanded} hiddenCount={items.length - limit} onToggle={() => setExpanded((value) => !value)} />
      ) : null}
    </>
  );
}

export interface FoldTextProps {
  text: string;
  /** 命中查询时自动展开并高亮。 */
  query?: string;
  maxLines?: number;
  maxChars?: number;
  /** pre 用于保留缩进的 JSON，p 用于普通段落（均 pre-wrap）。 */
  as?: "p" | "pre";
  className?: string;
}

export function FoldText({ text, query = "", maxLines = 6, maxChars = 360, as: Tag = "p", className }: FoldTextProps) {
  const [expanded, setExpanded] = useState(false);
  const lines = text.split("\n");
  const long = lines.length > maxLines || text.length > maxChars;
  const forced = Boolean(normalizeQuery(query)) && textMatches(query, text);
  const open = !long || expanded || forced;
  const shown = open ? text : `${lines.slice(0, maxLines).join("\n").slice(0, maxChars).trimEnd()}…`;
  return (
    <div className={`fold-text${className ? ` ${className}` : ""}`}>
      <Tag className="fold-text-body"><Highlight text={shown} query={query} /></Tag>
      {long && !forced ? <FoldToggle expanded={expanded} onToggle={() => setExpanded((value) => !value)} /> : null}
    </div>
  );
}
