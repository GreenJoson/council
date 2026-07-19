/**
 * @input  依赖：http 模式的 VITE_COUNCIL_PROJECT_PATH 原始值
 * @output 导出：跨平台绝对项目路径配置解析器
 * @pos    Web 创建议题前确保 ClaudeAdapter 获得可信 cwd 的配置边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

const DRIVE_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;
const UNC_ABSOLUTE_PATH = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/].*)?$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function hasAbsolutePathShape(value: string): boolean {
  if (value.startsWith("//") || value.startsWith("\\\\")) {
    return UNC_ABSOLUTE_PATH.test(value);
  }
  return value.startsWith("/") || DRIVE_ABSOLUTE_PATH.test(value);
}

export function readProjectPathConfig(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error("http 模式必须配置 VITE_COUNCIL_PROJECT_PATH");
  }
  if (CONTROL_CHARACTER.test(normalized) || !hasAbsolutePathShape(normalized)) {
    throw new Error(
      "VITE_COUNCIL_PROJECT_PATH 必须是 POSIX、盘符或 UNC 形式的绝对路径",
    );
  }
  return normalized;
}
