/**
 * @input  依赖：纯收敛状态机与结构化尾块解析
 * @output 验证：四段推进顺序、阻塞回环、轮次预算硬停止与失败关闭的立场推定
 * @pos    圆桌"能不能自己走到结论"的核心验收；不触碰数据库
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  ConvergenceStateError,
  buildStageInstruction,
  nextCycleAction,
  parseAgentReply,
  stageAfterAction,
  type ConvergenceState,
  type CycleAction,
  type CycleTurn,
  type DebateStage,
  type VerdictStance,
} from "../src/index.js";

const PARTICIPANTS = ["claude", "codex", "kimi"] as const;

function turn(
  agentId: string,
  stage: DebateStage,
  round: number,
  stance: VerdictStance = "agree",
): CycleTurn {
  return { agentId, stage, round, stance };
}

function state(overrides: Partial<ConvergenceState> = {}): ConvergenceState {
  return {
    stage: "proposal",
    currentRound: 1,
    roundBudget: 3,
    participants: PARTICIPANTS,
    turns: [],
    hasOpenQuestion: false,
    ...overrides,
  };
}

/** 按状态机自己的指示推进，直到出现非 invoke 动作，返回发言顺序。 */
function driveUntilSettled(
  initial: ConvergenceState,
  stanceOf: (action: Extract<CycleAction, { kind: "invoke" }>) => VerdictStance,
  maxSteps = 40,
): { transcript: string[]; final: CycleAction } {
  let current = initial;
  const transcript: string[] = [];
  for (let step = 0; step < maxSteps; step += 1) {
    const action = nextCycleAction(current);
    if (action.kind !== "invoke") {
      return { transcript, final: action };
    }
    transcript.push(`${action.agentId}/${action.stage}/${String(action.round)}`);
    current = {
      ...current,
      stage: stageAfterAction(action),
      currentRound: action.round,
      turns: [
        ...current.turns,
        turn(action.agentId, action.stage, action.round, stanceOf(action)),
      ],
    };
  }
  throw new Error("状态机未在步数上限内停止。");
}

test("全体同意时按 提案→逐个评审→收敛 推进，不产生多余轮次", () => {
  const { transcript, final } = driveUntilSettled(state(), () => "agree");
  assert.deepEqual(transcript, [
    "claude/proposal/1",
    "codex/critique/1",
    "kimi/critique/1",
  ]);
  assert.deepEqual(final, { kind: "converge" });
});

test("评审顺序按冻结名册固定，同一状态重放得到同一个动作", () => {
  const base = state({
    stage: "critique",
    turns: [turn("claude", "proposal", 1)],
  });
  const first = nextCycleAction(base);
  assert.deepEqual(first, {
    kind: "invoke",
    agentId: "codex",
    stage: "critique",
    messageKind: "critique",
    round: 1,
  });
  assert.deepEqual(nextCycleAction(base), first, "纯函数必须可重放");
});

test("非阻塞异议只记录不拦截，仍然直接进入收敛", () => {
  const { transcript, final } = driveUntilSettled(
    state(),
    (action) => (action.stage === "critique" ? "non_blocking" : "agree"),
  );
  assert.equal(transcript.length, 3);
  assert.deepEqual(final, { kind: "converge" });
});

test("阻塞异议触发反驳，并且必须由评审再看一轮而不是提案人自己宣布解决", () => {
  let critiqueRounds = 0;
  const { transcript, final } = driveUntilSettled(state(), (action) => {
    if (action.stage !== "critique") {
      return "agree";
    }
    critiqueRounds += 1;
    // 第一轮 codex 阻塞，反驳之后所有人放行。
    return critiqueRounds === 1 ? "blocking" : "agree";
  });
  assert.deepEqual(transcript, [
    "claude/proposal/1",
    "codex/critique/1",
    "kimi/critique/1",
    "claude/rebuttal/1",
    "codex/critique/2",
    "kimi/critique/2",
  ]);
  assert.deepEqual(final, { kind: "converge" });
});

test("阻塞持续到预算用尽时放弃，不把没人认可的方案写成结论", () => {
  const { transcript, final } = driveUntilSettled(
    state({ roundBudget: 2 }),
    (action) => (action.stage === "critique" ? "blocking" : "agree"),
  );
  assert.deepEqual(final, { kind: "abandon", reason: "round_budget_exhausted" });
  assert.ok(
    transcript.every((entry) => !entry.includes("synthesis")),
    "放弃路径不允许产出 synthesis",
  );
  assert.equal(
    transcript.filter((entry) => entry.includes("rebuttal")).length,
    2,
    "两轮预算应各给提案人一次正面回应机会",
  );
});

test("收敛后由提案人产出 synthesis，随后不再有可调用动作", () => {
  const converged = state({
    stage: "synthesis",
    turns: [
      turn("claude", "proposal", 1),
      turn("codex", "critique", 1),
      turn("kimi", "critique", 1),
    ],
  });
  const action = nextCycleAction(converged);
  assert.deepEqual(action, {
    kind: "invoke",
    agentId: "claude",
    stage: "synthesis",
    messageKind: "synthesis",
    round: 1,
  });
  assert.deepEqual(
    nextCycleAction({
      ...converged,
      turns: [...converged.turns, turn("claude", "synthesis", 1)],
    }),
    { kind: "done" },
  );
});

test("未答问题压过一切推进，回答后从冻结的回归阶段原样继续", () => {
  const asked = state({
    stage: "awaiting_user",
    resumeStage: "critique",
    hasOpenQuestion: true,
    turns: [turn("claude", "proposal", 1), turn("codex", "critique", 1)],
  });
  assert.deepEqual(nextCycleAction(asked), { kind: "await_user" });
  assert.deepEqual(
    nextCycleAction({ ...asked, hasOpenQuestion: false }),
    {
      kind: "invoke",
      agentId: "kimi",
      stage: "critique",
      messageKind: "critique",
      round: 1,
    },
    "恢复后应接着轮到尚未发言的评审，而不是重来一遍",
  );
});

test("只有提案人时没有互审可言，直接收敛", () => {
  const { transcript, final } = driveUntilSettled(
    state({ participants: ["claude"] }),
    () => "agree",
  );
  assert.deepEqual(transcript, ["claude/proposal/1"]);
  assert.deepEqual(final, { kind: "converge" });
});

test("非法收敛状态直接抛错，不静默走进某个分支", () => {
  for (const invalid of [
    state({ participants: [] }),
    state({ participants: ["claude", "claude"] }),
    state({ roundBudget: 0 }),
    state({ currentRound: 0 }),
    state({ currentRound: 4, roundBudget: 3 }),
    state({ stage: "awaiting_user" }),
  ]) {
    assert.throws(() => nextCycleAction(invalid), ConvergenceStateError);
  }
});

test("结构化尾块解析出立场与阻塞提问", () => {
  const reply = parseAgentReply([
    "结论：这个迁移缺回滚路径。",
    "",
    "```council-verdict",
    '{"stance":"blocking","summary":"缺回滚路径"}',
    "```",
    "",
    "```council-question",
    '{"question":"定价按订阅还是按次？","rationale":"两条路径不可逆","options":["订阅","按次"]}',
    "```",
  ].join("\n"));
  assert.equal(reply.verdictDeclared, true);
  assert.deepEqual(reply.verdict, { stance: "blocking", summary: "缺回滚路径" });
  assert.deepEqual(reply.question, {
    question: "定价按订阅还是按次？",
    rationale: "两条路径不可逆",
    options: ["订阅", "按次"],
  });
});

test("尾块缺失或非法一律推定为 blocking，格式错误不能把讨论推进到结论", () => {
  const cases = [
    "完全没有尾块，只有正文。",
    "```council-verdict\n不是 JSON\n```",
    '```council-verdict\n{"stance":"looks-good","summary":"行"}\n```',
    '```council-verdict\n{"stance":"agree"}\n```',
    '```council-verdict\n{"stance":"agree","summary":"   "}\n```',
    '```council-verdict\n["agree"]\n```',
  ];
  for (const content of cases) {
    const reply = parseAgentReply(content);
    assert.equal(reply.verdict.stance, "blocking", content);
    assert.equal(reply.verdictDeclared, false, content);
  }
});

test("Agent 复述协议示例后再给结论时，取最后一个尾块", () => {
  const reply = parseAgentReply([
    "协议要求我这样回复：",
    "",
    "```council-verdict",
    '{"stance":"blocking","summary":"这是示例"}',
    "```",
    "",
    "我的真实结论：",
    "",
    "```council-verdict",
    '{"stance":"agree","summary":"证据充分"}',
    "```",
  ].join("\n"));
  assert.deepEqual(reply.verdict, { stance: "agree", summary: "证据充分" });
});

test("下发给 Agent 的尾块规格与解析器认的围栏一致", () => {
  const instruction = buildStageInstruction({
    stage: "critique",
    round: 1,
    roundBudget: 3,
    reviewers: ["codex"],
    proposer: "claude",
  });
  // 指令里写的围栏名就是解析器要找的围栏名——两边漂移会让全体 Agent 一起被判 blocking。
  for (const fence of ["council-verdict", "council-question"]) {
    assert.ok(
      instruction.includes(`\`\`\`${fence}\n`),
      `指令必须给出 ${fence} 围栏示例`,
    );
  }
  for (const stance of ["agree", "non_blocking", "blocking"]) {
    assert.ok(instruction.includes(stance), `指令必须说明 ${stance} 的含义`);
  }

  // 严格按规格写出来的回复必须能被解析。
  const reply = parseAgentReply([
    "结论：可以推进。",
    "",
    "```council-verdict",
    '{"stance":"agree","summary":"证据充分"}',
    "```",
  ].join("\n"));
  assert.equal(reply.verdictDeclared, true);
  assert.equal(reply.verdict.stance, "agree");

  // 指令模板本身不是立场声明，占位符不能被当成 agree 读进去。
  assert.equal(parseAgentReply(instruction).verdict.stance, "blocking");
});

test("提问尾块越界时整体丢弃，不产出半个问题", () => {
  for (const content of [
    '```council-question\n{"question":"选哪个？","rationale":"因为"}\n```',
    '```council-question\n{"question":"选哪个？","rationale":"因为","options":"订阅"}\n```',
    `\`\`\`council-question\n{"question":"选哪个？","rationale":"因为","options":${
      JSON.stringify(Array.from({ length: 7 }, (_, index) => `选项${String(index)}`))
    }}\n\`\`\``,
    `\`\`\`council-question\n{"question":"${"长".repeat(1_001)}","rationale":"因为","options":[]}\n\`\`\``,
  ]) {
    assert.equal(parseAgentReply(content).question, undefined, content.slice(0, 40));
  }
});

test("修复自述必须给出像 commit 的引用，分支名和残缺尾块一律不认", () => {
  const good = parseAgentReply([
    "已修复越界读。",
    "",
    "```council-fix",
    '{"commit":"A1B2C3D4E5F6","summary":"修正边界判断"}',
    "```",
    "",
    "```council-verdict",
    '{"stance":"agree","summary":"已提交待复审"}',
    "```",
  ].join("\n"));
  // 大小写归一化：git 对象名是小写，复审者要能直接把它拼进 git show。
  assert.deepEqual(good.fix, { commit: "a1b2c3d4e5f6", summary: "修正边界判断" });

  for (const raw of [
    '{"commit":"main","summary":"修好了"}',
    '{"commit":"v1.2.0","summary":"修好了"}',
    '{"commit":"abc123","summary":"太短不足以定位"}',
    '{"commit":"a1b2c3d4","summary":"   "}',
    '{"summary":"没给引用"}',
  ]) {
    const reply = parseAgentReply([
      "```council-fix",
      raw,
      "```",
      "",
      "```council-verdict",
      '{"stance":"agree","summary":"立场"}',
      "```",
    ].join("\n"));
    assert.equal(reply.fix, undefined, raw);
  }
});

test("已提交修复互审强制 commit，普通讨论允许独立读取未提交工作区", () => {
  const withDiff = buildStageInstruction({
    stage: "critique",
    round: 2,
    roundBudget: 3,
    reviewers: ["codex"],
    proposer: "claude",
    reviewedCommitRef: "a1b2c3d4e5f6",
    requiresCommitRef: true,
  });
  assert.ok(withDiff.includes("git show a1b2c3d4e5f6"), "复审者必须拿到可执行的读 diff 指令");
  assert.ok(withDiff.includes("只读复审"), "复审者不得改代码");

  const missingCommittedDiff = buildStageInstruction({
    stage: "critique",
    round: 1,
    roundBudget: 3,
    reviewers: ["codex"],
    proposer: "claude",
    requiresCommitRef: true,
  });
  for (const instruction of [withDiff, missingCommittedDiff]) {
    assert.ok(instruction.includes("council-fix"), "评审必须知道该向对方要什么");
    assert.ok(instruction.includes("验证不了的改动"), "缺引用时的判定规则必须无条件下发");
  }

  const workspaceReview = buildStageInstruction({
    stage: "critique",
    round: 1,
    roundBudget: 3,
    reviewers: ["codex"],
    proposer: "claude",
  });
  assert.ok(workspaceReview.includes("工作区 diff"));
  assert.ok(workspaceReview.includes("可变工作区快照"));
  assert.ok(!workspaceReview.includes("council-fix"));

  // 主审只传递交互式开发任务产生的 commit；Council headless 回合不得写代码。
  const leadReviewer = buildStageInstruction({
    stage: "rebuttal",
    round: 2,
    roundBudget: 3,
    reviewers: ["codex"],
    proposer: "claude",
    requiresCommitRef: true,
  });
  assert.ok(
    leadReviewer.includes("```council-fix\n"),
    "只读主审必须传递被审 commit 引用",
  );
  assert.ok(leadReviewer.includes("不要修改文件"), "只读主审不得被诱导修改代码");
  assert.ok(
    !leadReviewer.includes("先自审并提交"),
    "只读主审不得收到提交指令",
  );
  assert.ok(
    !buildStageInstruction({
      stage: "critique",
      round: 2,
      roundBudget: 3,
      reviewers: ["codex"],
      proposer: "claude",
      requiresCommitRef: true,
    }).includes("```council-fix\n"),
    "独立评审只消费主审传来的 commit，不重复生成引用规格",
  );
});
