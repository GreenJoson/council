/** @input 失败委派与实施项版本；@output 恢复动作与可执行失败指引；@pos 通过已注入仓储发起新隔离运行。 */
import { useState } from "react";
import { useExecutionRepository } from "../hooks/useExecutionRepository";
import { useI18n } from "../i18n/I18nProvider";
import type { WorkItemDelegation } from "../types/orchestration";

const HINTS: Record<string, string> = {
  authentication_failed: "先完成 CLI 登录，再恢复。",
  quota_exhausted: "先补充额度或调整账号，再恢复。",
  model_unavailable: "先选择可用模型，再恢复。",
  transient_failure: "服务暂时不可用；恢复前会检查原提交。",
  interrupted: "服务曾中断；可恢复已提交进度，未提交文件需要先人工检查。",
};

export function DelegationRecoveryActions({ delegation, expectedVersion }: {
  delegation: WorkItemDelegation;
  expectedVersion: number;
}) {
  const { t } = useI18n();
  const repository = useExecutionRepository();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (!repository || !["failed", "cancelled"].includes(delegation.status)) return null;
  return <div>
    {delegation.failureCode && HINTS[delegation.failureCode] ? <p>{t(HINTS[delegation.failureCode]!)}</p> : null}
    {delegation.headCommit ? <button type="button" disabled={busy} onClick={() => {
      setBusy(true); setMessage(null);
      void repository.resumeWorkItemDelegation(delegation.id, expectedVersion)
        .then(() => setMessage("已从提交进度恢复，正在重新审核。"))
        .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "恢复失败"))
        .finally(() => setBusy(false));
    }}>{t(busy ? "正在检查恢复条件…" : "从已提交进度恢复")}</button> : <p>{t("没有已记录提交；重新委派将从项目当前基线开始。")}</p>}
    {message ? <p role="status">{t(message)}</p> : null}
  </div>;
}
