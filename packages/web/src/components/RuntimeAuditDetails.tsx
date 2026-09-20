/**
 * @input  依赖：运行来源、显式注入的编排仓储
 * @output 导出：按需加载、游标分页的公开运行证据
 * @pos    讨论调用和实施委派共用的详情视图；旧记录缺失时明确说明
 */
import { useEffect, useState } from "react";
import { useExecutionRepository } from "../hooks/useExecutionRepository";
import { useI18n } from "../i18n/I18nProvider";
import type { RuntimeAuditPage, RuntimeAuditQuery } from "../data/runtime-audit";

const LABELS: Record<string, string> = {
  "delegation.created": "派发与完成条件", "delegation.resumed": "恢复已提交进度",
  "brief.started": "开始制定实施指令", "brief.completed": "实施指令", "brief.failed": "实施指令失败",
  "execution.started": "开始执行", "execution.completed": "执行结果", "execution.failed": "执行失败",
  "review.started": "开始审核", "review.completed": "审核结果", "review.failed": "审核失败",
  "commit.created": "提交证据", "turn.started": "调用开始", "turn.completed": "调用结束",
  "turn.failed": "调用失败", "turn.aborted": "调用取消", "tool.requested": "请求工具",
  "tool.started": "工具开始", "tool.completed": "工具完成", "approval.required": "工具等待授权",
  "delegation.failed": "委派失败", "delegation.cancelled": "委派已取消", "delegation.interrupted": "进程中断",
};

const FIELD_LABELS: Record<string, string> = {
  agentId: "Agent", bindingId: "会话绑定", toolName: "工具", callId: "工具调用", owner: "工具执行方",
  model: "模型", agentRevision: "Agent 配置版本", providerRevision: "Provider 配置版本", permission: "权限",
  summary: "摘要", elapsedMs: "耗时（毫秒）", baseCommit: "基线提交", headCommit: "结果提交",
  criteria: "验收标准", completionPolicy: "完成条件", previousId: "原委派", failureCode: "失败分类", transportAttempt: "调用尝试",
};

export function RuntimeAuditDetails(props: Omit<RuntimeAuditQuery, "after">) {
  const { t } = useI18n();
  const repository = useExecutionRepository();
  const [open, setOpen] = useState(false);
  if (!repository) return null;
  return <details className="runtime-audit" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{t("查看执行记录")}</summary>
    {open ? <AuditBody key={`${props.topicId}:${props.sourceKind}:${props.sourceId}`} {...props} /> : null}
  </details>;
}

function AuditBody(props: Omit<RuntimeAuditQuery, "after">) {
  const { t } = useI18n();
  const repository = useExecutionRepository()!;
  const [page, setPage] = useState<RuntimeAuditPage>({ events: [], hasMore: false, nextCursor: 0 });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [request, setRequest] = useState({ after: 0, tick: 0 });
  useEffect(() => {
    let active = true;
    setBusy(true);
    setError(null);
    void repository.listRuntimeAudit({ ...props, after: request.after }).then((result) => {
      if (active) setPage((current) => ({ ...result, events: [...current.events, ...result.events] }));
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "运行记录读取失败");
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [repository, props.topicId, props.sourceId, props.sourceKind, request]);
  return <div className="runtime-audit-body">
    {props.sourceKind === "delegation" ? <p>{t("记录派发、执行摘要、提交与审核；当前 CLI 未提供的工具明细不会补造。")}</p> : null}
    {error ? <p role="alert">{t(error)}</p> : null}
    {!busy && !error && page.events.length === 0 ? <p>{t("暂无持久运行记录；旧运行不会补造历史。")}</p> : null}
    <ol>{page.events.map((event) => <li key={event.id}>
      <strong>{t(LABELS[event.kind] ?? event.kind)}</strong>
      <small>{event.createdAt}{event.attempt > 0 ? ` · ${t("轮次")} ${event.attempt}` : ""}</small>
      {Object.entries(event.data).map(([key, value]) => <div key={key}><span>{t(FIELD_LABELS[key] ?? key)}</span><pre>{String(value)}</pre></div>)}
    </li>)}</ol>
    <button type="button" disabled={busy} onClick={() => setRequest((current) => ({ after: page.nextCursor, tick: current.tick + 1 }))}>
      {t(busy ? "加载中…" : error ? "重试" : page.hasMore ? "加载后续记录" : "刷新记录")}
    </button>
  </div>;
}
