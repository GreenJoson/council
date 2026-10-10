/**
 * @input  依赖：本地文件系统、node:crypto；目标为 Claude JSON 配置、Codex TOML 配置与 Skill 目录
 * @output 导出：受管片段读写（Claude 的 mcpServers.council 键、Codex 的 council managed 文本块）、
 *         Skill 目录复制/删除、文件与目录树 sha256、原子写入与整文件/整目录复制工具
 * @pos    客户端配置分发的落盘边界：只碰受管片段，用户其余内容保持原样（Codex 块外逐字节不变）
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { CouncilConflictError } from "../errors.js";

/** 写进客户端配置的 stdio MCP 注册内容；env 只含非敏感键。 */
export interface McpRegistration {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Skill 文件集合：相对路径（POSIX 分隔）→ 内容；来源可以是仓库目录或 sidecar 内嵌资源。 */
export interface SkillFile {
  relativePath: string;
  content: Buffer;
}

export const CODEX_BLOCK_START = "# >>> council managed (do not edit) >>>";
export const CODEX_BLOCK_END = "# <<< council managed <<<";
const NEW_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

// ── 通用：哈希与原子写 ──────────────────────────────────────────────

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function hashFile(file: string): string | null {
  return existsSync(file) ? sha256(readFileSync(file)) : null;
}

/** 目录树哈希：按相对路径排序，路径 + 内容哈希逐行拼接；目录不存在返回 null。符号链接只记路径不跟随。 */
export function hashTree(dir: string): string | null {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) {
    return null;
  }
  const lines: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current).sort()) {
      const absolute = path.join(current, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        walk(absolute, relative);
      } else if (stat.isFile()) {
        lines.push(`${relative}\0${sha256(readFileSync(absolute))}`);
      } else {
        lines.push(`${relative}\0link`);
      }
    }
  };
  walk(dir, "");
  return sha256(lines.join("\n"));
}

/** 临时文件 + rename；保留原文件权限，新文件 0600（配置里可能有用户自己的密钥）。 */
export function writeFileAtomic(file: string, content: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE });
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : NEW_FILE_MODE;
  const temporary = `${file}.council-${String(process.pid)}-${String(Date.now())}.tmp`;
  try {
    writeFileSync(temporary, content, { mode });
    chmodSync(temporary, mode);
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** 整目录复制（stash 与还原用）；目标先清空，保证还原后与副本一致。 */
export function replaceDirectory(source: string, target: string): void {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, verbatimSymlinks: true });
}

// ── Claude：JSON 文件里的 mcpServers.council ─────────────────────────

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readClaudeJson(file: string): JsonObject | null {
  if (!existsSync(file)) {
    return null;
  }
  const raw = readFileSync(file, "utf8");
  if (raw.trim() === "") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CouncilConflictError("Claude 配置文件不是合法 JSON，未做任何修改；请先修复该文件。");
  }
  if (!isJsonObject(parsed)) {
    throw new CouncilConflictError("Claude 配置文件顶层不是 JSON 对象，未做任何修改。");
  }
  if (parsed.mcpServers !== undefined && !isJsonObject(parsed.mcpServers)) {
    throw new CouncilConflictError("Claude 配置文件的 mcpServers 不是对象，未做任何修改。");
  }
  return parsed;
}

export function claudeEntry(registration: McpRegistration): JsonObject {
  return {
    type: "stdio",
    command: registration.command,
    args: registration.args,
    env: registration.env,
  };
}

/** 受管片段哈希：只看 council 这一项的规范化 JSON。 */
export function claudeFragmentSha(registration: McpRegistration): string {
  return sha256(JSON.stringify(claudeEntry(registration)));
}

/** 写入前预检：解析失败即 409，保证 stash/写入之前就拒绝。 */
export function assertClaudeWritable(file: string): void {
  readClaudeJson(file);
}

export function applyClaudeFragment(file: string, registration: McpRegistration): void {
  const document = readClaudeJson(file) ?? {};
  const servers = isJsonObject(document.mcpServers) ? document.mcpServers : {};
  document.mcpServers = { ...servers, council: claudeEntry(registration) };
  writeFileAtomic(file, `${JSON.stringify(document, null, 2)}\n`);
}

/** 漂移还原：只删 council 键；mcpServers 因此变空时一并去掉，其余键原样保留。 */
export function removeClaudeFragment(file: string): void {
  const document = readClaudeJson(file);
  if (!document || !isJsonObject(document.mcpServers) || !("council" in document.mcpServers)) {
    return;
  }
  const { council: _removed, ...rest } = document.mcpServers;
  if (Object.keys(rest).length === 0) {
    delete document.mcpServers;
  } else {
    document.mcpServers = rest;
  }
  writeFileAtomic(file, `${JSON.stringify(document, null, 2)}\n`);
}

// ── Codex：TOML 文件里的 council managed 文本块 ─────────────────────

/** TOML 基本字符串与 JSON 字符串转义兼容（\" \\ \n \uXXXX），直接复用 JSON.stringify。 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function codexBlock(registration: McpRegistration): string {
  const lines = [
    CODEX_BLOCK_START,
    "[mcp_servers.council]",
    `command = ${tomlString(registration.command)}`,
    `args = [${registration.args.map(tomlString).join(", ")}]`,
    "",
    "[mcp_servers.council.env]",
    ...Object.entries(registration.env).map(([key, value]) => `${key} = ${tomlString(value)}`),
    CODEX_BLOCK_END,
  ];
  return lines.join("\n");
}

export function codexFragmentSha(registration: McpRegistration): string {
  return sha256(codexBlock(registration));
}

interface BlockRange {
  /** 起始标记行首的字符偏移 */
  start: number;
  /** 结束标记行之后（含其换行符）的字符偏移 */
  end: number;
}

function findCodexBlock(text: string): BlockRange | null {
  const startMatch = new RegExp(`^${escapeRegExp(CODEX_BLOCK_START)}[ \\t]*$`, "m").exec(text);
  if (!startMatch) {
    return null;
  }
  const endPattern = new RegExp(`^${escapeRegExp(CODEX_BLOCK_END)}[ \\t]*$`, "m");
  const tail = text.slice(startMatch.index);
  const endMatch = endPattern.exec(tail);
  if (!endMatch) {
    throw new CouncilConflictError("Codex 配置中的 council 受管块缺少结束标记，未做任何修改；请手动修复。");
  }
  let end = startMatch.index + endMatch.index + endMatch[0].length;
  if (text[end] === "\r") {
    end += 1;
  }
  if (text[end] === "\n") {
    end += 1;
  }
  return { start: startMatch.index, end };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 受管块之外若已有用户自己的 [mcp_servers.council…] 表头，写入会造成 TOML 重复定义。 */
const FOREIGN_COUNCIL_HEADER = /^\s*\[\s*mcp_servers\s*\.\s*"?council"?\s*[\].]/m;

function readCodexText(file: string): string | null {
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

export function assertCodexWritable(file: string): void {
  const text = readCodexText(file);
  if (text === null) {
    return;
  }
  const range = findCodexBlock(text);
  const outside = range ? text.slice(0, range.start) + text.slice(range.end) : text;
  if (FOREIGN_COUNCIL_HEADER.test(outside)) {
    throw new CouncilConflictError(
      "Codex 配置里已有手写的 [mcp_servers.council]（不在 council 受管块内）；请先手动删除这段后再写入。",
    );
  }
}

/** 已有受管块就原位替换，否则追加到末尾（与上文隔一空行）；块外内容逐字节不变。 */
export function applyCodexBlock(file: string, registration: McpRegistration): void {
  assertCodexWritable(file);
  const text = readCodexText(file) ?? "";
  const block = `${codexBlock(registration)}\n`;
  const range = findCodexBlock(text);
  let next: string;
  if (range) {
    next = text.slice(0, range.start) + block + text.slice(range.end);
  } else if (text === "") {
    next = block;
  } else if (text.endsWith("\n")) {
    next = `${text}\n${block}`;
  } else {
    next = `${text}\n\n${block}`;
  }
  writeFileAtomic(file, next);
}

/** 漂移还原：删掉受管块及其前面一行由我们追加的空行，块外其余内容保持原样。 */
export function removeCodexBlock(file: string): void {
  const text = readCodexText(file);
  if (text === null) {
    return;
  }
  const range = findCodexBlock(text);
  if (!range) {
    return;
  }
  let before = text.slice(0, range.start);
  if (before.endsWith("\n\n")) {
    before = before.slice(0, -1);
  }
  writeFileAtomic(file, before + text.slice(range.end));
}

// ── Skill 目录 ──────────────────────────────────────────────────────

/** 整体替换目标 Skill 目录为给定文件集合；调用方负责在覆盖他人目录前 stash。 */
export function writeSkillTree(target: string, files: readonly SkillFile[]): void {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const file of files) {
    const destination = path.join(target, ...file.relativePath.split("/"));
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, file.content, { mode: 0o644 });
  }
}

export function removeDirectory(target: string): void {
  rmSync(target, { recursive: true, force: true });
}
