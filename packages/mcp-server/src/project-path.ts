/**
 * @input  依赖：外部提供的可选项目路径与本地文件系统
 * @output 导出：MCP/HTTP 共用的规范化、存在性校验结果
 * @pos    防止两个协议入口产生不同 projectPath 语义
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { statSync } from "node:fs";
import path from "node:path";
import { CouncilValidationError } from "./errors.js";

export function normalizeProjectPath(projectPath: string | undefined): string | undefined {
  if (!projectPath) {
    return undefined;
  }
  if (!path.isAbsolute(projectPath)) {
    throw new CouncilValidationError("项目路径必须是绝对路径。");
  }
  const stat = statSync(projectPath, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) {
    throw new CouncilValidationError("项目路径不存在或不是文件夹。");
  }
  return path.normalize(projectPath);
}
