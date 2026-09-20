/**
 * @input  依赖：当前项目的议题锚点、编排仓储、revision 和跳转回调
 * @output 导出：决策、验收、阻断与失败的聚合处理入口
 * @pos    保留事项在原议题中的上下文，只汇总需要处理的真实状态
 */
import { useEffect, useState } from "react";
import { useExecutionRepository } from "../hooks/useExecutionRepository";
import { useI18n } from "../i18n/I18nProvider";
import type { WorkAttention } from "../data/work-attention";

export function WorkAttentionView({ topicId, revision, executionRevision, onOpenTopic }: {
  topicId?: string;
  revision: unknown;
  executionRevision: unknown;
  onOpenTopic: (id: string) => void;
}) {
  const { t } = useI18n();
  const repository = useExecutionRepository();
  const [items, setItems] = useState<WorkAttention[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setBusy(true);
    setError(null);
    const request = repository && topicId ? repository.listWorkAttention(topicId) : Promise.resolve([]);
    void request.then((result) => { if (active) setItems(result); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "待处理列表读取失败"); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [repository, topicId, revision, executionRevision, retry]);
  return <main className="work-attention-view">
    <header><h1>{t("需要我处理")}</h1><button type="button" disabled={busy} onClick={() => setRetry((value) => value + 1)}>{t("刷新")}</button></header>
    <p>{t("汇总当前项目的待确认决策、待验收任务和阻断问题；处理后自动移出。")}</p>
    {error ? <p role="alert">{t(error)}</p> : busy && items.length === 0 ? <p role="status">{t("加载中…")}</p>
      : items.length === 0 ? <p>{t("当前没有需要处理的事项。")}</p> : null}
    {!error ? <ul>{items.map((item) => <li key={item.topicId}>
      <button type="button" onClick={() => onOpenTopic(item.topicId)}>
        <strong>{item.title}</strong>
        <span>{([
          [item.decisions, "待确认决策"], [item.acceptance, "待人工验收"], [item.blocked, "阻断问题"],
          [item.failures, "执行失败"], [item.questions, "等待回复或确认"],
        ] as const).filter(([count]) => count > 0).map(([count, label]) => `${t(label)} ${count}`).join(" · ")}</span>
      </button>
    </li>)}</ul> : null}
  </main>;
}
