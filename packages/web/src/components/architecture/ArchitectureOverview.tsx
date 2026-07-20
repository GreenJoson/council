/**
 * @input  依赖：项目名称/路径与已加载议题详情统计出的决策计数
 * @output 导出：ArchitectureOverview 架构档案第一区块——项目概览统计卡片
 * @pos    ArchitectureView 的顶部区块；纯展示，不发起请求
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { CheckCircle2, FolderGit2, Layers, ShieldCheck } from "lucide-react";

export interface ArchitectureOverviewProps {
  projectName: string;
  /** 桌面原生模式下的项目绝对路径；mock/http 模式下没有该信息，省略展示 */
  projectPath?: string;
  topicCount: number;
  acceptedCount: number;
  proposedCount: number;
  /** 议题详情仍在加载中时的进度提示；全部加载完成后为 null，不占用界面空间 */
  loadingProgressLabel: string | null;
}

export function ArchitectureOverview({
  projectName,
  projectPath,
  topicCount,
  acceptedCount,
  proposedCount,
  loadingProgressLabel,
}: ArchitectureOverviewProps) {
  return (
    <section className="architecture-overview" aria-label="项目概览">
      <div className="architecture-overview-heading">
        <div className="architecture-overview-project">
          <FolderGit2 size={18} aria-hidden="true" />
          <div>
            <h2>{projectName}</h2>
            {projectPath ? <p className="architecture-overview-path">{projectPath}</p> : null}
          </div>
        </div>
        {loadingProgressLabel ? (
          <span className="architecture-overview-loading" role="status">
            {loadingProgressLabel}
          </span>
        ) : null}
      </div>
      <dl className="architecture-overview-stats">
        <div className="architecture-stat">
          <dt>
            <Layers size={15} aria-hidden="true" />
            议题数
          </dt>
          <dd>{topicCount}</dd>
        </div>
        <div className="architecture-stat">
          <dt>
            <CheckCircle2 size={15} aria-hidden="true" />
            已接受决策
          </dt>
          <dd>{acceptedCount}</dd>
        </div>
        <div className="architecture-stat">
          <dt>
            <ShieldCheck size={15} aria-hidden="true" />
            提案中
          </dt>
          <dd>{proposedCount}</dd>
        </div>
      </dl>
    </section>
  );
}
