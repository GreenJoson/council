/**
 * @input  依赖：无（纯函数，不读 window）
 * @output 导出：WorkspaceView 视图类型、WORKSPACE_VIEWS 常量、WorkspaceRoute 路由模型、parseRoute/buildHash 纯函数
 * @pos    工作区视图与 URL hash 的唯一映射：#/discussion[/<topicId>]、#/tasks[/<taskId>]、
 *         #/decisions、#/architecture、#/attention；未知或空 hash 一律回落到 discussion
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

/** Operator Console 工作区视图：议题讨论、任务、决策归档、架构档案、待处理聚合 */
export const WORKSPACE_VIEWS = [
  "discussion",
  "tasks",
  "decisions",
  "architecture",
  "attention",
] as const;

export type WorkspaceView = (typeof WORKSPACE_VIEWS)[number];

/**
 * 路由模型。只有 discussion 和 tasks 可带实体 id，其余视图是项目级聚合，没有下钻 id。
 * id 可选：缺省时由各视图自行决定默认选中项（议题回落到默认选题逻辑）。
 */
export type WorkspaceRoute =
  | { view: "discussion"; topicId?: string }
  | { view: "tasks"; taskId?: string }
  | { view: "decisions" }
  | { view: "architecture" }
  | { view: "attention" };

export const DEFAULT_ROUTE: WorkspaceRoute = { view: "discussion" };

function isWorkspaceView(value: string): value is WorkspaceView {
  return (WORKSPACE_VIEWS as readonly string[]).includes(value);
}

function decodeSegment(segment: string | undefined): string | undefined {
  if (!segment) {
    return undefined;
  }
  try {
    return decodeURIComponent(segment) || undefined;
  } catch {
    // 手改 URL 时可能出现非法百分号编码，按"没有 id"处理而不是抛错
    return undefined;
  }
}

/** 解析 location.hash（带或不带前导 #）；任何无法识别的输入都回落到默认议题视图 */
export function parseRoute(hash: string): WorkspaceRoute {
  const path = hash.replace(/^#/, "").replace(/^\/+/, "");
  const [head = "", rawId] = path.split("/");
  if (!isWorkspaceView(head)) {
    return DEFAULT_ROUTE;
  }
  const id = decodeSegment(rawId);
  switch (head) {
    case "discussion":
      return id ? { view: "discussion", topicId: id } : { view: "discussion" };
    case "tasks":
      return id ? { view: "tasks", taskId: id } : { view: "tasks" };
    default:
      return { view: head };
  }
}

/** 生成带前导 # 的 hash；id 做 URI 编码，保证 parseRoute(buildHash(r)) 往返一致 */
export function buildHash(route: WorkspaceRoute): string {
  const id = route.view === "discussion"
    ? route.topicId
    : route.view === "tasks"
      ? route.taskId
      : undefined;
  return id ? `#/${route.view}/${encodeURIComponent(id)}` : `#/${route.view}`;
}
