/**
 * @input  依赖：React、WorkspaceRoute/navigate、工作区快照、当前选中议题 id 与内容控制器的 selectTopic
 * @output 导出：useTopicRouteSync —— 议题选择与 #/discussion/<topicId> 的双向同步，以及 openTopic(topicId) 动作
 * @pos    hash → 选题：hash 中的 topicId 变化（刷新、前进后退、手改地址栏、侧栏点击）时若该议题存在则选中，
 *         不存在则不动，交给内容控制器的默认选题逻辑；
 *         选题 → hash：当前议题因任何来源变化（SSE、新建、人工决策、默认选题），或 hash 缺 id/指向不存在议题时，用 replace 写回 hash。
 *         pendingTopicRef 防止"hash 请求的议题仍在加载"时被旧选中议题反向覆盖
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { useEffect, useRef } from "react";
import type { WorkspaceSnapshot } from "../types/council";
import { buildHash, type WorkspaceRoute } from "./routes";
import type { NavigateOptions } from "./use-workspace-route";

export interface TopicRouteSyncOptions {
  route: WorkspaceRoute;
  navigate: (route: WorkspaceRoute, options?: NavigateOptions) => void;
  workspace: WorkspaceSnapshot | null;
  activeTopicId: string;
  selectTopic: (topicId: string) => Promise<void>;
}

export function useTopicRouteSync({
  route,
  navigate,
  workspace,
  activeTopicId,
  selectTopic,
}: TopicRouteSyncOptions): { openTopic: (topicId: string) => void } {
  const pendingTopicRef = useRef<string | null>(null);
  const routeTopicId = route.view === "discussion" ? route.topicId : undefined;
  const workspaceReady = workspace !== null;

  function requestTopic(topicId: string): void {
    pendingTopicRef.current = topicId;
    void selectTopic(topicId).finally(() => {
      if (pendingTopicRef.current === topicId) {
        pendingTopicRef.current = null;
      }
    });
  }

  // hash → 选题。刻意不依赖 topics/activeTopicId：SSE 推来的新快照或服务端切换议题不应
  // 让旧 hash 把选择抢回去；只有 hash 本身变化或工作区（重新）就绪时才按 hash 选题
  useEffect(() => {
    if (!routeTopicId || !workspace || routeTopicId === activeTopicId) {
      return;
    }
    if (!workspace.topics.some((topic) => topic.id === routeTopicId)) {
      return;
    }
    requestTopic(routeTopicId);
  }, [routeTopicId, workspaceReady]);

  // 选题 → hash（replace，不新增历史条目）。也随 hash 变化重跑：hash 指向不存在的议题、
  // 或 #/discussion 不带 id 时，就地改写为当前实际选中的议题
  useEffect(() => {
    if (route.view !== "discussion" || !activeTopicId) {
      return;
    }
    if (pendingTopicRef.current && pendingTopicRef.current !== activeTopicId) {
      return;
    }
    if (routeTopicId !== activeTopicId) {
      navigate({ view: "discussion", topicId: activeTopicId }, { replace: true });
    }
  }, [activeTopicId, route.view, routeTopicId]);

  /** 架构档案、决策记录、待处理和侧栏议题列表共用：切回议题视图并选中该议题 */
  function openTopic(topicId: string): void {
    const target: WorkspaceRoute = { view: "discussion", topicId };
    if (window.location.hash === buildHash(target)) {
      // hash 已是目标（例如上次选题失败），hash 不会变化，直接重试选题
      requestTopic(topicId);
      return;
    }
    navigate(target);
  }

  return { openTopic };
}
