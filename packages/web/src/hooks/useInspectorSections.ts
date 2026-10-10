/**
 * @input  依赖：data/section-collapse 的 readExpandedInspectorSections / writeExpandedInspectorSections
 * @output 导出：useInspectorSections —— 右栏「上下文」三个背景区块（约束/证据/备选）的展开集合与切换回调；
 *         默认全部收起，每次切换同步写入 localStorage，跨会话记住；SSR / 无 window 时为全部收起
 * @pos    由 WorkspaceMain 调用后把状态作为受控 props 传给 InspectorPanel，组件本身不碰存储，测试可直接传入集合
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { useCallback, useState } from "react";
import {
  readExpandedInspectorSections,
  writeExpandedInspectorSections,
  type InspectorSectionId,
} from "../data/section-collapse";

export interface InspectorSectionsState {
  expandedSections: ReadonlySet<InspectorSectionId>;
  onToggleSection: (id: InspectorSectionId) => void;
}

export function useInspectorSections(): InspectorSectionsState {
  const [expandedSections, setExpandedSections] = useState<ReadonlySet<InspectorSectionId>>(
    () => readExpandedInspectorSections(),
  );
  const onToggleSection = useCallback((id: InspectorSectionId): void => {
    setExpandedSections((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      writeExpandedInspectorSections(next);
      return next;
    });
  }, []);
  return { expandedSections, onToggleSection };
}
