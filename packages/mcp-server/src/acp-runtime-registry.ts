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
  agentCommand: string;
  versionArgs: readonly string[];
  modelSelection: "launch-args" | "session-config";
  buildLaunchArgs(context: AcpLaunchContext): string[];
  /** Runtime 声明能力；实际授权必须再与 Council policy 取交集。 */
  declaredCapabilities: readonly RuntimeCapabilityKey[];
  limitationWhenUnavailable: string;
}

const DEFINITION_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const MAX_PROCESS_ARGUMENT_CHARS = 4_096;
const MAX_PROCESS_ARGUMENTS = 64;

function isSafeProcessArgument(value: unknown): value is string {
  return typeof value === "string"
    && !value.includes("\0")
    && value.length <= MAX_PROCESS_ARGUMENT_CHARS;
}

/**
 * 校验真正交给 spawn 的那份 argv。
 *
 * `versionArgs` 是写死在定义里的字面量，`buildLaunchArgs` 的输出却嵌着
 * 用户配置的 model 与项目路径——只查前者不查后者，等于查了不会变的那半边。
 */
function checkedProcessArguments(
  definitionId: string,
  args: readonly string[],
): string[] {
  if (
    !Array.isArray(args)
    || args.length > MAX_PROCESS_ARGUMENTS
    || !args.every(isSafeProcessArgument)
  ) {
    throw new Error(`ACP RuntimeDefinition ${definitionId} 生成了非法启动参数。`);
  }
  return [...args];
}

function validateDefinition(
  definition: AcpRuntimeDefinition,
): AcpRuntimeDefinition {
  if (
    !DEFINITION_ID_PATTERN.test(definition.id)
    || !definition.displayName.trim()
    || definition.displayName.length > 120
    || !definition.agentCommand.trim()
    || definition.agentCommand.includes("\0")
    || !["launch-args", "session-config"].includes(definition.modelSelection)
    || definition.versionArgs.length > MAX_PROCESS_ARGUMENTS
    || !definition.versionArgs.every(isSafeProcessArgument)
    || !definition.declaredCapabilities.every((capability) =>
      RUNTIME_CAPABILITY_KEYS.includes(capability))
    || !definition.declaredCapabilities.includes("text")
    || !definition.limitationWhenUnavailable.trim()
  ) {
    throw new Error(`ACP RuntimeDefinition ${definition.id || "<empty>"} 无效。`);
  }
  const buildLaunchArgs = definition.buildLaunchArgs.bind(definition);
  return Object.freeze({
    ...definition,
    // 注册表出口即校验点：拿到 definition 的人无需再自己检查 argv。
    buildLaunchArgs: (context: AcpLaunchContext) =>
      checkedProcessArguments(definition.id, buildLaunchArgs(context)),
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
      agentCommand: config.kimiAcpCommand,
      versionArgs: ["--version"],
      modelSelection: "session-config",
      /*
       * `--plan` 是 Kimi 的计划模式（只读），必须作为全局参数排在 `acp`
       * 子命令之前——`kimi acp` 自身不接受任何选项。它与 Claude 的
       * `--permission-mode plan`、Codex 的 `--sandbox read-only` 同级，
       * 是 Council headless 只读边界在启动参数上的那一层，删掉即降级。
       */
      buildLaunchArgs: () => ["--plan", "acp"],
      declaredCapabilities: [
        "text",
        "repository_read",
        "git_diff",
        "session_resume",
      ],
      limitationWhenUnavailable:
        "Kimi Code 当前不可用或未登录；请检查本机安装和登录状态。",
    },
    {
      id: "gemini-cli",
      displayName: "Gemini CLI",
      agentCommand: config.geminiAcpCommand,
      versionArgs: ["--version"],
      modelSelection: "launch-args",
      buildLaunchArgs: ({ model }) => ["--model", model, "--acp"],
      declaredCapabilities: [
        "text",
        "repository_read",
        "git_diff",
        "session_resume",
      ],
      limitationWhenUnavailable:
        "Gemini CLI ACP 当前不可用或未登录；请检查本机安装和登录状态。",
    },
    {
      id: "grok-build",
      displayName: "Grok Build",
      agentCommand: config.grokAcpCommand,
      versionArgs: ["--version"],
      modelSelection: "launch-args",
      buildLaunchArgs: ({ cwd, model }) => [
        "--no-auto-update",
        "--cwd",
        cwd,
        "--model",
        model,
        "agent",
        "stdio",
      ],
      declaredCapabilities: [
        "text",
        "repository_read",
        "git_diff",
        "session_resume",
      ],
      limitationWhenUnavailable:
        "Grok Build ACP 当前不可用或未登录；请检查本机安装和登录状态。",
    },
    {
      id: "codex-agent",
      displayName: "Codex ACP",
      agentCommand: config.codexAcpCommand,
      versionArgs: ["--version"],
      modelSelection: "session-config",
      buildLaunchArgs: () => [],
      declaredCapabilities: [
        "text",
        "repository_read",
        "git_diff",
        "session_resume",
      ],
      limitationWhenUnavailable:
        "Codex ACP 适配器当前不可用；请安装并完成 Codex 登录。",
    },
    {
      id: "claude-agent",
      displayName: "Claude Agent ACP",
      agentCommand: config.claudeAcpCommand,
      versionArgs: ["--version"],
      modelSelection: "session-config",
      buildLaunchArgs: () => [],
      declaredCapabilities: [
        "text",
        "repository_read",
        "git_diff",
        "session_resume",
      ],
      limitationWhenUnavailable:
        "Claude Agent ACP 适配器当前不可用；请安装并完成 Claude 登录。",
    },
  ]);
}
