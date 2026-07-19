/**
 * @input  依赖：VITE_COUNCIL_DATA_MODE 与 mock repository
 * @output 导出：当前环境对应的 CouncilRepository
 * @pos    WebUI 数据实现的集中式选择入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { MockCouncilRepository } from "./mock-repository";
import type { CouncilRepository } from "./repository";

export function createCouncilRepository(): CouncilRepository {
  const mode = import.meta.env.VITE_COUNCIL_DATA_MODE ?? "mock";
  if (mode !== "mock") {
    throw new Error(`当前版本暂不支持数据模式：${mode}`);
  }
  return new MockCouncilRepository();
}
