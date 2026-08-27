/**
 * @input  依赖：localStorage
 * @output 导出：SectionId、纯解析的 parseCollapsedSections、readCollapsedSections 与 writeCollapsedSections
 * @pos    架构档案区块折叠状态的唯一读写边界；折叠是为了让长页面短下来，
 *         每次重开又展开等于没折过，所以必须跨会话记住
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

const STORAGE_KEY = "council.collapsedSections";

export type SectionId = "timeline" | "constraints" | "diagrams";

const SECTION_IDS: readonly SectionId[] = ["timeline", "constraints", "diagrams"];

function isSectionId(value: unknown): value is SectionId {
  return typeof value === "string" && SECTION_IDS.includes(value as SectionId);
}

/** 纯函数：判断与存储分开，才能不依赖 DOM 就测到「值坏了怎么办」。 */
export function parseCollapsedSections(raw: string | null): ReadonlySet<SectionId> {
  if (!raw) {
    return new Set();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    // 只认已知区块 id：旧版本留下的名字改过之后不该让整页停在折叠态。
    return new Set(Array.isArray(parsed) ? parsed.filter(isSectionId) : []);
  } catch {
    return new Set();
  }
}

export function readCollapsedSections(): ReadonlySet<SectionId> {
  try {
    return parseCollapsedSections(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return new Set();
  }
}

export function writeCollapsedSections(collapsed: ReadonlySet<SectionId>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...collapsed]));
  } catch {
    // 本地存储不可用时降级为会话内折叠，不影响当前操作。
  }
}
