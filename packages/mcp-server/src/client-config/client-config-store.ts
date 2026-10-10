/**
 * @input  依赖：<data-dir>/client-config 目录、client-config-files 的原子写与目录复制
 * @output 导出：applied.json 读写（每客户端一条写入记录）与 stash 快照的创建/读取/回放
 * @pos    客户端配置分发的状态账本：记录写了什么、写前原样是什么，供漂移判定与还原使用
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 * applied.json 是标准 JSON（不写注释）；stash 目录写入后不再修改，还原后也保留作为备份。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { removeDirectory, replaceDirectory, writeFileAtomic } from "./client-config-files.js";

export type ClientId = "claude" | "codex";
export const CLIENT_IDS: readonly ClientId[] = ["claude", "codex"];

export interface AppliedRecord {
  configFile: string;
  skillsDir: string;
  appliedAt: string;
  /** 写入后整个配置文件的 sha256：块外/键外被改也算漂移 */
  fileSha256: string;
  /** 受管片段（Claude 的 council 项 / Codex 的受管块）sha256：判断注册内容是否过期 */
  fragmentSha256: string;
  skillsTreeSha256: string;
  stashPath: string;
}

interface AppliedDocument {
  version: 1;
  clients: Partial<Record<ClientId, AppliedRecord>>;
}

/** stash 清单：原配置文件与原 Skill 目录各自是否存在；存在则副本在同目录下。 */
export interface StashManifest {
  client: ClientId;
  createdAt: string;
  configFile: string;
  config: "present" | "absent";
  skillsDir: string;
  skills: "present" | "absent";
}

const STASH_CONFIG_NAME = "config";
const STASH_SKILLS_NAME = "skills";
const STASH_MANIFEST_NAME = "manifest.json";

export class ClientConfigStore {
  readonly #rootDir: string;

  constructor(rootDir: string) {
    this.#rootDir = rootDir;
  }

  get #appliedFile(): string {
    return path.join(this.#rootDir, "applied.json");
  }

  readApplied(client: ClientId): AppliedRecord | undefined {
    return this.#readDocument().clients[client];
  }

  writeApplied(client: ClientId, record: AppliedRecord | undefined): void {
    const document = this.#readDocument();
    if (record) {
      document.clients[client] = record;
    } else {
      delete document.clients[client];
    }
    writeFileAtomic(this.#appliedFile, `${JSON.stringify(document, null, 2)}\n`);
  }

  #readDocument(): AppliedDocument {
    if (!existsSync(this.#appliedFile)) {
      return { version: 1, clients: {} };
    }
    const parsed = JSON.parse(readFileSync(this.#appliedFile, "utf8")) as Partial<AppliedDocument>;
    return { version: 1, clients: parsed.clients ?? {} };
  }

  /** 首次写入前拍快照：配置文件整份复制（不存在记 absent），Skill 目录存在则整目录复制。 */
  createStash(client: ClientId, configFile: string, skillsDir: string, now: Date): StashManifest & { stashPath: string } {
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    let stashPath = path.join(this.#rootDir, "stash", client, stamp);
    for (let suffix = 1; existsSync(stashPath); suffix += 1) {
      stashPath = path.join(this.#rootDir, "stash", client, `${stamp}-${String(suffix)}`);
    }
    mkdirSync(stashPath, { recursive: true, mode: 0o700 });
    const configPresent = existsSync(configFile);
    if (configPresent) {
      copyFileSync(configFile, path.join(stashPath, STASH_CONFIG_NAME));
    }
    const skillsPresent = existsSync(skillsDir);
    if (skillsPresent) {
      replaceDirectory(skillsDir, path.join(stashPath, STASH_SKILLS_NAME));
    }
    const manifest: StashManifest = {
      client,
      createdAt: now.toISOString(),
      configFile,
      config: configPresent ? "present" : "absent",
      skillsDir,
      skills: skillsPresent ? "present" : "absent",
    };
    writeFileAtomic(path.join(stashPath, STASH_MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
    return { ...manifest, stashPath };
  }

  readStash(stashPath: string): StashManifest {
    return JSON.parse(readFileSync(path.join(stashPath, STASH_MANIFEST_NAME), "utf8")) as StashManifest;
  }

  /** 精确还原配置文件：原本存在就整份写回，原本不存在就删除。 */
  restoreConfigFromStash(stashPath: string, manifest: StashManifest): void {
    if (manifest.config === "present") {
      writeFileAtomic(manifest.configFile, readFileSync(path.join(stashPath, STASH_CONFIG_NAME)));
    } else {
      removeDirectory(manifest.configFile);
    }
  }

  /** 还原 Skill 目录：原本有（他人的 Skill）就放回副本，原本没有就删掉我们写的目录。 */
  restoreSkillsFromStash(stashPath: string, manifest: StashManifest): void {
    if (manifest.skills === "present") {
      replaceDirectory(path.join(stashPath, STASH_SKILLS_NAME), manifest.skillsDir);
    } else {
      removeDirectory(manifest.skillsDir);
    }
  }
}
