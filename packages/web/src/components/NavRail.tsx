/**
 * @input  依赖：lucide 图标、app/routes 的 WorkspaceRoute/WorkspaceView、界面语言、BrandLogo
 * @output 导出：NavRail —— V2 壳最左侧图标栏：品牌、会话/需要我处理/资产/架构档案/决策记录五个入口、
 *         偏好与模型设置、手机端打开会话列表的入口
 * @pos    一级导航，只回调路由对象由 App 壳写 hash；「会话」同时覆盖讨论/任务/流水线三个视图；
 *         ≤920px 时由 responsive.css 变成底栏
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
  onNavigate: (route: WorkspaceRoute) => void;
  onOpenTopics: () => void;
  onOpenPreferences: () => void;
  onOpenSettings: () => void;
}

export function NavRail({
  activeView,
  activeTopicId,
  onNavigate,
  onOpenTopics,
  onOpenPreferences,
  onOpenSettings,
}: NavRailProps) {
  const { t } = useI18n();
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
          return (
            <button
              key={id}
              className={`nav-rail-item ${active ? "active" : ""}`}
              type="button"
              aria-current={active ? "page" : undefined}
              aria-label={t(label)}
              title={t(label)}
              onClick={() => onNavigate(route(activeTopicId))}
            >
              <Icon size={20} aria-hidden="true" />
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
