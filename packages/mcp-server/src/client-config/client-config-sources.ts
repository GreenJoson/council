/**
 * @input  依赖：node:sea（桌面 sidecar 判定与内嵌资源）、本模块的 import.meta.url、仓库 skills/council 目录、
 *         stdio-mcp.ts 的 resolveStdioMcpLaunch（启动命令唯一真源）
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
import { resolveStdioMcpLaunch } from "../stdio-mcp.js";
import type { SkillFile } from "./client-config-files.js";

/** sidecar 构建脚本写入的 Skill 资源清单键与文件键前缀；须与 scripts/build-agent-sidecar.mjs 一致。 */
export const SEA_SKILL_MANIFEST_KEY = "council-skill/manifest.json";
export const SEA_SKILL_FILE_PREFIX = "council-skill/files/";

function moduleUrl(): string {
  return import.meta.url;
}

/** stdio 入口与团队 Lead 注入共用同一套定位规则（sidecar 标记 / dist / tsx），见 stdio-mcp.ts。 */
export function resolveMcpLaunch(): { command: string; args: string[] } {
  const launch = resolveStdioMcpLaunch();
  return { command: launch.command, args: [...launch.args] };
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
