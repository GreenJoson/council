/**
 * @input  依赖：lucide 图标、app/routes 的 WorkspaceRoute/WorkspaceView、界面语言、BrandLogo
 * @output 导出：NavRail —— V2 壳最左侧图标栏：品牌、会话/需要我处理/资产/架构档案/决策记录五个入口、
 *         偏好与模型设置、手机端打开会话列表的入口；「会话」徽标显示活动 Agent 数、「需要我处理」徽标显示待处理议题数
 * @pos    一级导航，只回调路由对象由 App 壳写 hash；「会话」同时覆盖讨论/任务/流水线三个视图；
 *         徽标数字来自编排快照的 activity（离线或未选题时为空即不显示）；≤920px 时由 responsive.css 变成底栏
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  FileCheck2,
  GitBranch,
  Images,
  Inbox,
  Menu,
  MessagesSquare,
  Settings2,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import type { WorkspaceRoute, WorkspaceView } from "../app/routes";
import { useI18n } from "../i18n/I18nProvider";
import { BrandLogo } from "./presentation";

interface RailItem {
  id: string;
  label: string;
  Icon: LucideIcon;
  views: readonly WorkspaceView[];
  route: (activeTopicId: string | undefined) => WorkspaceRoute;
}

const railItems: readonly RailItem[] = [
  {
    id: "conversations",
    label: "会话",
    Icon: MessagesSquare,
    views: ["discussion", "tasks", "pipelines"],
    route: (activeTopicId) => ({ view: "discussion", topicId: activeTopicId }),
  },
  { id: "attention", label: "需要我处理", Icon: Inbox, views: ["attention"], route: () => ({ view: "attention" }) },
  { id: "assets", label: "资产", Icon: Images, views: ["assets"], route: () => ({ view: "assets" }) },
  { id: "architecture", label: "架构档案", Icon: GitBranch, views: ["architecture"], route: () => ({ view: "architecture" }) },
  { id: "decisions", label: "决策记录", Icon: FileCheck2, views: ["decisions"], route: () => ({ view: "decisions" }) },
];

export interface NavRailProps {
  activeView: WorkspaceView;
  activeTopicId?: string;
  /** 当前项目正在跑的 Agent 数；未知时不显示徽标。 */
  activeAgentCount?: number;
  /** 当前项目需要人处理的议题数；未知时不显示徽标。 */
  attentionCount?: number;
  onNavigate: (route: WorkspaceRoute) => void;
  onOpenTopics: () => void;
  onOpenPreferences: () => void;
  onOpenSettings: () => void;
}

export function NavRail({
  activeView,
  activeTopicId,
  activeAgentCount,
  attentionCount,
  onNavigate,
  onOpenTopics,
  onOpenPreferences,
  onOpenSettings,
}: NavRailProps) {
  const { t } = useI18n();
  // 徽标只在计数已知且大于 0 时出现；0 和未知在图标栏上都该是安静的
  const badges: Record<string, { count: number; label: string } | undefined> = {
    conversations: activeAgentCount
      ? { count: activeAgentCount, label: t("{count} 个 Agent 运行中", { count: activeAgentCount }) }
      : undefined,
    attention: attentionCount
      ? { count: attentionCount, label: t("{count} 个议题需要处理", { count: attentionCount }) }
      : undefined,
  };
  return (
    <nav className="nav-rail" aria-label={t("主导航")}>
      <a className="nav-rail-brand" href="#main-content" aria-label={t("Council 首页")}>
        <BrandLogo size={28} />
      </a>
      <button
        className="icon-button mobile-panel-button"
        type="button"
        aria-label={t("打开议题导航")}
        onClick={onOpenTopics}
      >
        <Menu size={19} />
      </button>
      <div className="nav-rail-items">
        {railItems.map(({ id, label, Icon, views, route }) => {
          const active = views.includes(activeView);
          const badge = badges[id];
          return (
            <button
              key={id}
              className={`nav-rail-item ${active ? "active" : ""}`}
              type="button"
              aria-current={active ? "page" : undefined}
              aria-label={badge ? `${t(label)} · ${badge.label}` : t(label)}
              title={badge ? `${t(label)} · ${badge.label}` : t(label)}
              onClick={() => onNavigate(route(activeTopicId))}
            >
              <Icon size={20} aria-hidden="true" />
              {badge ? (
                <span className={`nav-rail-badge nav-rail-badge-${id}`} aria-hidden="true">
                  {badge.count > 99 ? "99+" : badge.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="nav-rail-spacer" aria-hidden="true" />
      <div className="nav-rail-items nav-rail-footer">
        <button
          className="nav-rail-item"
          type="button"
          aria-label={t("打开偏好")}
          title={t("偏好")}
          onClick={onOpenPreferences}
        >
          <SlidersHorizontal size={20} aria-hidden="true" />
        </button>
        <button
          className="nav-rail-item"
          type="button"
          aria-label={t("打开模型与 Provider 设置")}
          title={t("模型与 Provider 设置")}
          onClick={onOpenSettings}
        >
          <Settings2 size={20} aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}
