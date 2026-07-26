/**
 * @input  依赖：Vite、React 插件、tauri.conf.json 版本正本与 git 构建标识
 * @output 导出：Council Web 构建配置与 __COUNCIL_BUILD__ 构建期常量
 * @pos    Web 包的开发服务器和生产构建入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");

/** 版本只有一处正本：桌面壳的 tauri.conf.json。这里读它，不另抄一份。 */
function readAppVersion(): string {
  try {
    const raw = readFileSync(
      path.join(repoRoot, "packages/desktop/src-tauri/tauri.conf.json"),
      "utf8",
    );
    const parsed: unknown = JSON.parse(raw);
    const version = (parsed as { version?: unknown }).version;
    return typeof version === "string" && version ? version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * semver 一天里会被重建很多次却不变，单靠它分不清手上跑的是哪个包，
 * 所以再带一个 commit 标识；工作区有改动时标 -dirty，免得把本地构建
 * 误认成某个干净提交。
 */
function readBuildCommit(): string {
  const git = (args: readonly string[]): string =>
    execFileSync("git", [...args], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    const commit = git(["rev-parse", "--short", "HEAD"]);
    if (!commit) {
      return "unknown";
    }
    return git(["status", "--porcelain"]) ? `${commit}-dirty` : commit;
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    __COUNCIL_BUILD__: JSON.stringify({
      version: readAppVersion(),
      commit: readBuildCommit(),
      builtAt: new Date().toISOString(),
    }),
  },
  build: {
    sourcemap: true,
  },
});
