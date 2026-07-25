/**
 * @input  依赖：旧 schema 迁移行与历史作者/Agent 字段
 * @output 导出：严格迁移值读取器与历史身份映射
 * @pos    schema-migrator 的纯值转换边界，不接触 SQLite 或迁移事务
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

export function legacyActorId(value: string): string {
  switch (value.toLocaleLowerCase("en-US")) {
    case "human":
    case "user":
      return "human";
    case "chair":
    case "council":
      return "council";
    case "claude":
    case "claude-code":
      return "claude";
    case "codex":
    case "codex-cli":
      return "codex";
    case "deepseek":
      return "deepseek";
    case "kimi":
      return "kimi";
    default:
      return "legacy-unknown";
  }
}

export function migrationString(
  row: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Council 迁移源字段 ${key} 无效。`);
  }
  return value;
}

export function migrationNullableString(
  row: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = row[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Council 迁移源字段 ${key} 无效。`);
  }
  return value;
}

export function migrationInteger(
  row: Readonly<Record<string, unknown>>,
  key: string,
): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Council 迁移源字段 ${key} 无效。`);
  }
  return value;
}
