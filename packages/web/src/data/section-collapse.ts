/**
 * @input  依赖：localStorage
 * @output 导出：架构档案折叠集（SectionId、parseCollapsedSections、readCollapsedSections、writeCollapsedSections）
 *         与上下文栏展开集（InspectorSectionId、readExpandedInspectorSections、writeExpandedInspectorSections）
 * @pos    区块折叠/展开状态的唯一读写边界；折叠是为了让长页面短下来，
 *         每次重开又展开等于没折过，所以必须跨会话记住。两边存的都是「偏离默认的那一侧」：
 *         架构档案默认展开、记收起了哪些；上下文栏的约束/证据/备选默认收起、记展开了哪些
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

interface SectionSetStore<T extends string> {
  parse(raw: string | null): ReadonlySet<T>;
  read(): ReadonlySet<T>;
  write(value: ReadonlySet<T>): void;
}

/** 两处折叠记忆只差存储键和合法 id 表，解析与降级规则共用一份。 */
function createSectionSetStore<T extends string>(
  storageKey: string,
  ids: readonly T[],
): SectionSetStore<T> {
  const isSectionId = (value: unknown): value is T =>
    typeof value === "string" && ids.includes(value as T);
  /** 纯函数：判断与存储分开，才能不依赖 DOM 就测到「值坏了怎么办」。 */
  const parse = (raw: string | null): ReadonlySet<T> => {
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
  };
  return {
    parse,
    read: () => {
      try {
        return parse(window.localStorage.getItem(storageKey));
      } catch {
        return new Set();
      }
    },
    write: (value) => {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify([...value]));
      } catch {
        // 本地存储不可用时降级为会话内折叠，不影响当前操作。
      }
    },
  };
}

// ---- 架构档案：默认展开，记「收起了哪些」 ----

export type SectionId = "timeline" | "constraints" | "diagrams" | "attachments";

const architectureSections = createSectionSetStore<SectionId>(
  "council.collapsedSections",
  ["timeline", "constraints", "diagrams", "attachments"],
);

export function parseCollapsedSections(raw: string | null): ReadonlySet<SectionId> {
  return architectureSections.parse(raw);
}

export function readCollapsedSections(): ReadonlySet<SectionId> {
  return architectureSections.read();
}

export function writeCollapsedSections(collapsed: ReadonlySet<SectionId>): void {
  architectureSections.write(collapsed);
}

// ---- 上下文栏：约束/证据/备选默认收起，记「展开了哪些」 ----

export type InspectorSectionId = "constraints" | "evidence" | "alternatives";

const inspectorSections = createSectionSetStore<InspectorSectionId>(
  "council.inspector.expandedSections",
  ["constraints", "evidence", "alternatives"],
);

export function readExpandedInspectorSections(): ReadonlySet<InspectorSectionId> {
  return inspectorSections.read();
}

export function writeExpandedInspectorSections(expanded: ReadonlySet<InspectorSectionId>): void {
  inspectorSections.write(expanded);
}
