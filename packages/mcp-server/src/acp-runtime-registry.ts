/**
 * @input  依赖：Council 集中配置与统一 Runtime 能力词表
 * @output 导出：供应商无关的 ACP RuntimeDefinition、严格注册表与生产定义工厂
 * @pos    Agent/Provider 到 DelegatedRuntime 启动协议的唯一声明式映射；Runtime 本体不得写供应商特判
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  RUNTIME_CAPABILITY_KEYS,
  type RuntimeCapabilityKey,
} from "council-orchestrator";
import type { CouncilConfig } from "./types.js";

export interface AcpLaunchContext {
  cwd: string;
  model: string;
}

export interface AcpRuntimeDefinition {
  id: string;
  displayName: string;
  command: string;
  versionArgs: readonly string[];
  buildLaunchArgs(context: AcpLaunchContext): string[];
  /** Runtime 声明能力；实际授权必须再与 Council policy 取交集。 */
  declaredCapabilities: readonly RuntimeCapabilityKey[];
  limitationWhenUnavailable: string;
}

const DEFINITION_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

function validateDefinition(
  definition: AcpRuntimeDefinition,
): AcpRuntimeDefinition {
  if (
    !DEFINITION_ID_PATTERN.test(definition.id)
    || !definition.displayName.trim()
    || definition.displayName.length > 120
    || !definition.command.trim()
    || definition.command.includes("\0")
    || !definition.versionArgs.every((value) =>
      typeof value === "string" && !value.includes("\0"))
    || !definition.declaredCapabilities.every((capability) =>
      RUNTIME_CAPABILITY_KEYS.includes(capability))
    || !definition.declaredCapabilities.includes("text")
    || !definition.limitationWhenUnavailable.trim()
  ) {
    throw new Error(`ACP RuntimeDefinition ${definition.id || "<empty>"} 无效。`);
  }
  return Object.freeze({
    ...definition,
    versionArgs: Object.freeze([...definition.versionArgs]),
    declaredCapabilities: Object.freeze([...definition.declaredCapabilities]),
  });
}

export class AcpRuntimeRegistry {
  readonly #definitions = new Map<string, AcpRuntimeDefinition>();

  constructor(definitions: readonly AcpRuntimeDefinition[]) {
    for (const candidate of definitions) {
      const definition = validateDefinition(candidate);
      if (this.#definitions.has(definition.id)) {
        throw new Error(`ACP RuntimeDefinition 重复：${definition.id}。`);
      }
      this.#definitions.set(definition.id, definition);
    }
  }

  get(id: string): AcpRuntimeDefinition | undefined {
    return this.#definitions.get(id);
  }

  require(id: string): AcpRuntimeDefinition {
    const definition = this.get(id);
    if (!definition) {
      throw new Error(`ACP RuntimeDefinition 未注册：${id}。`);
    }
    return definition;
  }

  list(): AcpRuntimeDefinition[] {
    return [...this.#definitions.values()];
  }
}

export function createProductionAcpRuntimeRegistry(
  config: CouncilConfig,
): AcpRuntimeRegistry {
  return new AcpRuntimeRegistry([
    {
      id: "kimi-code",
      displayName: "Kimi Code",
      command: config.kimiCommand,
      versionArgs: ["--version"],
      buildLaunchArgs: ({ cwd, model }) => [
        "--work-dir",
        cwd,
        "--model",
        model,
        "--plan",
        "acp",
      ],
      declaredCapabilities: [
        "text",
        "repository_read",
        "git_diff",
        "session_resume",
      ],
      limitationWhenUnavailable:
        "Kimi Code 当前不可用或未登录；请检查本机安装和登录状态。",
    },
  ]);
}
