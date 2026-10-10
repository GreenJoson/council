/**
 * @input  依赖：API 任务行与委派协议类型、mock-data 的 Actor 快照
 * @output 导出：MOCK_TASK_PROJECT_PATH、MOCK_TEAM_TASK_ID 与 createMockTaskFixtures()（任务行 + 委派 + 团队的深拷贝夹具）
 * @pos    任务看板与详情的脱敏 mock 数据源：7 条直接任务覆盖四种状态与 image/research/prototype
 *         类型（image 任务的 brief 是 council-brief v1），2 条挂 topic-idempotency 的议题任务，3 条委派（reviewing、approved
 *         与团队 Lead 的 executing），1 个活动团队（3 个 Worker：running+聚焦 / done 已合并 / error 被打断）
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { ApiWorkItem } from "../api-types";
import { mockActorSnapshot } from "../mock-data";
import type { WorkItemDelegation } from "../../types/orchestration";
import type { TaskTeam } from "../../types/team";

/** 明显的占位路径，不对应任何真实目录。 */
export const MOCK_TASK_PROJECT_PATH = "/workspace/demo-project";

/** 议题任务挂到 mock 工作区里已存在的议题，便于从任务跳回议题。 */
const MOCK_TOPIC_ID = "topic-idempotency";

/** 带团队的 code 任务；E2E 与文档引用这个 id。 */
export const MOCK_TEAM_TASK_ID = "work_item_task_channel_adapter_split";

export interface MockTaskFixtures {
  tasks: ApiWorkItem[];
  delegations: WorkItemDelegation[];
  /** P4 团队；缺省视为没有任何团队。 */
  teams?: TaskTeam[];
}

function task(
  overrides: Partial<ApiWorkItem> & Pick<ApiWorkItem, "id" | "title" | "status" | "updatedAt">,
): ApiWorkItem {
  const creator = overrides.createdByActorId ?? "human";
  const updater = overrides.updatedByActorId ?? creator;
  return {
    kind: "code",
    source: "direct",
    priority: 0,
    projectPath: MOCK_TASK_PROJECT_PATH,
    details: "",
    sortOrder: 0,
    origin: "manual",
    version: 1,
    createdAt: "2026-10-08T02:00:00.000Z",
    ...overrides,
    createdByActorId: creator,
    createdBySnapshot: mockActorSnapshot(creator),
    updatedByActorId: updater,
    updatedBySnapshot: mockActorSnapshot(updater),
  };
}

const TASKS: ApiWorkItem[] = [
  task({
    id: "work_item_task_refund_signature",
    title: "退款回调补齐签名校验",
    details: "退款回调目前只校验来源 IP 白名单，需与支付回调共用同一套签名校验中间件。",
    status: "pending",
    priority: 20,
    brief: { acceptance: ["伪造签名返回 401", "重放请求被幂等键拦截"] },
    updatedAt: "2026-10-09T08:10:00.000Z",
  }),
  task({
    id: "work_item_task_cursor_pagination",
    title: "订单列表分页改为游标",
    details: "offset 分页在大商户下超时；改为按 (created_at, id) 游标分页并保留旧参数兼容一个版本。",
    status: "in_progress",
    priority: 10,
    version: 3,
    assigneeActorId: "codex",
    claimedAt: "2026-10-09T06:00:00.000Z",
    statusNote: "执行 Agent 已提交，等待监督复核。",
    updatedByActorId: "codex",
    updatedAt: "2026-10-09T09:30:00.000Z",
  }),
  task({
    id: "work_item_task_reconcile_research",
    title: "评估渠道对账文件格式",
    details: "比较三家渠道的对账文件字段与时区约定，给出统一解析层的建议。",
    kind: "research",
    status: "blocked",
    priority: 5,
    version: 2,
    statusNote: "等待渠道提供最新版字段说明。",
    updatedAt: "2026-10-08T11:00:00.000Z",
  }),
  task({
    id: "work_item_task_expire_idempotency_keys",
    title: "清理过期幂等键的定时任务",
    details: "按 TTL 批量删除过期幂等键，单批不超过 1000 条，避免长事务锁表。",
    status: "completed",
    priority: 0,
    version: 4,
    fixCommit: "4f9c2d1a7b3e",
    updatedByActorId: "codex",
    updatedAt: "2026-10-07T15:20:00.000Z",
    completedAt: "2026-10-07T15:20:00.000Z",
  }),
  task({
    id: "work_item_task_empty_state_art",
    title: "结算页空状态插画",
    details: "结算列表为空时的插画，需同时提供浅色与深色两版。",
    kind: "image",
    status: "pending",
    priority: 3,
    // council-brief v1：任务详情按结构化方式展示，产物区挂有 mock 资产库里的三张输出图
    brief: {
      schemaVersion: 1,
      kind: "concept-sheet",
      goal: "结算列表为空时的插画，浅色与深色各一版，另出一张透明底图标。",
      deliverables: [
        { id: "empty-light", description: "浅色主题空状态插画", size: "640x480" },
        { id: "empty-dark", description: "深色主题空状态插画", size: "640x480" },
        { id: "empty-icon", description: "透明底小图标", size: "256x256", transparent: true },
      ],
      style: { constraints: ["扁平线稿", "不出现文字"], references: ["asset_mock_brand_palette"] },
      acceptance: ["两版主题色与设计 token 一致", "图标背景透明"],
    },
    updatedAt: "2026-10-09T03:00:00.000Z",
  }),
  task({
    id: "work_item_task_merchant_nav_prototype",
    title: "商户后台导航原型",
    details: "把对账、退款、结算三个入口合并为一级导航，先出可点击原型再评审。",
    kind: "prototype",
    status: "pending",
    priority: 0,
    updatedAt: "2026-10-08T05:00:00.000Z",
  }),
  task({
    id: MOCK_TEAM_TASK_ID,
    title: "支付渠道适配层拆分",
    details: "把三家渠道的下单、回调与对账解析拆成独立适配器目录，由 Lead 按目录并行派发 Worker 后统一合并。",
    status: "in_progress",
    priority: 15,
    version: 2,
    assigneeActorId: "codex",
    claimedAt: "2026-10-10T01:00:00.000Z",
    updatedByActorId: "codex",
    updatedAt: "2026-10-10T02:40:00.000Z",
  }),
  task({
    id: "work_item_topic_idempotency_key_table",
    topicId: MOCK_TOPIC_ID,
    decisionId: "decision-idempotency-primary",
    source: "topic",
    title: "建立幂等键表与唯一约束",
    details: "按 (merchant_id, idempotency_key) 建唯一索引，记录首个结果摘要。",
    status: "in_progress",
    priority: 0,
    sortOrder: 0,
    version: 2,
    createdByActorId: "claude",
    updatedByActorId: "human",
    updatedAt: "2026-10-09T07:00:00.000Z",
  }),
  task({
    id: "work_item_topic_callback_state_machine",
    topicId: MOCK_TOPIC_ID,
    decisionId: "decision-idempotency-primary",
    source: "topic",
    title: "回调状态机拒绝非法迁移",
    details: "已完成订单收到重复成功回调时返回首个结果，不再触发下游。",
    status: "pending",
    priority: 0,
    sortOrder: 1,
    createdByActorId: "claude",
    updatedAt: "2026-10-08T09:00:00.000Z",
  }),
];

const DELEGATIONS: WorkItemDelegation[] = [
  {
    id: "delegation_task_cursor_pagination",
    workItemId: "work_item_task_cursor_pagination",
    supervisorAgentId: "claude",
    executorAgentId: "codex",
    permissionProfile: "workspace_write",
    completionPolicy: "review",
    acceptanceCriteria: "游标分页通过现有订单列表 E2E；旧 offset 参数仍可用。",
    status: "reviewing",
    kind: "code",
    inputAssetIds: [],
    attempt: 1,
    maxAttempts: 2,
    baseCommit: "9a1b2c3d4e5f",
    headCommit: "c0ffee1234ab",
    branchName: "council/task-cursor-pagination",
    summary: "订单列表改为游标分页，新增 cursor 参数并保留 offset 兼容。",
    execution: {
      phase: "review",
      phaseStartedAt: "2026-10-09T09:20:00.000Z",
      lastActivityAt: "2026-10-09T09:30:00.000Z",
      turnsUsed: 14,
      turnLimit: 40,
      toolCalls: 32,
      lastTool: "git_diff",
      checkpointAvailable: false,
    },
    createdAt: "2026-10-09T06:00:00.000Z",
    updatedAt: "2026-10-09T09:30:00.000Z",
  },
  {
    id: "delegation_task_expire_idempotency_keys",
    workItemId: "work_item_task_expire_idempotency_keys",
    supervisorAgentId: "claude",
    executorAgentId: "codex",
    permissionProfile: "workspace_write",
    completionPolicy: "review",
    acceptanceCriteria: "单批删除不超过 1000 条；定时任务可重入。",
    status: "approved",
    kind: "code",
    inputAssetIds: [],
    attempt: 1,
    maxAttempts: 2,
    baseCommit: "1234abcd5678",
    headCommit: "4f9c2d1a7b3e",
    branchName: "council/task-expire-idempotency-keys",
    summary: "新增按 TTL 分批清理的定时任务。",
    review: "批量大小与重入保护符合验收标准。",
    createdAt: "2026-10-07T12:00:00.000Z",
    updatedAt: "2026-10-07T15:20:00.000Z",
    completedAt: "2026-10-07T15:20:00.000Z",
  },
  {
    id: "delegation_task_channel_adapter_lead",
    workItemId: MOCK_TEAM_TASK_ID,
    supervisorAgentId: "claude",
    executorAgentId: "codex",
    permissionProfile: "workspace_write",
    completionPolicy: "human",
    acceptanceCriteria: "三家渠道适配器各自独立目录；合并后订单与回调 E2E 全部通过。",
    status: "executing",
    kind: "code",
    inputAssetIds: [],
    attempt: 0,
    maxAttempts: 2,
    baseCommit: "5e6f7a8b9c0d",
    branchName: "council/task-channel-adapter-split",
    execution: {
      phase: "execution",
      phaseStartedAt: "2026-10-10T01:05:00.000Z",
      lastActivityAt: "2026-10-10T02:40:00.000Z",
      turnsUsed: 9,
      turnLimit: 40,
      toolCalls: 21,
      lastTool: "council_wait_worker",
      checkpointAvailable: false,
    },
    createdAt: "2026-10-10T01:00:00.000Z",
    updatedAt: "2026-10-10T02:40:00.000Z",
  },
];

const TEAM_ID = "team_channel_adapter_split";

const TEAMS: TaskTeam[] = [
  {
    id: TEAM_ID,
    workItemId: MOCK_TEAM_TASK_ID,
    leadDelegationId: "delegation_task_channel_adapter_lead",
    status: "active",
    maxParallel: 3,
    createdAt: "2026-10-10T01:00:00.000Z",
    workers: [
      {
        id: "worker_channel_gateway",
        teamId: TEAM_ID,
        delegationId: "delegation_worker_channel_gateway",
        label: "渠道下单适配",
        role: "实现",
        status: "running",
        focused: true,
        branchName: "council/task-channel-adapter-split/worker-gateway",
        scopePaths: ["src/channels/gateway/"],
        createdAt: "2026-10-10T01:10:00.000Z",
        updatedAt: "2026-10-10T02:38:00.000Z",
        delegation: {
          status: "executing",
          execution: {
            phase: "execution",
            phaseStartedAt: "2026-10-10T01:12:00.000Z",
            lastActivityAt: "2026-10-10T02:38:00.000Z",
            turnsUsed: 12,
            turnLimit: 40,
            toolCalls: 27,
            lastTool: "apply_patch",
            checkpointAvailable: false,
          },
        },
      },
      {
        id: "worker_reconcile_parser",
        teamId: TEAM_ID,
        delegationId: "delegation_worker_reconcile_parser",
        label: "对账文件解析",
        role: "实现",
        status: "done",
        focused: false,
        branchName: "council/task-channel-adapter-split/worker-reconcile",
        mergedCommit: "7d3e9a1c0b52",
        scopePaths: ["src/channels/reconcile/", "test/reconcile/"],
        createdAt: "2026-10-10T01:10:00.000Z",
        updatedAt: "2026-10-10T02:20:00.000Z",
        delegation: { status: "approved", headCommit: "a41c7e90d2f3" },
      },
      {
        id: "worker_callback_docs",
        teamId: TEAM_ID,
        delegationId: "delegation_worker_callback_docs",
        label: "回调文档同步",
        role: "文档",
        status: "error",
        focused: false,
        branchName: "council/task-channel-adapter-split/worker-docs",
        scopePaths: ["docs/channels/"],
        createdAt: "2026-10-10T01:11:00.000Z",
        updatedAt: "2026-10-10T01:50:00.000Z",
        delegation: {
          status: "cancelled",
          failureCode: "interrupted",
          error: "Lead 已打断该 Worker。",
        },
      },
    ],
  },
];

export function createMockTaskFixtures(): MockTaskFixtures {
  return {
    tasks: structuredClone(TASKS),
    delegations: structuredClone(DELEGATIONS),
    teams: structuredClone(TEAMS),
  };
}
