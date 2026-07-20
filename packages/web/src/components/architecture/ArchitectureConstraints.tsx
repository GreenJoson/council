/**
 * @input  依赖：selectors.ts 聚合并去重后的 AggregatedConstraint 列表
 * @output 导出：ArchitectureConstraints 架构档案第三区块——跨议题聚合的架构不变量
 * @pos    ArchitectureView 的第三区块；每条约束标注全部来源议题（已有已接受/被取代
 *         决策的来源附带 ADR 编号 + 时间）；纯展示，不发起请求
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { Check, ShieldAlert, TriangleAlert } from "lucide-react";
import type { AggregatedConstraint } from "../../data/selectors";

export interface ArchitectureConstraintsProps {
  constraints: AggregatedConstraint[];
}

export function ArchitectureConstraints({ constraints }: ArchitectureConstraintsProps) {
  return (
    <section className="architecture-constraints" aria-label="架构不变量">
      <header className="architecture-section-header">
        <h2>
          <ShieldAlert size={17} aria-hidden="true" />
          架构不变量
        </h2>
        <span className="count-pill">{constraints.length}</span>
      </header>

      {constraints.length === 0 ? (
        <p className="architecture-section-empty">
          还没有约束条件。在议题里添加约束后，会去重聚合展示在这里。
        </p>
      ) : (
        <ul className="architecture-constraint-list">
          {constraints.map((constraint) => (
            <li key={constraint.label} className={`architecture-constraint-item tone-${constraint.tone}`}>
              {constraint.tone === "warning" ? (
                <TriangleAlert className="warning-icon" size={16} aria-hidden="true" />
              ) : (
                <Check className="positive-icon" size={16} aria-hidden="true" />
              )}
              <div>
                <p className="architecture-constraint-label">{constraint.label}</p>
                <p className="architecture-constraint-sources">
                  {constraint.sources.map((source, index) => (
                    <span key={source.topicId}>
                      {index > 0 ? <span aria-hidden="true">、</span> : null}
                      {source.adrNumber ? `${source.adrNumber} · ` : ""}
                      {source.topicTitle}
                      <span aria-hidden="true"> · </span>
                      {source.timeLabel}
                    </span>
                  ))}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
