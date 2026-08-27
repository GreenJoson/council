/**
 * @input  依赖：work-item-tree 纯函数与实施项夹具
 * @output 导出：父状态派生优先级、孤儿条目不丢失与只数叶子的完成度回归测试
 * @pos    前端树渲染与 mock 仓储共用口径的单一验收点，须与服务端 deriveParentStatus 保持一致
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { describe, expect, it } from "vitest";
import {
  buildWorkItemTree,
  deriveParentStatus,
  flattenWorkItemTree,
  summarizeWorkItemProgress,
} from "../src/data/work-item-tree";
import type { ActorSnapshot, CouncilWorkItem } from "../src/types/council";

const actor: ActorSnapshot = {
  schemaVersion: 1,
  actorId: "human",
  slug: "human",
  displayName: "User",
  shortName: "Us",
  role: "实现者",
};

function item(overrides: Partial<CouncilWorkItem> & { id: string }): CouncilWorkItem {
  return {
    title: overrides.id,
    details: "",
    status: "pending",
    version: 1,
    sortOrder: 0,
    origin: "manual",
    createdBy: "human",
    createdBySnapshot: actor,
    updatedBy: "human",
    updatedBySnapshot: actor,
    createdLabel: "10:00",
    updatedLabel: "10:00",
    ...overrides,
  };
}

describe("deriveParentStatus", () => {
  it("受阻优先于一切：先解依赖再谈进度", () => {
    expect(deriveParentStatus(["completed", "blocked", "completed"])).toBe("blocked");
  });

  it("全部完成才算完成，差一条就还是进行中", () => {
    expect(deriveParentStatus(["completed", "completed"])).toBe("completed");
    expect(deriveParentStatus(["completed", "pending"])).toBe("in_progress");
  });

  it("没人动过就停在待处理", () => {
    expect(deriveParentStatus(["pending", "pending"])).toBe("pending");
  });
});

describe("buildWorkItemTree", () => {
  it("按 sortOrder 排序，父在前子紧随其后", () => {
    const flat = flattenWorkItemTree(buildWorkItemTree([
      item({ id: "child_b", parentId: "parent", sortOrder: 1 }),
      item({ id: "child_a", parentId: "parent", sortOrder: 0 }),
      item({ id: "parent", sortOrder: 0 }),
      item({ id: "root_late", sortOrder: 1 }),
    ]));

    expect(flat.map((node) => node.item.id)).toEqual([
      "parent",
      "child_a",
      "child_b",
      "root_late",
    ]);
    expect(flat.map((node) => node.depth)).toEqual([0, 1, 1, 0]);
  });

  it("父级缺失的条目按顶层渲染而不是消失", () => {
    const flat = flattenWorkItemTree(buildWorkItemTree([
      item({ id: "orphan", parentId: "parent_deleted" }),
    ]));

    expect(flat.map((node) => node.item.id)).toEqual(["orphan"]);
    expect(flat[0]?.depth).toBe(0);
  });
});

describe("summarizeWorkItemProgress", () => {
  it("只统计叶子，父任务不进分母", () => {
    expect(summarizeWorkItemProgress([
      item({ id: "parent", status: "in_progress" }),
      item({ id: "child_done", parentId: "parent", status: "completed" }),
      item({ id: "child_open", parentId: "parent" }),
    ])).toEqual({ total: 2, completed: 1, blocked: 0, openBlockingFindings: 0 });
  });

  it("未完成的阻断级审核发现单独计数", () => {
    expect(summarizeWorkItemProgress([
      item({ id: "finding_open", origin: "review_finding", severity: "blocking" }),
      item({
        id: "finding_fixed",
        origin: "review_finding",
        severity: "blocking",
        status: "completed",
      }),
      item({ id: "nit", origin: "review_finding", severity: "non_blocking" }),
    ])).toEqual({ total: 3, completed: 1, blocked: 0, openBlockingFindings: 1 });
  });

  it("没有实施项时不返回汇总，导航据此区分「还没拆」", () => {
    expect(summarizeWorkItemProgress([])).toBeUndefined();
  });
});
