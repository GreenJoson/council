/** @input 旧失败委派与仓储上下文；@output 中英恢复入口和运行状态限制；@pos 防止未提交工作被误导为只能从头委派。 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DelegationRecoveryActions } from "../src/components/DelegationRecoveryActions";
import { ExecutionRepositoryContext } from "../src/hooks/useExecutionRepository";
import type { OrchestrationRepository } from "../src/data/orchestration-repository";
import { I18nProvider } from "../src/i18n/I18nProvider";
import type { WorkItemDelegation } from "../src/types/orchestration";

const draft: WorkItemDelegation = {
  id: "delegation-old", topicId: "topic-test", workItemId: "item-test",
  supervisorAgentId: "reviewer", executorAgentId: "executor", permissionProfile: "workspace_write",
  status: "failed", attempt: 1, maxAttempts: 2, baseCommit: "a".repeat(40),
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};
const repository = { resumeWorkItemDelegation: async () => { throw new Error("render must not execute"); } } as unknown as OrchestrationRepository;
const render = (changes: Partial<WorkItemDelegation> = {}, locale: "zh-CN" | "en" = "zh-CN") => renderToStaticMarkup(
  <I18nProvider initialLocale={locale}><ExecutionRepositoryContext.Provider value={repository}>
    <DelegationRecoveryActions delegation={{ ...draft, ...changes }} expectedVersion={3} />
  </ExecutionRepositoryContext.Provider></I18nProvider>,
);

describe("失败任务接续", () => {
  it("未提交的旧记录显示接续入口，并说明保留原文件", () => {
    expect(render()).toContain("接续未完成工作");
    expect(render()).toContain("旧文件与失败记录会保留");
    const english = render({}, "en");
    expect(english).not.toMatch(/[\u4e00-\u9fff]/u);
    expect(english).toContain("Continue unfinished work");
  });
  it("已提交记录仍恢复提交，没有基线则提示重新委派", () => {
    expect(render({ headCommit: "b".repeat(40) })).toContain("从已提交进度恢复");
    expect(render({ baseCommit: undefined })).not.toContain("<button");
    expect(render({ baseCommit: undefined })).toContain("没有可恢复的工作区");
  });
  it("活动与已审核的委派不显示恢复按钮", () => {
    expect(render({ status: "executing" })).toBe("");
    expect(render({ status: "approved" })).toBe("");
    expect(render({ status: "cancelled" })).toContain("接续未完成工作");
  });
});
