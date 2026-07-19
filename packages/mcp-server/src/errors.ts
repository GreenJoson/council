/**
 * @input  依赖：领域服务抛出的可预期失败
 * @output 导出：可安全映射到 MCP 与 HTTP 的领域错误
 * @pos    存储层与协议层之间的错误语义边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

export class CouncilNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CouncilNotFoundError";
  }
}

export class CouncilConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CouncilConflictError";
  }
}

export class CouncilValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CouncilValidationError";
  }
}
