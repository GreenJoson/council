/**
 * @input  依赖：Council 实施项领域类型
 * @output 导出：扁平实施项到树的组织、父状态派生规则与只数叶子的完成度汇总
 * @pos    实施进度 UI 与 mock 仓储共用的纯函数；不发起请求、不修改入参
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { CouncilWorkItem, WorkItemProgress, WorkItemStatus } from "../types/council";

export interface WorkItemNode {
  item: CouncilWorkItem;
  depth: number;
  children: WorkItemNode[];
}

/**
 * 父任务状态的派生规则，与服务端 deriveParentStatus 同口径。顺序即优先级：
 * 有子任务受阻就是受阻（先解依赖），全部完成才算完成，
 * 只要有人动过（进行中或已完成一部分）就是进行中，否则待处理。
 */
export function deriveParentStatus(
  childStatuses: readonly WorkItemStatus[],
): WorkItemStatus {
  if (childStatuses.some((status) => status === "blocked")) {
    return "blocked";
  }
  if (childStatuses.every((status) => status === "completed")) {
    return "completed";
  }
  if (
    childStatuses.some(
      (status) => status === "in_progress" || status === "completed",
    )
  ) {
    return "in_progress";
  }
  return "pending";
}

/**
 * 把扁平实施项组织成树。
 *
 * 父级缺失的条目（父任务已被删除，或分页只取到了子任务）按顶层渲染而不是丢弃——
 * 一条看得见但位置不对的任务，比一条凭空消失的任务好排查得多。
 */
export function buildWorkItemTree(
  items: readonly CouncilWorkItem[],
): WorkItemNode[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const childrenByParent = new Map<string, CouncilWorkItem[]>();
  const roots: CouncilWorkItem[] = [];
  for (const item of items) {
    const parentId = item.parentId;
    if (parentId && byId.has(parentId)) {
      const siblings = childrenByParent.get(parentId) ?? [];
      siblings.push(item);
      childrenByParent.set(parentId, siblings);
    } else {
      roots.push(item);
    }
  }

  const bySortOrder = (left: CouncilWorkItem, right: CouncilWorkItem): number =>
    left.sortOrder - right.sortOrder;

  // 自引用环在存储层已被 CHECK 挡住，这里的 visited 只防御脏数据导致的无限递归。
  const visited = new Set<string>();
  const toNodes = (
    nodeItems: readonly CouncilWorkItem[],
    depth: number,
  ): WorkItemNode[] =>
    [...nodeItems].sort(bySortOrder).flatMap((item) => {
      if (visited.has(item.id)) {
        return [];
      }
      visited.add(item.id);
      return [{
        item,
        depth,
        children: toNodes(childrenByParent.get(item.id) ?? [], depth + 1),
      }];
    });

  return toNodes(roots, 0);
}

/** 展平成渲染顺序（父在前、子紧随其后），供列表式 UI 直接遍历。 */
export function flattenWorkItemTree(
  nodes: readonly WorkItemNode[],
): WorkItemNode[] {
  return nodes.flatMap((node) => [node, ...flattenWorkItemTree(node.children)]);
}

/**
 * 只统计叶子节点：父任务的状态本来就是子任务汇总出来的，
 * 再把它计入分母等于同一件事数两次，「12 / 15」会凭空变大。
 * 与服务端 SQL 聚合同口径，两处必须一起改。
 */
export function summarizeWorkItemProgress(
  items: readonly CouncilWorkItem[],
): WorkItemProgress | undefined {
  const parentIds = new Set(
    items
      .map((item) => item.parentId)
      .filter((parentId): parentId is string => Boolean(parentId)),
  );
  const leaves = items.filter((item) => !parentIds.has(item.id));
  if (leaves.length === 0) {
    return undefined;
  }
  return {
    total: leaves.length,
    completed: leaves.filter((item) => item.status === "completed").length,
    blocked: leaves.filter((item) => item.status === "blocked").length,
    openBlockingFindings: leaves.filter(
      (item) =>
        item.origin === "review_finding"
        && item.severity === "blocking"
        && item.status !== "completed",
    ).length,
  };
}

/** 有子任务的条目状态由派生得来，任何手动写入路径都必须先问过这里。 */
export function hasChildren(
  items: readonly CouncilWorkItem[],
  workItemId: string,
): boolean {
  return items.some((item) => item.parentId === workItemId);
}
