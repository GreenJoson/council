/** @input 分阶段诊断结果；@output 模型路由与能力证据；@pos 明确区分连通、只读工具和未验证的写入权限。 */
import { useLayoutEffect, useRef } from "react";
import { useI18n } from "../i18n/I18nProvider";
import type { AgentConnectionTest } from "../types/model-router";
const STAGES = { runtime: "运行时", authentication: "账号认证", model: "模型响应", tools: "只读工具", write_permission: "项目写入权限" } as const;
const STATUS = { passed: "通过", failed: "失败", unverified: "未验证" } as const;
export function ModelRouterDiagnostics({ result }: { result: AgentConnectionTest }) {
  const { t } = useI18n();
  const diagnosis = result.diagnosis;
  const panel = useRef<HTMLElement>(null);
  useLayoutEffect(() => { panel.current?.scrollIntoView({ block: "nearest" }); }, [result]);
  return <section ref={panel} className="model-diagnostics" aria-label={t("连接诊断结果")} aria-live="polite">
    <strong>{t(result.ok ? "连接诊断通过" : "连接诊断发现问题")} · {result.latencyMs} ms</strong>
    {result.checkedAt ? <small>{new Date(result.checkedAt).toLocaleString()}</small> : null}
    {diagnosis ? <>
      <p>{t("请求模型")}：<code>{diagnosis.requestedModel || t("CLI 默认模型")}</code></p>
      <p>{t("返回模型")}：<code>{diagnosis.observedModel || t("上游未提供")}</code></p>
      <small>{t("返回模型是上游声明，不作为底层模型身份的独立证明。")}</small>
      <ul>{diagnosis.checks.map((check, index) => <li key={`${check.stage}-${index}`} data-status={check.status}>
        <strong>{t(STAGES[check.stage])} · {t(STATUS[check.status])}</strong><span>{t(check.message)}</span>
      </li>)}</ul>
    </> : <p>{t("当前服务仅返回连通结果，工具与写入权限未验证。")}</p>}
  </section>;
}
