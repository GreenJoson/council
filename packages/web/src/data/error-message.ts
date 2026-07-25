/**
 * @input  依赖：无
 * @output 导出：把任意 reject 值归一成可展示文案的 getErrorMessage
 * @pos    UI 错误展示的唯一归一化入口；启动失败时它是用户能拿到的全部线索
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

/**
 * Tauri 的 invoke 失败会以纯字符串 reject，HTTP 层也可能抛出普通对象。
 * 只认 Error 实例会把「schema 版本不受支持」这类唯一能告诉用户怎么修的信息
 * 吞成「发生未知错误」——而这恰好只在应用打不开、用户最需要线索时发生。
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  return "发生未知错误";
}
