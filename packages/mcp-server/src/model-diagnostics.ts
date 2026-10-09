/** @input Runtime 的有限诊断码；@output 无凭据的模型列表与分项诊断契约；@pos 配置诊断不等同于任务执行验收。 */
export interface DiagnosticCheck {
  stage: "runtime" | "authentication" | "model" | "tools" | "write_permission";
  status: "passed" | "failed" | "unverified";
  code?: string;
  message: string;
}
export interface AgentProbeResult {
  ok: boolean;
  checks: DiagnosticCheck[];
  requestedModel: string;
  observedModel?: string;
}
export interface ProviderModels {
  status: "available" | "unsupported" | "failed";
  models: string[];
  source: "provider" | "catalog";
  checkedAt: string;
  code?: string;
  message: string;
}
/** 只公开有限原因，不把上游正文、CLI stderr、URL 或凭据带回设置页。 */
export function diagnosticFailure(error: unknown): { code: string; message: string } {
  const code = error && typeof error === "object" && "diagnosticCode" in error
    && typeof error.diagnosticCode === "string" ? error.diagnosticCode : "unknown";
  if (code === "authentication" && error && typeof error === "object" && "httpStatus" in error && error.httpStatus === 403) {
    return { code: "account_permission_denied", message: "账号没有该模型或接口权限，请检查 Provider 授权。" };
  }
  if (code.startsWith("authentication")) return { code: "authentication_failed", message: "认证失败，请检查 CLI 登录或 Provider 凭据。" };
  if (code.startsWith("quota") || code === "budget_exhausted") return { code: "quota_exhausted", message: "账号额度不足，请检查余额或套餐。" };
  if (code === "rate_limited") return { code, message: "上游限流，请稍后再试。" };
  if (code.startsWith("model_unavailable") || code === "request_rejected") return { code: "model_unavailable", message: "模型或接口不可用，请核对精确模型 ID 与账号权限。" };
  if (code === "permission_denied") return { code, message: "工具操作被权限策略拒绝，请检查 CLI 权限。" };
  if (code.includes("timeout")) return { code: "timeout", message: "诊断超时，请检查网络或运行时状态。" };
  if (code === "network_error" || code.startsWith("transient") || code === "provider_unavailable") return { code: "provider_unavailable", message: "上游连接暂时不可用，请检查服务状态。" };
  if (code === "models_unsupported") return { code, message: "此连接不提供模型列表，可手动填写模型 ID 后测试。" };
  return { code: "invalid_response", message: "未得到有效诊断结果，请检查模型与协议配置。" };
}
/** 模型名是上游声明，不能用它证明后端实际使用了某个模型。 */
export function observedModel(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,199}$/.test(value) ? value : undefined;
}
