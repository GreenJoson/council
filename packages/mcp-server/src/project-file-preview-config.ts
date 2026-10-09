/**
 * @input  依赖：HTTP 启动环境配置
 * @output 导出：项目文件预览的大小、表格与隔离解析预算
 * @pos    文件预览配置的单一真源；业务代码不读取环境变量
 */
import { z } from "zod/v4";

const schema = z.object({
  maxBytes: z.coerce.number().int().positive().max(50_000_000).default(10_000_000),
  maxTextChars: z.coerce.number().int().positive().max(1_000_000).default(200_000),
  maxRows: z.coerce.number().int().positive().max(2_000).default(500),
  maxColumns: z.coerce.number().int().positive().max(200).default(80),
  maxSheets: z.coerce.number().int().positive().max(100).default(30),
  maxCellChars: z.coerce.number().int().positive().max(10_000).default(1_000),
  maxExpandedBytes: z.coerce.number().int().positive().max(200_000_000).default(50_000_000),
  maxArchiveEntries: z.coerce.number().int().positive().max(100_000).default(10_000),
  workerMemoryMb: z.coerce.number().int().min(64).max(512).default(256),
  timeoutMs: z.coerce.number().int().positive().max(60_000).default(15_000),
});

export type ProjectFilePreviewConfig = z.infer<typeof schema>;
export const DEFAULT_PROJECT_FILE_PREVIEW_CONFIG = schema.parse({});

export function loadProjectFilePreviewConfig(env: NodeJS.ProcessEnv): ProjectFilePreviewConfig {
  const values = Object.fromEntries(Object.keys(schema.shape).map((key) => [
    key, env[`COUNCIL_FILE_PREVIEW_${key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`],
  ]));
  const parsed = schema.safeParse(values);
  if (!parsed.success) throw new Error("COUNCIL_FILE_PREVIEW_* 配置无效。");
  return parsed.data;
}
