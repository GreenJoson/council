/**
 * @input  依赖：真实迁移库、CouncilDatabase 实施项读写与 council-orchestrator 收敛仓储
 * @output 验证：审核发现落成任务树、重复推进零写入、失败关闭兜底与复审判定回写
 * @pos    「审核意见 → 可认领任务 → 复审关闭」闭环的持久化验收
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  deriveCycleRequirements,
  readActiveDiscussionCycle,
  recordCycleTurn,
  resumeDiscussionCycleAfterFixes,
  startDiscussionCycle,
  type RecordedTurn,
} from "council-orchestrator";
import { CouncilDatabase } from "../src/database.js";
import { createReviewLedgerWriter } from "../src/orchestration/review-ledger.js";
import type { WorkItem } from "../src/types.js";

const NOW = "2026-01-01T00:00:00.000Z";
const PARTICIPANTS = ["claude", "codex"] as const;

function temporaryDatabase() {
  const directory = mkdtempSync(path.join(tmpdir(), "council-ledger-"));
  return {
    databasePath: path.join(directory, "council.sqlite3"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function capabilities() {
  return PARTICIPANTS.map((adapterId) => ({
    schemaVersion: 1 as const,
    adapterId,
    actorId: adapterId,
    agentConfigRevision: 1,
    providerId: `provider-${adapterId}`,
    providerConfigRevision: 1,
    bindingRevision: `test:${adapterId}`,
    transportKind: "test",
    declared: ["text" as const],
    granted: ["text" as const],
  }));
}

function findingsMessage(findings: unknown, stance = "blocking"): string {
  return [
    "读完 diff 的结论。",
    "",
    "```council-findings",
    JSON.stringify({ findings }),
    "```",
    "",
    "```council-verdict",
    JSON.stringify({ stance, summary: "见清单" }),
    "```",
  ].join("\n");
}

/** 建一个真实 fix_review 圆桌，返回议题、cycle 与写发言的辅助函数。 */
async function seed() {
  const fixture = temporaryDatabase();
  const database = await CouncilDatabase.open(fixture.databasePath, 5_000, {
    maxAttempts: 3,
  });
  const topic = database.createTopic({
    title: "认领链路",
    question: "认领接口是否安全？",
    constraints: [],
    createdByAlias: "human",
  });
  const raw = new DatabaseSync(fixture.databasePath);
  raw.exec("PRAGMA foreign_keys = ON;");
  const opened = startDiscussionCycle(raw, {
    topicId: topic.id,
    participants: PARTICIPANTS,
    kind: "fix_review",
    requirements: deriveCycleRequirements({
      kind: "fix_review",
      reviewScope: "commit",
      participants: PARTICIPANTS,
    }),
    runtimeCapabilities: capabilities(),
    roundBudget: 3,
    now: NOW,
  });
  let version = opened.cycle.stateVersion;

  return {
    database,
    raw,
    topicId: topic.id,
    cycleId: opened.cycle.id,
    ledger: createReviewLedgerWriter(database),
    /** 发一条公开消息并记成一次发言，返回状态机可见的 turn。 */
    speak(input: {
      agentId: string;
      stage: "proposal" | "critique";
      round: number;
      content: string;
      stance?: "agree" | "blocking" | "non_blocking";
    }): RecordedTurn {
      const message = database.createMessageAsActor({
        topicId: topic.id,
        actorId: input.agentId,
        kind: input.stage,
        content: input.content,
      });
      const view = recordCycleTurn(raw, {
        cycleId: opened.cycle.id,
        expectedVersion: version,
        turn: {
          agentId: input.agentId,
          stage: input.stage,
          round: input.round,
          stance: input.stance ?? "blocking",
          messageId: message.id,
        },
        now: NOW,
      });
      version = view.cycle.stateVersion;
      return {
        agentId: input.agentId,
        stage: input.stage,
        round: input.round,
        stance: input.stance ?? "blocking",
        messageId: message.id,
      };
    },
    /** 外部 Agent 提交修复后开下一轮复审；顺带验证轮次预算会跟着抬高。 */
    submitFixes(): void {
      const current = readActiveDiscussionCycle(raw, topic.id);
      assert.ok(current);
      const resumed = resumeDiscussionCycleAfterFixes(raw, {
        cycleId: opened.cycle.id,
        expectedVersion: current.cycle.stateVersion,
        now: NOW,
      });
      version = resumed.cycle.stateVersion;
    },
    close() {
      raw.close();
      database.close();
      fixture.cleanup();
    },
  };
}

function leaves(items: readonly WorkItem[]): WorkItem[] {
  return items.filter(
    (item) => !items.some((candidate) => candidate.parentId === item.id),
  );
}

test("审核发现落成任务树：批次是父级，每条发现是可认领的叶子", async () => {
  const fixture = await seed();
  try {
    const turn = fixture.speak({
      agentId: "claude",
      stage: "proposal",
      round: 1,
      content: findingsMessage([
        {
          title: "认领接口缺少版本校验",
          severity: "blocking",
          file: "src/database.ts",
          line: 1100,
          evidence: "两个 Agent 同时认领时后写入方静默覆盖",
          suggestion: "改为 CAS 更新并返回冲突",
        },
        { title: "注释与实现不符", severity: "non_blocking", evidence: "写的是旧字段名" },
      ]),
    });

    fixture.ledger.syncCycleLedger({
      topicId: fixture.topicId,
      cycleId: fixture.cycleId,
      turns: [turn],
    });

    const items = fixture.database.listWorkItems({ topicId: fixture.topicId });
    assert.equal(items.length, 3);
    const batch = items.find((item) => item.parentId === undefined);
    assert.ok(batch);
    assert.equal(batch.title, "审核发现 · R1 · claude");
    assert.equal(batch.origin, "review_finding");
    assert.equal(batch.sourceCycleId, fixture.cycleId);
    // 审核发现不需要 accepted 决策做锚点：问题在有决策之前就已经存在。
    assert.equal(batch.decisionId, undefined);

    const children = items.filter((item) => item.parentId === batch.id);
    assert.equal(children.length, 2);
    const blocking = children.find((item) => item.severity === "blocking");
    assert.ok(blocking);
    assert.equal(blocking.title, "认领接口缺少版本校验");
    assert.equal(blocking.reviewRound, 1);
    assert.equal(blocking.sourceMessageId, turn.messageId);
    assert.ok(blocking.details.includes("src/database.ts:1100"));
    assert.ok(blocking.details.includes("改为 CAS 更新并返回冲突"));

    // 完成度只数叶子：父批次再被数一次，「0 / 3」会凭空多出一个永远关不掉的分母。
    const progress = fixture.database
      .getTopicDetail(fixture.topicId, 10)
      .topic.workItemProgress;
    assert.deepEqual(progress, {
      total: 2,
      completed: 0,
      blocked: 0,
      openBlockingFindings: 1,
    });
  } finally {
    fixture.close();
  }
});

test("重复推进不重复录入：同一条发言只落一次账", async () => {
  const fixture = await seed();
  try {
    const turn = fixture.speak({
      agentId: "claude",
      stage: "proposal",
      round: 1,
      content: findingsMessage([
        { title: "缺少乐观锁", severity: "blocking", evidence: "并发覆盖" },
      ]),
    });
    const input = {
      topicId: fixture.topicId,
      cycleId: fixture.cycleId,
      turns: [turn],
    };
    fixture.ledger.syncCycleLedger(input);
    const first = fixture.database.listWorkItems({ topicId: fixture.topicId });
    fixture.ledger.syncCycleLedger(input);
    fixture.ledger.syncCycleLedger(input);
    const again = fixture.database.listWorkItems({ topicId: fixture.topicId });

    assert.equal(again.length, first.length);
    // version 不变才算真正幂等：无条件回写会让乐观锁永远撞车。
    assert.deepEqual(
      again.map((item) => `${item.id}:${String(item.version)}`),
      first.map((item) => `${item.id}:${String(item.version)}`),
    );
  } finally {
    fixture.close();
  }
});

test("失败关闭：尾块非法或判了阻断却没列条目，都补一条阻断任务", async () => {
  const fixture = await seed();
  try {
    const malformed = fixture.speak({
      agentId: "claude",
      stage: "proposal",
      round: 1,
      content: [
        "```council-findings",
        '{"findings":[{"title":"缺少严重度","evidence":"x"}]}',
        "```",
      ].join("\n"),
    });
    const silent = fixture.speak({
      agentId: "codex",
      stage: "critique",
      round: 1,
      content: [
        "```council-verdict",
        JSON.stringify({ stance: "blocking", summary: "迁移脚本没有回滚路径" }),
        "```",
      ].join("\n"),
    });

    fixture.ledger.syncCycleLedger({
      topicId: fixture.topicId,
      cycleId: fixture.cycleId,
      turns: [malformed, silent],
    });

    const open = leaves(fixture.database.listWorkItems({ topicId: fixture.topicId }));
    assert.equal(open.length, 2);
    assert.ok(open.every((item) => item.severity === "blocking"));
    assert.ok(open.some((item) => item.title.includes("尾块格式非法")));
    assert.ok(open.some((item) => item.title === "迁移脚本没有回滚路径"));
  } finally {
    fixture.close();
  }
});

test("审过没问题不建空批次：空父级会变成关不掉的分母", async () => {
  const fixture = await seed();
  try {
    const clean = fixture.speak({
      agentId: "claude",
      stage: "proposal",
      round: 1,
      stance: "agree",
      content: findingsMessage([], "agree"),
    });
    fixture.ledger.syncCycleLedger({
      topicId: fixture.topicId,
      cycleId: fixture.cycleId,
      turns: [clean],
    });
    assert.deepEqual(
      fixture.database.listWorkItems({ topicId: fixture.topicId }),
      [],
    );
  } finally {
    fixture.close();
  }
});

test("复审判定回写：fixed 关闭条目，still_broken 重新打开且不越权改别人的任务", async () => {
  const fixture = await seed();
  try {
    const first = fixture.speak({
      agentId: "claude",
      stage: "proposal",
      round: 1,
      content: findingsMessage([
        { title: "缺少乐观锁", severity: "blocking", evidence: "并发覆盖" },
        { title: "缺少回滚路径", severity: "blocking", evidence: "迁移失败无法退回" },
      ]),
    });
    fixture.ledger.syncCycleLedger({
      topicId: fixture.topicId,
      cycleId: fixture.cycleId,
      turns: [first],
    });
    const open = leaves(fixture.database.listWorkItems({ topicId: fixture.topicId }));
    const fixed = open.find((item) => item.title === "缺少乐观锁");
    const broken = open.find((item) => item.title === "缺少回滚路径");
    assert.ok(fixed && broken);
    assert.deepEqual(
      fixture.ledger.readOpenFindings(fixture.topicId, fixture.cycleId)
        .map((item) => item.workItemId)
        .sort(),
      [fixed.id, broken.id].sort(),
    );

    fixture.submitFixes();
    const reReview = fixture.speak({
      agentId: "codex",
      stage: "critique",
      round: 2,
      content: [
        "复审结果如下。",
        "",
        "```council-review-result",
        JSON.stringify({
          results: [
            { workItemId: fixed.id, verdict: "fixed", note: "已改成 CAS 更新" },
            { workItemId: broken.id, verdict: "still_broken", note: "回滚仍未覆盖" },
            // 别的圆桌或用户手工拆的条目不该被复审判定波及。
            { workItemId: "work_item_不存在的条目", verdict: "fixed", note: "越权" },
          ],
        }),
        "```",
        "",
        "```council-verdict",
        JSON.stringify({ stance: "blocking", summary: "还差一条" }),
        "```",
      ].join("\n"),
    });
    fixture.ledger.syncCycleLedger({
      topicId: fixture.topicId,
      cycleId: fixture.cycleId,
      turns: [first, reReview],
    });

    const after = fixture.database.listWorkItems({ topicId: fixture.topicId });
    assert.equal(after.find((item) => item.id === fixed.id)?.status, "completed");
    const reopened = after.find((item) => item.id === broken.id);
    assert.equal(reopened?.status, "blocked");
    assert.ok(reopened?.statusNote?.includes("回滚仍未覆盖"));
    // 父批次状态由子条目派生：一条完成一条受阻 → 受阻优先。
    assert.equal(
      after.find((item) => item.parentId === undefined)?.status,
      "blocked",
    );
    assert.deepEqual(
      fixture.ledger.readOpenFindings(fixture.topicId, fixture.cycleId)
        .map((item) => item.workItemId),
      [broken.id],
    );

    // 复审判定会随每次推进重复读到；状态已经一致就必须零写入。
    const versions = fixture.database
      .listWorkItems({ topicId: fixture.topicId })
      .map((item) => `${item.id}:${String(item.version)}`);
    fixture.ledger.syncCycleLedger({
      topicId: fixture.topicId,
      cycleId: fixture.cycleId,
      turns: [first, reReview],
    });
    assert.deepEqual(
      fixture.database
        .listWorkItems({ topicId: fixture.topicId })
        .map((item) => `${item.id}:${String(item.version)}`),
      versions,
    );
  } finally {
    fixture.close();
  }
});
