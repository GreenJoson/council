/**
 * @input  依赖：圆桌阶段与开局冻结的 Agent/Provider/Runtime 版本证据
 * @output 导出：最小 Runtime 能力词表、cycle 类型、需求推导、能力交集与 fail-fast 诊断
 * @pos    Agent / Provider / Runtime 三层在圆桌开局时的纯契约；不访问数据库或进程
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

export const DISCUSSION_CYCLE_KINDS = ["discussion", "fix_review"] as const;

export const RUNTIME_CAPABILITY_KEYS = [
  "text",
  "repository_read",
  "repository_write",
  "shell_read",
  "shell_write",
  "tests",
  "git_diff",
  "git_commit",
  "media_read",
  "vision",
  "session_resume",
] as const;

export type DiscussionCycleKind = (typeof DISCUSSION_CYCLE_KINDS)[number];
export type RuntimeCapabilityKey = (typeof RUNTIME_CAPABILITY_KEYS)[number];

export interface CycleTaskRequirements {
  /** 所有参与者都必须具备，例如读取本轮附件。 */
  all?: readonly RuntimeCapabilityKey[];
  /** 首位提案人额外需要。 */
  proposer?: readonly RuntimeCapabilityKey[];
  /** 其余评审额外需要。 */
  reviewers?: readonly RuntimeCapabilityKey[];
}

export interface FrozenCycleRequirements {
  schemaVersion: 1;
  cycleKind: DiscussionCycleKind;
  task: {
    all: RuntimeCapabilityKey[];
    proposer: RuntimeCapabilityKey[];
    reviewers: RuntimeCapabilityKey[];
  };
  byParticipant: Record<string, RuntimeCapabilityKey[]>;
}

export interface RuntimeCapabilitySnapshot {
  schemaVersion: 1;
  adapterId: string;
  actorId: string;
  agentConfigRevision: number;
  providerId: string;
  providerConfigRevision: number;
  bindingRevision: string;
  transportKind: string;
  /** Runtime 自述能力；不能直接当授权。 */
  declared: RuntimeCapabilityKey[];
  /** Council policy 与 Runtime 自述能力的交集。 */
  granted: RuntimeCapabilityKey[];
}

export interface CapabilityGap {
  adapterId: string;
  missing: RuntimeCapabilityKey[];
}

/** proposal / critique / rebuttal / synthesis 四段都必须能产生公开文本。 */
const STAGE_BASELINE_CAPABILITIES: readonly RuntimeCapabilityKey[] = ["text"];

const READ_ONLY_LOCAL_CAPABILITIES: readonly RuntimeCapabilityKey[] = [
  "text",
  "repository_read",
  "shell_read",
  "git_diff",
  "session_resume",
];

const FIX_PROPOSER_REQUIREMENTS: readonly RuntimeCapabilityKey[] = [
  "text",
  "repository_read",
  "repository_write",
  "shell_read",
  "shell_write",
  "tests",
  "git_diff",
  "git_commit",
];

const FIX_REVIEWER_REQUIREMENTS: readonly RuntimeCapabilityKey[] = [
  "text",
  "repository_read",
  "shell_read",
  "tests",
  "git_diff",
];

function uniqueCapabilities(
  values: readonly RuntimeCapabilityKey[],
): RuntimeCapabilityKey[] {
  const present = new Set(values);
  return RUNTIME_CAPABILITY_KEYS.filter((candidate) => present.has(candidate));
}

function requirementsForRole(
  kind: DiscussionCycleKind,
  role: "proposer" | "reviewer",
  task: CycleTaskRequirements,
): RuntimeCapabilityKey[] {
  const cycleRequirements = kind === "fix_review"
    ? role === "proposer"
      ? FIX_PROPOSER_REQUIREMENTS
      : FIX_REVIEWER_REQUIREMENTS
    : [];
  return uniqueCapabilities([
    ...STAGE_BASELINE_CAPABILITIES,
    ...cycleRequirements,
    ...(task.all ?? []),
    ...(role === "proposer" ? task.proposer ?? [] : task.reviewers ?? []),
  ]);
}

/** 由 transport 得到当前真实 Runtime 声明；兼容接口保持文本-only。 */
export function declaredCapabilitiesForTransport(
  transportKind: string,
): RuntimeCapabilityKey[] {
  if (transportKind === "claude-resume" || transportKind === "codex-resume") {
    return [...READ_ONLY_LOCAL_CAPABILITIES];
  }
  return [...STAGE_BASELINE_CAPABILITIES];
}

/**
 * Provider/Runtime 的声明只能收窄权限。哪怕远程端声称能运行 shell，
 * Council policy 没有允许也不会进入 granted。
 */
export function grantRuntimeCapabilities(
  declared: readonly RuntimeCapabilityKey[],
  policyAllowed: readonly RuntimeCapabilityKey[],
): RuntimeCapabilityKey[] {
  const allowed = new Set(policyAllowed);
  return uniqueCapabilities(declared.filter((capability) => allowed.has(capability)));
}

export function defaultPolicyCapabilitiesForTransport(
  transportKind: string,
): RuntimeCapabilityKey[] {
  return declaredCapabilitiesForTransport(transportKind);
}

export function deriveCycleRequirements(input: {
  kind: DiscussionCycleKind;
  participants: readonly string[];
  task?: CycleTaskRequirements;
}): FrozenCycleRequirements {
  const task = input.task ?? {};
  const byParticipant: Record<string, RuntimeCapabilityKey[]> = {};
  input.participants.forEach((participant, index) => {
    byParticipant[participant] = requirementsForRole(
      input.kind,
      index === 0 ? "proposer" : "reviewer",
      task,
    );
  });
  return {
    schemaVersion: 1,
    cycleKind: input.kind,
    task: {
      all: uniqueCapabilities(task.all ?? []),
      proposer: uniqueCapabilities(task.proposer ?? []),
      reviewers: uniqueCapabilities(task.reviewers ?? []),
    },
    byParticipant,
  };
}

export function findCapabilityGaps(
  requirements: FrozenCycleRequirements,
  snapshots: readonly RuntimeCapabilitySnapshot[],
): CapabilityGap[] {
  const snapshotsByAdapter = new Map(
    snapshots.map((snapshot) => [snapshot.adapterId, snapshot]),
  );
  const gaps: CapabilityGap[] = [];
  for (const [adapterId, required] of Object.entries(requirements.byParticipant)) {
    const granted = new Set(snapshotsByAdapter.get(adapterId)?.granted ?? []);
    const missing = required.filter((capability) => !granted.has(capability));
    if (missing.length > 0) {
      gaps.push({ adapterId, missing });
    }
  }
  return gaps;
}
