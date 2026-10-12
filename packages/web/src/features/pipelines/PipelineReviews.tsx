/**
 * @input  依赖：界面语言、流水线复盘记录（reviews）；components/FoldableContent 的区块搜索与高亮、app/routes 的 buildHash
 * @output 导出：PipelineReviews —— 流水线详情的「复盘记录」区：每轮一个可收起的条目（标题显示结论与不合格数），
 *         默认只展开最新一轮；不合格项分行显示问题与改法，交付物 id 链接到对应资产；标题栏搜索按交付物/资产 id、问题、改法过滤，
 *         有查询时只留有命中的轮次并全部展开
 * @pos    PipelineDetailView 的只读子区块，没有复盘记录时由调用方不渲染
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { buildHash } from "../../app/routes";
import { Highlight, SectionSearch, normalizeQuery, textMatches } from "../../components/FoldableContent";
import { useI18n } from "../../i18n/I18nProvider";
import type { PipelineReview } from "../../types/pipelines";

export function PipelineReviews({ reviews }: { reviews: readonly PipelineReview[] }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const latestRound = reviews[reviews.length - 1]?.round;
  // 记录用户手动切换过的轮次；未切换过的按「只展开最新一轮」默认处理，新一轮到来时自动展开它。
  const [toggled, setToggled] = useState<ReadonlyMap<number, boolean>>(new Map());
  const searching = Boolean(normalizeQuery(query));

  const rounds = reviews.map((review) => {
    const failed = review.items.filter((item) => !item.ok);
    const hits = failed.filter((item) => textMatches(query, item.deliverableId, item.assetId, item.issue, item.change));
    return { review, failed, hits };
  });
  const visible = searching ? rounds.filter((entry) => entry.hits.length > 0) : rounds;
  const hitCount = visible.reduce((sum, entry) => sum + entry.hits.length, 0);
  const isOpen = (round: number) => searching || (toggled.get(round) ?? round === latestRound);

  return (
    <section className="task-detail-section" data-pipeline-reviews>
      <div className="task-section-head">
        <h2>{t("复盘记录")}</h2>
        <SectionSearch
          value={query}
          onChange={setQuery}
          label={t("在复盘记录中搜索")}
          placeholder={t("搜索交付物、问题或改法…")}
          status={searching ? t("{count} 项匹配", { count: hitCount }) : undefined}
        />
      </div>
      {visible.length === 0 ? <p className="task-muted">{t("没有匹配的内容。")}</p> : null}
      <ol className="pipeline-reviews">
        {visible.map(({ review, failed, hits }) => {
          const open = isOpen(review.round);
          return (
            <li key={review.round}>
              <button
                className="pipeline-review-head"
                type="button"
                aria-expanded={open}
                onClick={() => setToggled((current) => new Map(current).set(review.round, !open))}
              >
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <strong>{t("第 {round} 轮", { round: review.round })}</strong>
                <span className={`pipeline-stage-badge is-${review.verdict === "pass" ? "completed" : "failed"}`}>
                  {review.verdict === "pass" ? t("通过") : t("需返工")}
                </span>
                <small className="task-muted">
                  {failed.length > 0
                    ? t("{failed} / {total} 项需修改", { failed: failed.length, total: review.items.length })
                    : t("{total} 项全部合格", { total: review.items.length })}
                </small>
              </button>
              {open && hits.length > 0 ? (
                <ul className="pipeline-review-items">
                  {hits.map((item) => (
                    <li key={`${item.assetId}-${item.deliverableId}`}>
                      <a href={buildHash({ view: "assets", assetId: item.assetId })}>
                        <code><Highlight text={item.deliverableId} query={query} /></code>
                      </a>
                      {item.issue ? <p><Highlight text={item.issue} query={query} /></p> : null}
                      {item.change ? (
                        <p className="pipeline-review-change">
                          <span>{t("改法")}</span> <Highlight text={item.change} query={query} />
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
