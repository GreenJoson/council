/**
 * @input  依赖：schema-migrator 的逐版本权威重放与已发布版本指纹
 * @output 验证：已发布迁移文本不可改、新版本必须补指纹、v5 为纯数据迁移
 * @pos    把「已落库的迁移 DDL 冻结」从口头规则变成会红的测试
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  COUNCIL_SCHEMA_VERSION,
  canonicalSchemaDigest,
} from "../src/schema-migrator.js";

/**
 * 每个已发布版本的必需 schema 对象指纹。真实用户库就是按这些文本迁移出来的，
 * 改动其中任何一条，旧库都会在 assertCanonicalSchema 处打不开——现场表现是
 * 桌面端整个起不来。要改结构就新增一个版本，不要动这里已有的行。
 */
const FROZEN_SCHEMA_DIGESTS: ReadonlyMap<number, string> = new Map([
  [2, "44d763d90f387cf39007e9347772ba1aca4102bbaeade3f38a115258cb823396"],
  [3, "e69e4843727bb39bfdde584eda02c1306a53b3b126166b152efa28f3980ee885"],
  [4, "b53a7b9dfd74068cec951d43f83697e902cd6921bc322e509ebc733f14e73771"],
  [5, "b53a7b9dfd74068cec951d43f83697e902cd6921bc322e509ebc733f14e73771"],
  [6, "51f8a6684fd07a0ccd768cbce7c78a7a60718d2024217f382fb656d0a1a1cd34"],
  [7, "10f07f206328eec7845623786586e0e005ea8e15b80626c0fb72d21e3302f43e"],
  [8, "7b99a20dff08fef3edce8e344ac15d8ae7ab46d18b49e338f4d3f7cd95306ef1"],
  [9, "3ae0a6d0f5b4b9b074d224ac900e1be332b552141261d4274da6bb5bfe3b7645"],
]);

test("已发布迁移的 schema 文本被冻结", () => {
  for (const [version, expected] of FROZEN_SCHEMA_DIGESTS) {
    assert.equal(
      canonicalSchemaDigest(version),
      expected,
      `v${String(version)} 的 schema 文本被改动了。已经按旧文本迁移过的库将无法打开；`
      + "请改为新增一个迁移版本，而不是修改这一版。",
    );
  }
});

test("每个已发布版本都必须留下指纹", () => {
  for (let version = 2; version <= COUNCIL_SCHEMA_VERSION; version += 1) {
    assert.ok(
      FROZEN_SCHEMA_DIGESTS.has(version),
      `v${String(version)} 没有冻结指纹；新增迁移时必须同时补上。`,
    );
  }
  const newest = Math.max(...FROZEN_SCHEMA_DIGESTS.keys());
  assert.equal(newest, COUNCIL_SCHEMA_VERSION, "指纹表的最高版本必须等于当前 schema 版本。");
});

test("v5 是纯数据迁移，不改动 schema", () => {
  // 指纹相同不是切片漏了 migrateVersionFive，而是它只解绑固定 seed、不碰 DDL。
  // 这条断言让「以后有人给 v5 加 DDL」立刻暴露，而不是悄悄让指纹表失去区分度。
  assert.equal(canonicalSchemaDigest(5), canonicalSchemaDigest(4));
});
