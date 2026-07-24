/**
 * @input  依赖：SQLite actor identity/alias 行与冻结快照 JSON
 * @output 导出：ActorId、ActorSnapshot、种子与严格解析/序列化函数
 * @pos    Council 动态参与者身份的唯一领域正本；品牌元数据不属于本层
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

export const ACTOR_SNAPSHOT_SCHEMA_VERSION = 1;

export type ActorId = string;
export type ActorType = "human" | "system" | "agent" | "legacy";
export type ActorStatus = "active" | "needs_review" | "inactive";
export type ActorAliasKind = "canonical" | "legacy" | "adapter";

export interface ActorSnapshot {
  schemaVersion: typeof ACTOR_SNAPSHOT_SCHEMA_VERSION;
  actorId: ActorId;
  slug: string;
  displayName: string;
  shortName: string;
  role: string;
}

export interface ActorIdentity extends ActorSnapshot {
  actorType: ActorType;
  status: ActorStatus;
}

export interface ActorSeed {
  id: ActorId;
  slug: string;
  displayName: string;
  shortName: string;
  role: string;
  actorType: ActorType;
  status: ActorStatus;
  aliases: readonly Readonly<{
    alias: string;
    kind: ActorAliasKind;
  }>[];
}

export const ACTOR_SEEDS: readonly ActorSeed[] = [
  {
    id: "human",
    slug: "human",
    displayName: "User",
    shortName: "U",
    role: "决策者",
    actorType: "human",
    status: "active",
    aliases: [
      { alias: "human", kind: "canonical" },
      { alias: "user", kind: "legacy" },
    ],
  },
  {
    id: "council",
    slug: "council",
    displayName: "Council",
    shortName: "CO",
    role: "综合协调",
    actorType: "system",
    status: "active",
    aliases: [
      { alias: "council", kind: "canonical" },
      { alias: "chair", kind: "legacy" },
    ],
  },
  {
    id: "claude",
    slug: "claude",
    displayName: "Claude",
    shortName: "CL",
    role: "方案顾问",
    actorType: "agent",
    status: "active",
    aliases: [
      { alias: "claude", kind: "canonical" },
      { alias: "claude-code", kind: "adapter" },
    ],
  },
  {
    id: "codex",
    slug: "codex",
    displayName: "Codex",
    shortName: "CX",
    role: "代码审查",
    actorType: "agent",
    status: "active",
    aliases: [
      { alias: "codex", kind: "canonical" },
      { alias: "codex-cli", kind: "adapter" },
    ],
  },
  {
    id: "deepseek",
    slug: "deepseek",
    displayName: "DeepSeek",
    shortName: "DS",
    role: "模型顾问",
    actorType: "agent",
    status: "active",
    aliases: [{ alias: "deepseek", kind: "canonical" }],
  },
  {
    id: "kimi",
    slug: "kimi",
    displayName: "Kimi",
    shortName: "KI",
    role: "模型顾问",
    actorType: "agent",
    status: "active",
    aliases: [{ alias: "kimi", kind: "canonical" }],
  },
  {
    id: "legacy-unknown",
    slug: "legacy-unknown",
    displayName: "Legacy unknown",
    shortName: "?",
    role: "待人工识别的历史参与者",
    actorType: "legacy",
    status: "needs_review",
    aliases: [{ alias: "other", kind: "legacy" }],
  },
] as const;

export function toActorSnapshot(identity: ActorIdentity): ActorSnapshot {
  return {
    schemaVersion: ACTOR_SNAPSHOT_SCHEMA_VERSION,
    actorId: identity.actorId,
    slug: identity.slug,
    displayName: identity.displayName,
    shortName: identity.shortName,
    role: identity.role,
  };
}

export function serializeActorSnapshot(snapshot: ActorSnapshot): string {
  return JSON.stringify(snapshot);
}

export function parseActorSnapshot(value: string): ActorSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Actor snapshot 不是有效 JSON。");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Actor snapshot 必须是对象。");
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.schemaVersion !== ACTOR_SNAPSHOT_SCHEMA_VERSION ||
    typeof record.actorId !== "string" ||
    !record.actorId ||
    typeof record.slug !== "string" ||
    !record.slug ||
    typeof record.displayName !== "string" ||
    !record.displayName ||
    typeof record.shortName !== "string" ||
    !record.shortName ||
    typeof record.role !== "string" ||
    !record.role
  ) {
    throw new Error("Actor snapshot 字段无效。");
  }
  return {
    schemaVersion: ACTOR_SNAPSHOT_SCHEMA_VERSION,
    actorId: record.actorId,
    slug: record.slug,
    displayName: record.displayName,
    shortName: record.shortName,
    role: record.role,
  };
}
