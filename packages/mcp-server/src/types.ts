/**
 * @input  依赖：constants.ts 的协议枚举
 * @output 导出：领域模型（含 v18 任务一等化的实施项 kind/source/projectPath、v19 公开资产 DTO）与含迁移策略、文件预览、独立 CLI 事件流与委派 Git 检查预算、P3 流水线上限与原型权限档、v19 资产库与客户端接入分发（ClientConfigSettings）的配置类型
 * @pos    MCP 服务的共享类型边界
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 * 包含分阶段 Claude 预算的配置类型
 */

import type {
  ASSET_KINDS,
  ASSET_LINK_ROLES,
  ASSET_LINK_TARGET_KINDS,
  DECISION_STATUSES,
  MESSAGE_KINDS,
  TOPIC_STATUSES,
  WORK_ITEM_KINDS,
  WORK_ITEM_ORIGINS,
  WORK_ITEM_SEVERITIES,
  WORK_ITEM_SOURCES,
  WORK_ITEM_STATUSES,
} from "./constants.js";
import type { ActorId, ActorSnapshot } from "./actor-identity.js";

export type TopicStatus = (typeof TOPIC_STATUSES)[number];
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export type DecisionStatus = (typeof DECISION_STATUSES)[number];
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];
export type WorkItemOrigin = (typeof WORK_ITEM_ORIGINS)[number];
export type WorkItemSeverity = (typeof WORK_ITEM_SEVERITIES)[number];
/** v18 起实施项（任务）的产出类型；与 work_items.kind 的 CHECK 枚举一致。 */
export type WorkItemKind = (typeof WORK_ITEM_KINDS)[number];
/** v18 起实施项来源：议题拆解、直接创建或流水线生成；只有 topic 来源挂议题。 */
export type WorkItemSource = (typeof WORK_ITEM_SOURCES)[number];
/** v19 资产类型、链接目标与角色；与 assets / asset_links 的 CHECK 一致。 */
export type AssetKind = (typeof ASSET_KINDS)[number];
export type AssetLinkTargetKind = (typeof ASSET_LINK_TARGET_KINDS)[number];
export type AssetLinkRole = (typeof ASSET_LINK_ROLES)[number];
/** 流水线原型委派可请求的权限档：默认沙箱写盘；danger_full_access 让 Codex 不带沙箱运行以便自行起服务与浏览器验证。 */
export type PipelinePrototypePermission = "workspace_write" | "danger_full_access";

export interface CouncilConfig {
  dataDir: string;
  databasePath: string;
  claudeCommand: string;
  claudeArgs: string[];
  claudeModel?: string;
  claudePermissionMode: "plan";
  claudeTimeoutMs: number;
  claudeKillGraceMs: number;
  claudeMaxTurns: number;
  claudeExecutionMaxTurns: number;
  claudeReviewMaxTurns: number;
  /** loadConfig 总会提供；可选字段兼容直接嵌入旧 Runtime 的调用方。 */
  workerHeartbeatMs?: number;
  workerIdleTimeoutMs?: number;
  delegationMaxExecutionSegments?: number;
  delegationExecutionTimeoutMs?: number;
  /** P3 流水线：模板阶段数上限与复盘后自动修订轮数上限。 */
  pipelineMaxStages?: number;
  pipelineMaxRevisions?: number;
  /** P3 原型代码委派请求的权限档（默认 workspace_write）；实际权限仍与执行 Agent 的权限档取交集。 */
  pipelinePrototypePermission?: PipelinePrototypePermission;
  /** P4 Worker 团队：单个团队同时运行的 Worker 上限（默认 3），创建团队时冻结进 task_teams.max_parallel。 */
  workerMaxParallel?: number;
  codexCommand: string;
  codexArgs: string[];
  codexModel?: string;
  codexSandboxMode: "read-only";
  codexTimeoutMs: number;
  codexKillGraceMs: number;
  /**
   * Codex 生图配置；loadConfig 总会提供。可选是为了兼容直接嵌入旧 Runtime 的调用方，
   * 缺省按「未启用」处理：探针不声明图像能力，generateImages 拒绝执行。
   */
  codexImageEnabled?: boolean;
  codexImageSandboxMode?: "workspace-write";
  codexImageTimeoutMs?: number;
  codexImageMaxOutputs?: number;
  /** Codex 数据目录（<codex-home>），图像委派兜底收集产物用；缺省时跳过该路收集。 */
  codexHome?: string;
  kimiAcpCommand: string;
  geminiAcpCommand: string;
  grokAcpCommand: string;
  codexAcpCommand: string;
  claudeAcpCommand: string;
  acpStartupTimeoutMs: number;
  acpKillGraceMs: number;
  acpMaxFileReadChars: number;
  toolLoopMaxSteps: number;
  toolLoopMaxContextChars: number;
  toolLoopMaxFileBytes: number;
  toolLoopMaxScanFiles: number;
  gitCommand: string;
  gitDiffTimeoutMs: number;
  gitDiffKillGraceMs: number;
  gitDiffMaxFiles: number;
  gitDiffMaxLines: number;
  gitDiffMaxHunksPerFile: number;
  gitDiffMaxOutputChars: number;
  delegationWorktreeRoot: string;
  delegationRetryDelayMs: number;
  delegationGitMaxOutputChars: number;
  keychainCommand?: string;
  sqliteBusyTimeoutMs: number;
  schemaMigrationMaxAttempts: number;
  maxContextChars: number;
  maxOutputChars: number;
  cliMaxStreamChars: number;
  defaultMessageLimit: number;
  /** loadConfig 总会提供；手工构造配置的旧调用方缺省时按 <data-dir>/assets 与默认预算回落。 */
  assets?: AssetConfig;
}

/** v19 资产库配置：由 config.ts 的 loadAssetConfig 集中加载校验，assets/ 领域只读这里。 */
export interface AssetConfig {
  /** 资产根目录（绝对路径）；COUNCIL_ASSET_DIR 留空时为 <data-dir>/assets。 */
  rootDir: string;
  maxBytes: number;
  maxTotalBytes: number;
  mimeAllowlist: readonly string[];
  thumbnailMaxEdge: number;
  thumbnailCommand: string;
  thumbnailTimeoutMs: number;
}

export interface McpCouncilConfig extends CouncilConfig {
  callerActorAlias: string;
  /** 同机 HTTP 服务基址（仅回环）；任务委派等需要后台执行的 MCP 工具经它转发。 */
  httpServiceUrl: string;
  httpForwardTimeoutMs: number;
  /** P4：Council 只给团队 Lead 注入的 MCP 进程带上该值，团队工具据此定位团队；普通 MCP 会话缺省。 */
  teamLeadDelegationId?: string;
}

export interface CouncilHttpConfig {
  /** loadHttpConfig 总会提供；测试夹具手工构造时缺省，由 app 按数据库目录回落。 */
  assets?: AssetConfig;
  /** 客户端配置分发（P4）；测试夹具缺省时对应路由返回 503，绝不回落到真实家目录。 */
  clientConfig?: ClientConfigSettings;
  filePreview?: import("./project-file-preview-config.js").ProjectFilePreviewConfig;
  databasePath: string;
  sqliteBusyTimeoutMs: number;
  schemaMigrationMaxAttempts: number;
  defaultMessageLimit: number;
  host: string;
  port: number;
  allowedOrigins: string[];
  corsMaxAgeSeconds: number;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  bodyLimitBytes: number;
  eventPollMs: number;
  eventRetryMs: number;
  eventHeartbeatMs: number;
  shutdownTimeoutMs: number;
  orchestrationLeaseTtlMs: number;
  orchestrationLeaseRenewMs: number;
  orchestrationSweepIntervalMs: number;
  orchestrationDefaultMaxRounds: number;
  orchestrationDefaultMaxAttempts: number;
  orchestrationDefaultMaxRecoveries: number;
  orchestrationDefaultAgentIdleTimeoutMs: number;
  orchestrationDefaultAgentTimeoutMs: number;
  orchestrationAgentCleanupTimeoutMs: number;
  orchestrationConfirmCompletion: boolean;
  orchestrationRunPageLimit: number;
  orchestrationStartupScanLimit: number;
  orchestrationShutdownTimeoutMs: number;
  runtimeBindingIdleTimeoutMs: number;
}

export interface Topic {
  id: string;
  title: string;
  question: string;
  constraints: string[];
  projectPath?: string;
  status: TopicStatus;
  createdByActorId: ActorId;
  createdBySnapshot: ActorSnapshot;
  createdAt: string;
  updatedAt: string;
  /**
   * 议题的实施完成度。不是 topics 表的列，而是列表查询顺带聚合出来的派生属性——
   * 议题导航要在不拉取每个议题详情的前提下显示「12 / 15」，只能由查询侧算好带下来。
   */
  workItemProgress?: WorkItemProgress;
}

export interface CouncilMessage {
  id: string;
  topicId: string;
  actorId: ActorId;
  actorSnapshot: ActorSnapshot;
  kind: MessageKind;
  content: string;
  parentMessageId?: string;
  createdAt: string;
}

export interface Decision {
  id: string;
  topicId: string;
  title: string;
  decision: string;
  rationale: string;
  alternatives: string[];
  status: DecisionStatus;
  createdByActorId: ActorId;
  createdBySnapshot: ActorSnapshot;
  createdAt: string;
  updatedAt: string;
}

export interface WorkItem {
  id: string;
  /** v18 起可空：直接任务与流水线任务不挂议题，靠 projectPath 定位项目。 */
  topicId?: string;
  kind: WorkItemKind;
  source: WorkItemSource;
  priority: number;
  /** 议题实施项迁移/创建时从议题拷贝；非议题任务必填。 */
  projectPath?: string;
  /** 任务简报（结构化输入），NULL 映射为缺省。 */
  brief?: Record<string, unknown>;
  /** 审核发现可以在议题还没有 Accepted 决策时就落库，因此锚点放宽为可选。 */
  decisionId?: string;
  /** 顶层任务没有父级；子任务随父级级联删除。 */
  parentId?: string;
  title: string;
  details: string;
  status: WorkItemStatus;
  statusNote?: string;
  version: number;
  sortOrder: number;
  origin: WorkItemOrigin;
  severity?: WorkItemSeverity;
  /** 产出这条发现的那次评审发言，用于从任务跳回原始论据。 */
  sourceMessageId?: string;
  sourceCycleId?: string;
  reviewRound?: number;
  /** 修复证据：外部 Agent 改完代码后回写的 commit。 */
  fixCommit?: string;
  assigneeActorId?: ActorId;
  claimedAt?: string;
  createdByActorId: ActorId;
  createdBySnapshot: ActorSnapshot;
  updatedByActorId: ActorId;
  updatedBySnapshot: ActorSnapshot;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/**
 * 议题级完成度。父任务状态由子任务派生，计入分母的只有叶子节点——
 * 否则一个两层拆解会把同一件事数两次。
 */
export interface WorkItemProgress {
  total: number;
  completed: number;
  blocked: number;
  openBlockingFindings: number;
}

export interface TopicDetail {
  topic: Topic;
  messages: CouncilMessage[];
  decisions: Decision[];
  workItems: WorkItem[];
  messageTotal: number;
  messageLimit: number;
  messageOffset: number;
  hasMoreMessages: boolean;
  nextMessageOffset?: number;
}

export interface PaginatedTopics {
  total: number;
  count: number;
  offset: number;
  hasMore: boolean;
  nextOffset?: number;
  topics: Topic[];
}

export interface ClaudeResponse {
  content: string;
  sessionId?: string;
  model?: string;
}

export interface CodexResponse {
  content: string;
  sessionId?: string;
}

export interface AssetLink {
  targetKind: AssetLinkTargetKind;
  targetId: string;
  role: AssetLinkRole;
  createdAt: string;
}

/**
 * 公开资产 DTO（REST / MCP / Tauri 共用形状）。刻意不含 project_path 与 storage_rel_path：
 * 客户端只经 /assets/:id/content 取字节，不应知道文件落在哪里。
 */
export interface Asset {
  id: string;
  kind: AssetKind;
  mime: string;
  byteSize: number;
  sha256: string;
  width?: number;
  height?: number;
  prompt?: string;
  origin: { delegationId?: string; actorId?: string };
  createdAt: string;
  deletedAt?: string;
  links: AssetLink[];
}

export interface PaginatedAssets {
  items: Asset[];
  total: number;
  count: number;
  offset: number;
  hasMore: boolean;
}

/**
 * 客户端配置分发（P4 magpie 式）：Council 向 Claude/Codex 客户端写入 MCP 注册与 Skill 的目标路径
 * 与注册内容所需环境。mcpEnv 只含 loadMcpConfig 必需的非敏感键；缺失的键列入 missingMcpEnv。
 */
export interface ClientConfigSettings {
  /** <data-dir>/client-config：applied.json 与 stash/ 所在目录 */
  rootDir: string;
  claudeFile: string;
  claudeSkillsDir: string;
  codexFile: string;
  codexSkillsDir: string;
  mcpEnv: Record<string, string>;
  missingMcpEnv: string[];
}
