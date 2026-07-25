/**
 * @input  依赖：系统 Keychain 命令、Provider 标识与用户提交的 API Key
 * @output 导出：区分凭据缺失与命令故障、只在进程内返回密钥的 SecretStore 与 macOS Keychain 实现
 * @pos    远程模型凭据的失败关闭持久化边界；密钥不写 SQLite、配置文件或日志
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { runBoundedProcess } from "./process-utils.js";

const KEYCHAIN_SERVICE = "com.council.agent-provider";
const KEYCHAIN_TIMEOUT_MS = 10_000;
const KEYCHAIN_OUTPUT_LIMIT = 8_192;
const KEYCHAIN_ITEM_NOT_FOUND_EXIT_CODE = 44;

export interface SecretStore {
  has(account: string): Promise<boolean>;
  get(account: string): Promise<string | undefined>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<boolean>;
}

export class UnavailableSecretStore implements SecretStore {
  async has(): Promise<boolean> {
    return false;
  }

  async get(): Promise<string | undefined> {
    return undefined;
  }

  async set(): Promise<void> {
    throw new Error("当前未配置系统 Keychain 命令，无法安全保存 API Key。");
  }

  async delete(): Promise<boolean> {
    return false;
  }
}

export class MacOsKeychainSecretStore implements SecretStore {
  constructor(private readonly command: string) {}

  async #run(args: string[], input = "") {
    return await runBoundedProcess({
      command: this.command,
      args,
      input,
      timeoutMs: KEYCHAIN_TIMEOUT_MS,
      killGraceMs: 1_000,
      maxOutputChars: KEYCHAIN_OUTPUT_LIMIT,
      messages: {
        aborted: "Keychain 操作已取消。",
        timeout: "Keychain 操作超时。",
        outputLimit: "Keychain 返回内容超过安全上限。",
        commandNotFound: "找不到系统 Keychain 命令。",
        spawnFailed: "无法启动系统 Keychain 命令。",
      },
    });
  }

  async has(account: string): Promise<boolean> {
    return (await this.get(account)) !== undefined;
  }

  async get(account: string): Promise<string | undefined> {
    const result = await this.#run([
      "find-generic-password",
      "-a",
      account,
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
    ]);
    if (result.exitCode === KEYCHAIN_ITEM_NOT_FOUND_EXIT_CODE) {
      return undefined;
    }
    if (result.exitCode !== 0) {
      throw new Error("系统 Keychain 读取失败，无法确认 API Key 是否存在。");
    }
    const secret = result.stdout.trim();
    return secret || undefined;
  }

  async set(account: string, secret: string): Promise<void> {
    const result = await this.#run([
      "add-generic-password",
      "-U",
      "-a",
      account,
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
      secret,
    ]);
    if (result.exitCode !== 0) {
      throw new Error("API Key 未能写入系统 Keychain。");
    }
  }

  async delete(account: string): Promise<boolean> {
    const result = await this.#run([
      "delete-generic-password",
      "-a",
      account,
      "-s",
      KEYCHAIN_SERVICE,
    ]);
    return result.exitCode === 0;
  }
}
