/**
 * @input  依赖：项目相对路径
 * @output 导出：文件读取、搜索与 Git diff 共用的敏感路径判定
 * @pos    所有本地只读工具的单一路径安全策略，防止不同入口规则漂移
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import path from "node:path";

export const IGNORED_PROJECT_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".aws",
  ".ssh",
  ".cache",
  "node_modules",
  "target",
  "dist",
  "build",
  "coverage",
]);

const PROTECTED_FILE_NAMES = new Set([
  ".env",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "credentials.json",
  "id_rsa",
  "id_ed25519",
]);

const PROTECTED_FILE_EXTENSIONS = new Set([
  ".key",
  ".pem",
  ".p12",
  ".pfx",
]);

export function isProtectedProjectRelativePath(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]+/u).filter(Boolean);
  if (
    segments.some((segment) =>
      IGNORED_PROJECT_DIRECTORIES.has(segment.toLowerCase()))
  ) {
    return true;
  }
  const basename = segments.at(-1)?.toLowerCase() ?? "";
  if (basename === ".env.example") {
    return false;
  }
  return PROTECTED_FILE_NAMES.has(basename)
    || basename.startsWith(".env.")
    || PROTECTED_FILE_EXTENSIONS.has(path.extname(basename));
}
