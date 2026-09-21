/** @input 失败委派与实施项版本；@output 提交恢复/未提交工作接续；@pos 保留历史并发起新隔离运行。 */
import { useState } from "react";
import { useExecutionRepository } from "../hooks/useExecutionRepository";
import { useI18n } from "../i18n/I18nProvider";
import type { WorkItemDelegation } from "../types/orchestration";

const HINTS: Record<string, string> = {
  max_turns_exhausted: "本阶段回合预算已用尽；原代码与实施指令已保留，接续前可检查进度。",
  budget_exhausted: "先调整调用预算，再接续已保存的工作。",
  permission_denied: "先检查被拒绝操作的权限与任务范围，再接续。",
  authentication_failed: "先完成 CLI 登录，再恢复。",
  quota_exhausted: "先等待额度恢复或调整账号，再接续；重复点击不会恢复额度。",
  model_unavailable: "先选择可用模型，再恢复。",
  transient_failure: "服务暂时不可用；恢复前会检查原提交。",
  interrupted: "服务曾中断；可恢复提交或检查并接续未完成工作。",
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
  return <div className="delegation-recovery">
    {delegation.failureCode && HINTS[delegation.failureCode] ? <p>{t(HINTS[delegation.failureCode]!)}</p> : null}
    {!delegation.headCommit && delegation.baseCommit ? <p>{t("尚未生成交付提交；可以检查并接续原工作区中的代码，旧文件与失败记录会保留。")}</p> : null}
    {delegation.baseCommit ? <button type="button" disabled={busy} onClick={() => {
      setBusy(true); setMessage(null);
      void repository.resumeWorkItemDelegation(delegation.id, expectedVersion)
        .then(() => setMessage(delegation.headCommit
          ? "已从提交进度恢复，正在重新审核。"
          : "已接续未完成工作，将继续执行并审核。"))
        .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "恢复失败"))
        .finally(() => setBusy(false));
    }}>{t(busy ? "正在检查恢复条件…" : delegation.headCommit ? "从已提交进度恢复" : "接续未完成工作")}</button> : <p>{t("没有可恢复的工作区；重新委派将从项目当前基线开始。")}</p>}
    {message ? <p role="status">{t(message)}</p> : null}
  </div>;
}
