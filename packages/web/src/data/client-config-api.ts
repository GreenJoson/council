/**
 * @input  依赖：客户端接入 REST（/api/v1/settings/client-config）的未知 JSON data
 * @output 导出：ClientConfigStatus 等客户端接入类型与严格解析器 parseClientConfigList / parseClientConfigStatus
 * @pos    「客户端接入」面板的唯一运行时协议校验入口；类型与解析同处，不进 types/
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

export type ClientConfigClient = "claude" | "codex";
export type ClientConfigState = "not_applied" | "applied" | "drifted" | "missing";

export interface ClientConfigStatus {
  client: ClientConfigClient;
  /** 服务端已把家目录折叠成 "~" */
  configFile: string;
  skillsDir: string;
  state: ClientConfigState;
  appliedAt?: string;
  stashPath?: string;
  detail?: string;
  /** 仅写入响应：他人已有的 Skill 目录被备份时的告知 */
  notice?: string;
}

const CLIENTS: readonly ClientConfigClient[] = ["claude", "codex"];
const STATES: readonly ClientConfigState[] = ["not_applied", "applied", "drifted", "missing"];

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value) {
    throw new Error(`${key} 必须是非空字符串`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} 必须是字符串`);
  }
  return value;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], name: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${name} 取值无效`);
  }
  return value as T;
}

export function parseClientConfigStatus(value: unknown): ClientConfigStatus {
  const record = asRecord(value, "客户端接入状态");
  const status: ClientConfigStatus = {
    client: oneOf(requiredString(record, "client"), CLIENTS, "client"),
    configFile: requiredString(record, "configFile"),
    skillsDir: requiredString(record, "skillsDir"),
    state: oneOf(requiredString(record, "state"), STATES, "state"),
  };
  for (const key of ["appliedAt", "stashPath", "detail", "notice"] as const) {
    const optional = optionalString(record, key);
    if (optional !== undefined) {
      status[key] = optional;
    }
  }
  return status;
}

export function parseClientConfigList(value: unknown): ClientConfigStatus[] {
  const record = asRecord(value, "客户端接入列表");
  if (!Array.isArray(record.clients)) {
    throw new Error("clients 必须是数组");
  }
  return record.clients.map(parseClientConfigStatus);
}
