/**
 * @input  依赖：Runtime 能力词表、cycle 类型与开局需求推导
 * @output 验证：三层能力交集、修复互审需求与文本 Runtime fail-fast 缺口
 * @pos    圆桌开局前能力判定的纯函数回归；不得依赖数据库或真实模型
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  declaredCapabilitiesForTransport,
  defaultPolicyCapabilitiesForTransport,
  deriveCycleRequirements,
  findCapabilityGaps,
  grantRuntimeCapabilities,
  type RuntimeCapabilitySnapshot,
} from "../src/index.js";

function snapshot(
  adapterId: string,
  transportKind: string,
): RuntimeCapabilitySnapshot {
  const declared = declaredCapabilitiesForTransport(transportKind);
  return {
    schemaVersion: 1,
    adapterId,
    actorId: adapterId,
    agentConfigRevision: 1,
    providerId: `provider-${adapterId}`,
    providerConfigRevision: 1,
    bindingRevision: `binding:${adapterId}`,
    transportKind,
    declared,
    granted: grantRuntimeCapabilities(
      declared,
      defaultPolicyCapabilitiesForTransport(transportKind),
    ),
  };
}

test("普通讨论只需要文本，CLI 与 sessionless Runtime 都能开局", () => {
  const requirements = deriveCycleRequirements({
    kind: "discussion",
    participants: ["claude", "kimi"],
  });
  assert.deepEqual(
    findCapabilityGaps(requirements, [
      snapshot("claude", "claude-resume"),
      snapshot("kimi", "openai-sessionless"),
    ]),
    [],
  );
});

test("修复互审只审查已有 commit/diff，当前只读 CLI 可以开局", () => {
  const requirements = deriveCycleRequirements({
    kind: "fix_review",
    participants: ["claude", "codex"],
  });
  assert.deepEqual(requirements.byParticipant.claude, [
    "text",
    "repository_read",
    "git_diff",
  ]);
  assert.deepEqual(requirements.byParticipant.codex, [
    "text",
    "repository_read",
    "git_diff",
  ]);
  assert.deepEqual(
    findCapabilityGaps(requirements, [
      snapshot("claude", "claude-resume"),
      snapshot("codex", "codex-resume"),
    ]),
    [],
  );
});

test("纯文本 Provider 仍不能参加需要读取 commit/diff 的修复互审", () => {
  const requirements = deriveCycleRequirements({
    kind: "fix_review",
    participants: ["kimi", "codex"],
  });
  assert.deepEqual(
    findCapabilityGaps(requirements, [
      snapshot("kimi", "openai-sessionless"),
      snapshot("codex", "codex-resume"),
    ]),
    [{
      adapterId: "kimi",
      missing: ["repository_read", "git_diff"],
    }],
  );
});

test("Council 只读 ToolLoop 让兼容 Provider 独立读取仓库与已提交 diff", () => {
  const requirements = deriveCycleRequirements({
    kind: "discussion",
    participants: ["deepseek"],
    task: { all: ["repository_read"] },
  });
  const toolLoop = snapshot("deepseek", "openai-tool-loop");
  assert.deepEqual(toolLoop.granted, ["text", "repository_read", "git_diff"]);
  assert.deepEqual(findCapabilityGaps(requirements, [toolLoop]), []);

  const fixRequirements = deriveCycleRequirements({
    kind: "fix_review",
    participants: ["deepseek"],
  });
  assert.deepEqual(findCapabilityGaps(fixRequirements, [toolLoop]), []);
  const kimiFixRequirements = deriveCycleRequirements({
    kind: "fix_review",
    participants: ["kimi"],
  });
  assert.deepEqual(
    findCapabilityGaps(
      kimiFixRequirements,
      [snapshot("kimi", "acp")],
    ),
    [],
  );
});

test("远程 Provider 自述能力不能突破 Council policy", () => {
  assert.deepEqual(
    grantRuntimeCapabilities(
      ["text", "repository_write", "shell_write", "git_commit"],
      defaultPolicyCapabilitiesForTransport("openai-sessionless"),
    ),
    ["text"],
  );
});

const SIDE_EFFECT_CAPABILITIES = [
  "repository_write",
  "shell_write",
  "tests",
  "git_commit",
] as const;

for (const transportKind of [
  "claude-resume",
  "codex-resume",
  "acp",
  "openai-tool-loop",
] as const) {
  test(`${transportKind} 的声明与 Council policy 独立，新增副作用能力不会自动获权`, () => {
    const declared = [
      ...declaredCapabilitiesForTransport(transportKind),
      ...SIDE_EFFECT_CAPABILITIES,
    ];
    const policy = defaultPolicyCapabilitiesForTransport(transportKind);

    assert.deepEqual(
      policy.filter((capability) =>
        SIDE_EFFECT_CAPABILITIES.some((sideEffect) => sideEffect === capability)
      ),
      [],
    );
    assert.deepEqual(
      grantRuntimeCapabilities(declared, policy),
      policy,
    );
    assert.notStrictEqual(
      declaredCapabilitiesForTransport(transportKind),
      defaultPolicyCapabilitiesForTransport(transportKind),
    );
  });
}

test("附件能力与 cycle baseline 做并集，不会被文本能力覆盖", () => {
  const requirements = deriveCycleRequirements({
    kind: "discussion",
    participants: ["kimi", "codex"],
    task: { all: ["media_read", "vision"] },
  });
  assert.deepEqual(
    requirements.byParticipant.kimi,
    ["text", "media_read", "vision"],
  );
  assert.deepEqual(
    findCapabilityGaps(requirements, [
      snapshot("kimi", "openai-sessionless"),
      snapshot("codex", "codex-resume"),
    ]),
    [
      { adapterId: "kimi", missing: ["media_read", "vision"] },
      { adapterId: "codex", missing: ["media_read", "vision"] },
    ],
  );
});
