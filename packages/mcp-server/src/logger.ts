/**
 * @input  依赖：运行时日志级别、模块名与未知错误
 * @output 导出：写入 stderr 的结构化本地日志函数
 * @pos    stdio MCP 的统一日志出口，避免污染 stdout 协议流
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function write(level: "INFO" | "WARN" | "ERROR", module: string, message: string): void {
  process.stderr.write(`[${new Date().toISOString()}] [${level}] [${module}] ${message}\n`);
}

export const logger = {
  info(module: string, message: string): void {
    write("INFO", module, message);
  },
  warn(module: string, message: string): void {
    write("WARN", module, message);
  },
  error(module: string, message: string, error?: unknown): void {
    const details = error === undefined ? message : `${message}: ${serializeError(error)}`;
    write("ERROR", module, details);
  },
};
