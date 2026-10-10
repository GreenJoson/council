/**
 * @input  依赖：ClientConfigSettings（目标路径与 MCP 环境）、client-config-files/store/sources
 * @output 导出：ClientConfigService（status/apply/restore）与对外 DTO ClientConfigStatus
 * @pos    客户端配置分发用例门面：REST 路由唯一入口；状态机 not_applied → applied ⇄ drifted / missing
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 * DTO 里的路径把家目录折叠成 "~"，真实家目录不出服务端。
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CouncilConflictError } from "../errors.js";
import type { ClientConfigSettings } from "../types.js";
import {
  applyClaudeFragment,
  applyCodexBlock,
  assertClaudeWritable,
  assertCodexWritable,
  claudeFragmentSha,
  codexFragmentSha,
  hashFile,
  hashTree,
  removeClaudeFragment,
  removeCodexBlock,
  removeDirectory,
  writeSkillTree,
  type McpRegistration,
  type SkillFile,
} from "./client-config-files.js";
import { loadCouncilSkillFiles, resolveMcpLaunch } from "./client-config-sources.js";
import { ClientConfigStore, type AppliedRecord, type ClientId, CLIENT_IDS } from "./client-config-store.js";

export type ClientConfigState = "not_applied" | "applied" | "drifted" | "missing";

export interface ClientConfigStatus {
  client: ClientId;
  configFile: string;
  skillsDir: string;
  state: ClientConfigState;
  appliedAt?: string;
  stashPath?: string;
  detail?: string;
  /** 仅 apply 响应：本次覆盖了他人的 Skill 目录并已 stash 时的告知 */
  notice?: string;
}

export interface ClientConfigServiceOptions {
  now?: () => Date;
  resolveLaunch?: () => { command: string; args: string[] };
  loadSkillFiles?: () => SkillFile[];
}

export class ClientConfigService {
  readonly #settings: ClientConfigSettings;
  readonly #store: ClientConfigStore;
  readonly #now: () => Date;
  readonly #resolveLaunch: () => { command: string; args: string[] };
  readonly #loadSkillFiles: () => SkillFile[];

  constructor(settings: ClientConfigSettings, options: ClientConfigServiceOptions = {}) {
    this.#settings = settings;
    this.#store = new ClientConfigStore(settings.rootDir);
    this.#now = options.now ?? (() => new Date());
    this.#resolveLaunch = options.resolveLaunch ?? resolveMcpLaunch;
    this.#loadSkillFiles = options.loadSkillFiles ?? loadCouncilSkillFiles;
  }

  status(): ClientConfigStatus[] {
    return CLIENT_IDS.map((client) => this.#status(client));
  }

  apply(client: ClientId, options: { force?: boolean } = {}): ClientConfigStatus {
    if (this.#settings.missingMcpEnv.length > 0) {
      throw new CouncilConflictError(
        `服务缺少 MCP 必需环境变量 ${this.#settings.missingMcpEnv.join(", ")}，无法生成客户端注册。`,
      );
    }
    const registration = this.#registration(client);
    const skillFiles = this.#loadSkillFiles();
    const record = this.#store.readApplied(client);
    const state = this.#stateOf(record);
    if (state === "drifted" && !options.force) {
      throw new CouncilConflictError("客户端配置在写入后被改动（已漂移）；确认覆盖请使用「重新写入（覆盖漂移）」。");
    }
    const { configFile, skillsDir } = this.#targets(client);
    // 先预检再 stash/写入：解析失败或手写冲突时不留下任何半成品。
    if (client === "claude") {
      assertClaudeWritable(configFile);
    } else {
      assertCodexWritable(configFile);
    }

    let stashPath = record?.stashPath;
    let notice: string | undefined;
    if (!record || record.configFile !== configFile || record.skillsDir !== skillsDir) {
      const stash = this.#store.createStash(client, configFile, skillsDir, this.#now());
      stashPath = stash.stashPath;
      if (stash.skills === "present") {
        notice = `目标 Skill 目录已存在且不是 Council 写入的，原目录已备份到 ${foldHome(stashPath)}。`;
      }
    }
    if (!stashPath) {
      throw new CouncilConflictError("缺少写入前快照，拒绝写入。");
    }

    const fragmentSha256 = client === "claude"
      ? (applyClaudeFragment(configFile, registration), claudeFragmentSha(registration))
      : (applyCodexBlock(configFile, registration), codexFragmentSha(registration));
    writeSkillTree(skillsDir, skillFiles);

    this.#store.writeApplied(client, {
      configFile,
      skillsDir,
      appliedAt: this.#now().toISOString(),
      fileSha256: hashFile(configFile) ?? "",
      fragmentSha256,
      skillsTreeSha256: hashTree(skillsDir) ?? "",
      stashPath,
    });
    return { ...this.#status(client), ...(notice ? { notice } : {}) };
  }

  restore(client: ClientId): ClientConfigStatus {
    const record = this.#store.readApplied(client);
    if (!record) {
      throw new CouncilConflictError("该客户端尚未由 Council 写入，无需还原。");
    }
    const manifest = this.#store.readStash(record.stashPath);
    if (this.#stateOf(record) === "applied") {
      // 未漂移：按快照精确还原（原本不存在的文件会被删除）。
      this.#store.restoreConfigFromStash(record.stashPath, manifest);
      this.#store.restoreSkillsFromStash(record.stashPath, manifest);
    } else {
      // 漂移/文件丢失：只删受管片段与我们写的 Skill 目录，用户后来的改动保留。
      if (client === "claude") {
        removeClaudeFragment(record.configFile);
      } else {
        removeCodexBlock(record.configFile);
      }
      removeDirectory(record.skillsDir);
      if (manifest.skills === "present") {
        this.#store.restoreSkillsFromStash(record.stashPath, manifest);
      }
    }
    this.#store.writeApplied(client, undefined);
    return this.#status(client);
  }

  #targets(client: ClientId): { configFile: string; skillsDir: string } {
    return client === "claude"
      ? { configFile: this.#settings.claudeFile, skillsDir: this.#settings.claudeSkillsDir }
      : { configFile: this.#settings.codexFile, skillsDir: this.#settings.codexSkillsDir };
  }

  #registration(client: ClientId): McpRegistration {
    const launch = this.#resolveLaunch();
    return {
      command: launch.command,
      args: launch.args,
      env: { ...this.#settings.mcpEnv, COUNCIL_CALLER_ACTOR_ALIAS: client },
    };
  }

  #stateOf(record: AppliedRecord | undefined): ClientConfigState {
    if (!record) {
      return "not_applied";
    }
    const fileSha = hashFile(record.configFile);
    if (fileSha === null) {
      return "missing";
    }
    if (fileSha !== record.fileSha256 || hashTree(record.skillsDir) !== record.skillsTreeSha256) {
      return "drifted";
    }
    return "applied";
  }

  #status(client: ClientId): ClientConfigStatus {
    const record = this.#store.readApplied(client);
    const targets = record ?? this.#targets(client);
    const state = this.#stateOf(record);
    const status: ClientConfigStatus = {
      client,
      configFile: foldHome(targets.configFile),
      skillsDir: foldHome(targets.skillsDir),
      state,
    };
    if (record) {
      status.appliedAt = record.appliedAt;
      status.stashPath = foldHome(record.stashPath);
    }
    const detail = this.#detail(client, state, record);
    if (detail) {
      status.detail = detail;
    }
    return status;
  }

  #detail(client: ClientId, state: ClientConfigState, record: AppliedRecord | undefined): string | undefined {
    if (state === "drifted") {
      return existsSync(record?.skillsDir ?? "")
        ? "配置文件或 Skill 目录在写入后被改动；还原只会删除 Council 写入的部分。"
        : "Council 写入的 Skill 目录已不存在；还原只会删除 Council 写入的部分。";
    }
    if (state === "missing") {
      return "配置文件已被删除；可重新写入，或还原以清理 Council 写入的 Skill 目录。";
    }
    if (this.#settings.missingMcpEnv.length > 0) {
      return `服务缺少 ${this.#settings.missingMcpEnv.join(", ")}，暂不能写入。`;
    }
    if (state === "applied" && record) {
      try {
        const registration = this.#registration(client);
        const expected = client === "claude" ? claudeFragmentSha(registration) : codexFragmentSha(registration);
        if (expected !== record.fragmentSha256) {
          return "已写入的注册与当前服务配置不一致（入口或环境有变），建议重新写入。";
        }
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/** 家目录前缀折叠为 "~"，避免真实家目录路径进入 DTO 与界面。 */
export function foldHome(target: string): string {
  const home = homedir();
  if (target === home) {
    return "~";
  }
  return target.startsWith(`${home}${path.sep}`) ? `~${target.slice(home.length)}` : target;
}
