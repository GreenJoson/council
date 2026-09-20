/**
 * @input  依赖：隔离 SQLite、真实 HTTP 服务与运行记录存储
 * @output 验证：审计不可覆盖/分页/脱敏、项目隔离、待办消退和迁移回滚
 * @pos    交付状态与可追溯证据的跨层回归
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { startHttpHarness } from "./http-harness.js";
import { RuntimeAuditStore, redactAuditText } from "../src/orchestration/runtime-audit-store.js";
import { WorkItemDelegationStore } from "../src/orchestration/work-item-delegation-store.js";
import { ModelRouterStore } from "../src/model-router-store.js";
import { migrateCouncilSchema } from "../src/schema-migrator.js";

test("运行记录分页不重叠、不泄露敏感参数，且禁止覆盖", async () => {
  assert.doesNotMatch(redactAuditText('"/Users/fixture user/测试/private.md" /tmp/测试/private.md Bearer example-secret'), /fixture user|测试|example-secret/u);
  const h = await startHttpHarness({}, []);
  try {
    const topic = h.database.createTopic({ title: "审计", question: "证据", constraints: [], createdByAlias: "human" });
    const other = h.database.createTopic({ title: "其他议题", question: "隔离", constraints: [], createdByAlias: "human" });
    assert(h.orchestration);
    for (let index = 0; index < 102; index++) h.orchestration.audit.append({
      topicId: topic.id, sourceKind: "run", sourceId: "run_test", attempt: index,
      kind: "tool.completed", data: { toolName: "read_file", summary: "https://example.com/x /Users/fixture/private token=example-secret 192.0.2.10" },
    });
    const url = `${h.baseUrl}/api/v1/topics/${topic.id}/runtime-audit?sourceKind=run&sourceId=run_test`;
    const first = await (await fetch(url)).json() as { data: ReturnType<RuntimeAuditStore["list"]> };
    assert.equal(first.data.events.length, 100);
    assert.equal(first.data.hasMore, true);
    assert.doesNotMatch(JSON.stringify(first), /example-secret|192\.0\.2\.10|\/Users\/fixture|example\.com/u);
    const second = await (await fetch(`${url}&after=${first.data.nextCursor}`)).json() as typeof first;
    assert.equal(second.data.events.length, 2);
    assert.equal(second.data.hasMore, false);
    assert(second.data.events[0]!.id > first.data.events.at(-1)!.id);
    assert.equal(h.orchestration.audit.list(other.id, "run", "run_test").events.length, 0);
    assert.equal((await fetch(`${url}&after=-1`)).status, 400);
    const raw = new DatabaseSync(h.databasePath);
    try {
      assert.throws(() => raw.exec("UPDATE runtime_audit_events SET data_json = '{}'"), /不可覆盖/u);
    } finally { raw.close(); }
  } finally { await h.close(); }
});

test("待处理按项目聚合，审核不冒充验收，新委派取代历史失败", async () => {
  const h = await startHttpHarness({}, []);
  const store = new WorkItemDelegationStore(h.databasePath, 5000);
  const router = new ModelRouterStore(h.databasePath, 5000);
  try {
    const topic = h.database.createTopic({ title: "待验收", question: "交付", constraints: [], projectPath: h.directory, createdByAlias: "human" });
    const other = h.database.createTopic({ title: "其他项目", question: "隔离", constraints: [], createdByAlias: "human" });
    h.database.createDecision({ topicId: other.id, title: "待确认", decision: "其他决策", rationale: "说明", alternatives: [], status: "proposed", createdByAlias: "human" });
    const decision = h.database.createDecision({ topicId: topic.id, title: "执行", decision: "实现", rationale: "证据", alternatives: [], status: "accepted", createdByAlias: "human" });
    const [item] = h.database.createWorkItems({ topicId: topic.id, decisionId: decision.id, items: [{ title: "任务", details: "检查提交" }], createdByAlias: "human" });
    assert(item);
    const agents = router.listAgents();
    const input = { topicId: topic.id, workItemId: item.id, supervisorAgentId: agents.find(a => a.actorId === "claude")!.id,
      executorAgentId: agents.find(a => a.actorId === "codex")!.id, permissionProfile: "workspace_write" as const,
      completionPolicy: "human" as const, acceptanceCriteria: "检查交付证据", maxAttempts: 2, now: new Date().toISOString() };
    store.create({ ...input, id: "delegation-failed" });
    store.update("delegation-failed", { status: "failed", error: "失败", now: input.now });
    assert(h.orchestration);
    assert.equal(h.orchestration.attention.list(h.directory)[0]?.failures, 1);
    store.create({ ...input, id: "delegation-reviewed" });
    store.update("delegation-reviewed", { status: "approved", headCommit: "a".repeat(40), now: input.now });
    const [attention] = h.orchestration.attention.list(h.directory);
    assert(attention);
    assert.equal(attention.topicId, topic.id);
    assert.equal(attention.failures, 0);
    assert.equal(attention.acceptance, 1);
    // SQL 触发器保护其他数据库客户端，不能只靠 HTTP 校验。
    const raw = new DatabaseSync(h.databasePath);
    try {
      assert.throws(() => raw.prepare("UPDATE work_items SET status='completed', completed_at=?, updated_by_actor_id='codex', status_note='自行声明' WHERE id=?").run(input.now, item.id), /人工填写/u);
    } finally { raw.close(); }
    h.database.updateWorkItem({ topicId: topic.id, workItemId: item.id, expectedVersion: item.version, status: "completed", statusNote: "人工检查提交符合标准", updatedByAlias: "human" });
    assert.deepEqual(h.orchestration.attention.list(h.directory), []);
    const response = await fetch(`${h.baseUrl}/api/v1/topics/${other.id}/work-attention`);
    const result = await response.json() as { data: Array<{ topicId: string; decisions: number }> };
    assert.deepEqual(result.data.map(row => [row.topicId, row.decisions]), [[other.id, 1]]);
  } finally { store.close(); router.close(); await h.close(); }
});

test("v14 升级新增验收与审计失败时完整回滚，再次迁移成功", async () => {
  const h = await startHttpHarness();
  try {
    const raw = new DatabaseSync(h.databasePath);
    raw.exec(`
      DROP TABLE runtime_audit_events;
      DROP TRIGGER trg_work_items_delegation_acceptance;
      ALTER TABLE work_item_delegations DROP COLUMN failure_code;
      ALTER TABLE work_item_delegations DROP COLUMN resumed_from_id;
      ALTER TABLE work_item_delegations DROP COLUMN acceptance_criteria;
      ALTER TABLE work_item_delegations DROP COLUMN completion_policy;
      DELETE FROM schema_migrations WHERE version > 14;
      PRAGMA user_version = 14;
    `);
    raw.close();
    await assert.rejects(migrateCouncilSchema(h.databasePath, 5000, { maxAttempts: 1, faultPoint: "before-commit" }), /故障注入/u);
    const verification = new DatabaseSync(h.databasePath);
    assert.equal((verification.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 14);
    assert.equal(verification.prepare("SELECT 1 FROM sqlite_master WHERE name='runtime_audit_events'").get(), undefined);
    verification.close();
    await migrateCouncilSchema(h.databasePath, 5000, { maxAttempts: 1 });
    assert.equal((await migrateCouncilSchema(h.databasePath, 5000, { maxAttempts: 1 })).migrated, false);
  } finally { await h.close(); }
});
