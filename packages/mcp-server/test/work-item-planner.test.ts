/**
 * @input  依赖：AI 实施计划结构化解析器与既有任务标题
 * @output 验证：合法任务、重复过滤、缺失协议和空验收标准的失败关闭
 * @pos    模型自由文本进入 canonical work_items 前的安全边界回归测试
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkItemPlan } from "../src/orchestration/work-item-planner.js";

test("实施计划解析器保留可验证任务并过滤已有或同批重复标题", () => {
  const items = parseWorkItemPlan([
    "```council-work-plan",
    JSON.stringify({
      items: [
        { title: "实现 API", details: "范围：新增接口；验收：集成测试通过；依赖：无" },
        { title: "已有任务", details: "不应重复" },
        { title: "实现 API", details: "同批重复也不应写入" },
        { title: "补齐回归测试", details: "范围：失败路径；验收：测试稳定通过；依赖：实现 API" },
      ],
    }),
    "```",
  ].join("\n"), ["已有任务"]);

  assert.deepEqual(items, [
    { title: "实现 API", details: "范围：新增接口；验收：集成测试通过；依赖：无" },
    { title: "补齐回归测试", details: "范围：失败路径；验收：测试稳定通过；依赖：实现 API" },
  ]);
});

test("实施计划解析器拒绝自由文本和缺少验收说明的任务", () => {
  assert.throws(
    () => parseWorkItemPlan("建议先实现接口。", []),
    /council-work-plan/u,
  );
  assert.throws(
    () => parseWorkItemPlan([
      "```council-work-plan",
      '{"items":[{"title":"实现接口","details":""}]}',
      "```",
    ].join("\n"), []),
    /验收标准/u,
  );
});
