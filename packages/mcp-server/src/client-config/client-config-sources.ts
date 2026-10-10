/**
 * @input  依赖：node:sea（桌面 sidecar 判定与内嵌资源）、本模块的 import.meta.url、仓库 skills/council 目录
 * @output 导出：resolveMcpLaunch（stdio MCP 的 command/args）与 loadCouncilSkillFiles（待分发的 Skill 文件集合）
 * @pos    客户端配置分发的"写什么"来源：不硬编码仓库路径，dev（dist/tsx）与桌面 sidecar 各自定位
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 * sidecar 内 import.meta.url 不可用（esbuild 打成 CJS），因此 isSea() 分支必须先于任何 import.meta 访问。
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { getAsset, isSea } from "node:sea";
import { fileURLToPath } from "node:url";
import { CouncilConflictError } from "../errors.js";
import { COUNCIL_STDIO_MCP_FLAG } from "../stdio-mcp.js";
import type { SkillFile } from "./client-config-files.js";

/** sidecar 构建脚本写入的 Skill 资源清单键与文件键前缀；须与 scripts/build-agent-sidecar.mjs 一致。 */
export const SEA_SKILL_MANIFEST_KEY = "council-skill/manifest.json";
export const SEA_SKILL_FILE_PREFIX = "council-skill/files/";

function moduleUrl(): string {
  return import.meta.url;
}

/**
 * stdio 入口：sidecar 用自身可执行 + 标记；dist 运行时用同级 ../index.js；tsx 跑源码时指向构建产物
 * dist/src/index.js（客户端以纯 node 启动，跑不了 .ts）。
 */
export function resolveMcpLaunch(): { command: string; args: string[] } {
  if (isSea()) {
    return { command: process.execPath, args: [COUNCIL_STDIO_MCP_FLAG] };
  }
  const here = moduleUrl();
  const entryUrl = here.endsWith(".ts")
    ? new URL("../../dist/src/index.js", here)
    : new URL("../index.js", here);
  const entry = fileURLToPath(entryUrl);
  if (!existsSync(entry)) {
    throw new CouncilConflictError("找不到 MCP stdio 入口 dist/src/index.js；请先构建 mcp-server（npm run build）。");
  }
  return { command: process.execPath, args: [entry] };
}

function readSkillDirectory(root: string): SkillFile[] {
  const files: SkillFile[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current).sort()) {
      const absolute = path.join(current, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        walk(absolute, relative);
      } else if (stat.isFile()) {
        files.push({ relativePath: relative, content: readFileSync(absolute) });
      }
    }
  };
  walk(root, "");
  return files;
}

function readSeaSkillFiles(): SkillFile[] {
  let names: unknown;
  try {
    names = JSON.parse(getAsset(SEA_SKILL_MANIFEST_KEY, "utf8"));
  } catch {
    throw new CouncilConflictError("当前桌面服务未内嵌 council Skill，无法写入 Skill；请升级桌面应用。");
  }
  if (!Array.isArray(names) || !names.every((name) => typeof name === "string")) {
    throw new CouncilConflictError("内嵌 council Skill 清单无效。");
  }
  return names.map((relativePath: string) => ({
    relativePath,
    content: Buffer.from(getAsset(`${SEA_SKILL_FILE_PREFIX}${relativePath}`)),
  }));
}

/** 仓库 skills/council：dist/src/client-config → 上 5 级；src/client-config → 上 4 级。 */
export function loadCouncilSkillFiles(): SkillFile[] {
  if (isSea()) {
    return readSeaSkillFiles();
  }
  const here = moduleUrl();
  const relative = here.endsWith(".ts") ? "../../../../skills/council/" : "../../../../../skills/council/";
  const root = fileURLToPath(new URL(relative, here));
  if (!existsSync(path.join(root, "SKILL.md"))) {
    throw new CouncilConflictError("找不到仓库内的 skills/council/SKILL.md，无法写入 Skill。");
  }
  return readSkillDirectory(root);
}
