/** @input 持久阶段及预算暂停；@output 真实阶段、缺失指标隐藏和中英显示；@pos 防止生成指令被显示为代码已执行。 */
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { DelegationExecutionProgress, delegationStatusLabel, isDelegationPaused } from "../src/components/DelegationExecutionProgress";
import { WorkItemDelegationPanel } from "../src/components/WorkItemDelegationPanel";
import type { CouncilWorkItem } from "../src/types/council";
import { I18nProvider } from "../src/i18n/I18nProvider";
import { parseWorkItemDelegation } from "../src/data/orchestration-api";
import type { WorkItemDelegation } from "../src/types/orchestration";
const base: WorkItemDelegation = {
  id: "delegation-test", topicId: "topic-test", workItemId: "item-test", supervisorAgentId: "reviewer", executorAgentId: "executor",
  permissionProfile: "workspace_write", status: "executing", attempt: 1, maxAttempts: 2,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};
const stamp = "2026-01-01T00:00:00Z";
const render = (run: WorkItemDelegation, locale: "en" | "zh-CN" = "zh-CN") => renderToStaticMarkup(
  <I18nProvider initialLocale={locale}><DelegationExecutionProgress delegation={run} /></I18nProvider>,
);
it("生成指令、实施、提交、审核与暂停各自有真实标签", () => {
  expect(delegationStatusLabel({ ...base, execution: { phase: "brief", phaseStartedAt: stamp, lastActivityAt: stamp } })).toBe("生成实施指令");
  const paused = { ...base, status: "failed", failureCode: "max_turns_exhausted" } as WorkItemDelegation;
  expect(isDelegationPaused(paused)).toBe(true);
  expect(delegationStatusLabel(paused)).toBe("已暂停，等待接续");
  expect(isDelegationPaused({ ...paused, failureCode: "permission_denied" })).toBe(false);
  expect(isDelegationPaused({ ...paused, failureCode: "execution_failed", error: "审核在最大修订轮次内未通过。" })).toBe(true);
});
it("旧记录与未知指标不补造零值，实际预算和活动有英文翻译", () => {
  expect(render(base)).toBe("");
  const execution = { phase: "execution", phaseStartedAt: stamp, lastActivityAt: stamp } as const;
  expect(render({ ...base, execution })).not.toMatch(/模型回合|工具调用/);
  const html = render({ ...base, execution: { ...execution, turnsUsed: 25, turnLimit: 120, toolCalls: 21, lastTool: "Read", checkpointAvailable: true } }, "en");
  expect(html).toContain("25/120"); expect(html).toContain("Observed tool calls: 21");
  expect(html).toContain("Instructions saved"); expect(html).not.toMatch(/[\u4e00-\u9fff]/u);
});
it("协议解析保留已验证进度，拒绝非法阶段/负数并忽略私有扩展", () => {
  const raw = { ...base, execution: { phase: "review", phaseStartedAt: stamp, lastActivityAt: stamp, toolCalls: 3, sessionId: "private", brief: "private" } };
  expect(parseWorkItemDelegation(raw).execution?.phase).toBe("review");
  expect(JSON.stringify(parseWorkItemDelegation(raw))).not.toContain("private");
  expect(() => parseWorkItemDelegation({ ...raw, execution: { ...raw.execution, phase: "unknown" } })).toThrow();
  expect(() => parseWorkItemDelegation({ ...raw, execution: { ...raw.execution, turnsUsed: -1 } })).toThrow();
});

it("长验收标准默认折叠，暂停卡保留清晰的阶段与失败原因", () => {
  const delegation: WorkItemDelegation = { ...base, status: "failed", failureCode: "max_turns_exhausted", acceptanceCriteria: "LONG_CRITERIA", error: "Claude 工具回合预算已用尽，执行已暂停；已保留进度，请检查后接续。" };
  const html = renderToStaticMarkup(<I18nProvider initialLocale="en"><WorkItemDelegationPanel
    item={{ title: "task", details: "details", status: "blocked", version: 1 } as CouncilWorkItem}
    adapters={[]} delegation={delegation} busyAction={null} onStart={async () => {}} onCancel={async () => {}} /></I18nProvider>);
  expect(html).toContain("is-paused");
  expect(html).toContain("Paused, awaiting continuation");
  expect(html).toContain('<details class="delegation-criteria">');
  expect(html).not.toContain('open=""');
  expect(html).not.toMatch(/[\u4e00-\u9fff]/u);
});

it("二轮修正显示已有提交与上轮审核问题，不能继续伪装成首次执行", () => {
  const run: WorkItemDelegation = { ...base, attempt: 2, headCommit: "a".repeat(40),
    execution: { phase: "execution", phaseStartedAt: stamp, lastActivityAt: stamp },
    review: JSON.stringify({ verdict: "changes_requested", summary: "Boundary validation needed", findings: ["Handle unknown direction"] }) };
  expect(delegationStatusLabel(run)).toBe("按审核意见修正");
  const html = renderToStaticMarkup(<I18nProvider initialLocale="en"><WorkItemDelegationPanel
    item={{ title: "task", status: "in_progress", version: 1 } as CouncilWorkItem} adapters={[]} delegation={run}
    busyAction={null} onStart={async () => {}} onCancel={async () => {}} /></I18nProvider>);
  expect(html).toContain("Addressing review findings");
  expect(html).toContain("Code commit saved: aaaaaaaaaaaa");
  expect(html).toContain("Previous review: 1 findings to address");
  expect(html).toContain("Handle unknown direction");
  expect(html).not.toMatch(/[\u4e00-\u9fff]/u);
  expect(delegationStatusLabel({ ...run, review: "invalid" })).toBe("执行与验证");
  expect(isDelegationPaused({ ...run, status: "failed", failureCode: "review_revision_limit" })).toBe(true);
});
