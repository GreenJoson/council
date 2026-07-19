/**
 * @input  依赖：Council Web 领域类型
 * @output 导出：可交互原型使用的脱敏示例工作区
 * @pos    视觉验收阶段的唯一 mock 数据源
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type {
  AgentId,
  CouncilDecision,
  CouncilMessage,
  Participant,
  TopicDetail,
  TopicStatus,
  WorkspaceSnapshot,
} from "../types/council";

const participants: Participant[] = [
  { id: "claude", name: "Claude", shortName: "CL", role: "方案顾问" },
  { id: "codex", name: "Codex", shortName: "CX", role: "代码审查" },
  { id: "user", name: "User", shortName: "U", role: "决策者" },
  { id: "chair", name: "Council", shortName: "CO", role: "综合协调" },
  { id: "other", name: "Other", shortName: "OT", role: "其他参与者" },
];

const defaultDecision: CouncilDecision = {
  title: "组合式幂等处理",
  summary: "采用业务幂等键、结果缓存与状态机校验的组合方案。",
  rationale: "兼顾回调重试、并发写入和可观测性，同时保留清晰回滚路径。",
  status: "proposed",
  proposedBy: "claude",
};

function createMessage(
  id: string,
  author: AgentId,
  kind: CouncilMessage["kind"],
  title: string,
  content: string,
  createdLabel: string,
  attachment?: CouncilMessage["attachment"],
): CouncilMessage {
  return {
    id,
    author,
    kind,
    title,
    content,
    createdLabel,
    ...(attachment ? { attachment } : {}),
  };
}

function createSecondaryTopic(
  id: string,
  title: string,
  status: TopicStatus,
  updatedLabel: string,
  question: string,
): TopicDetail {
  return {
    id,
    title,
    status,
    updatedLabel,
    question,
    createdLabel: "本周",
    owner: "user",
    participants: ["claude", "codex", "user"],
    messages: [
      createMessage(
        `${id}-proposal`,
        "claude",
        "proposal",
        "初始方案",
        "先明确状态不变量，再以最小改动验证关键路径。完整方案将在真实 API 接入后由 Council 载入。",
        "10:08",
      ),
      createMessage(
        `${id}-critique`,
        "codex",
        "critique",
        "需要补充的证据",
        "当前结论仍缺少异常输入、并发冲突和回滚路径的验证结果。",
        "10:24",
      ),
    ],
    constraints: [
      { id: `${id}-c1`, label: "保持现有公开接口兼容", tone: "positive" },
      { id: `${id}-c2`, label: "必须提供可验证的回滚条件", tone: "warning" },
    ],
    evidence: [
      { id: `${id}-e1`, label: "当前模块说明", meta: "项目文档" },
    ],
    alternatives: [
      { id: `${id}-a1`, title: "保持现状并补充监控", author: "codex", createdLabel: "10:20" },
    ],
    decision: {
      ...defaultDecision,
      title: "等待更多证据",
      summary: "先完成失败路径验证，再决定是否进入实现。",
    },
  };
}

const primaryTopic: TopicDetail = {
  id: "topic-idempotency",
  title: "支付回调幂等方案",
  status: "proposed",
  updatedLabel: "14:32",
  question: "如何在重复、乱序和并发回调下保证业务只生效一次，并保留清晰审计轨迹？",
  createdLabel: "今天 10:21",
  owner: "user",
  participants: ["claude", "codex", "user"],
  messages: [
    createMessage(
      "message-proposal",
      "claude",
      "proposal",
      "基于业务幂等键与状态机的组合方案",
      "使用稳定业务标识构建唯一幂等键，在事务内写入处理状态与结果快照。回调先检查终态，再通过状态转换约束重复执行，避免依赖第三方回调顺序。",
      "10:26",
      { name: "proposal.md", meta: "2.1 KB" },
    ),
    createMessage(
      "message-critique",
      "codex",
      "critique",
      "幂等键粒度与存储成本仍需说明",
      "仅使用单一订单标识可能遗漏渠道事件差异。需要补充复合键边界、唯一索引冲突处理、结果缓存期限，以及分区策略对审计查询的影响。",
      "11:02",
      { name: "critique.md", meta: "1.7 KB" },
    ),
    createMessage(
      "message-rebuttal",
      "claude",
      "rebuttal",
      "补充事件维度与回滚标识",
      "修订为业务标识、渠道事件和动作类型组成的复合键；保留原始回调标识用于追踪。结果缓存采用可配置期限，异常情况下进入可审计的人工恢复队列。",
      "13:14",
    ),
  ],
  constraints: [
    { id: "constraint-once", label: "同一业务动作最多生效一次", tone: "positive" },
    { id: "constraint-provider", label: "不依赖上游服务保证回调顺序", tone: "positive" },
    { id: "constraint-audit", label: "保留完整、可查询的审计记录", tone: "positive" },
    { id: "constraint-rollback", label: "失败恢复不得绕过状态机", tone: "warning" },
  ],
  evidence: [
    { id: "evidence-contract", label: "回调契约与失败语义", meta: "架构文档" },
    { id: "evidence-test", label: "重复与乱序回调用例", meta: "集成测试" },
    { id: "evidence-metrics", label: "历史重复处理分析", meta: "本地数据" },
  ],
  alternatives: [
    { id: "alternative-db", title: "仅使用数据库唯一索引", author: "codex", createdLabel: "11:15" },
    { id: "alternative-lock", title: "使用短期分布式锁", author: "claude", createdLabel: "10:40" },
  ],
  decision: defaultDecision,
};

export function createMockWorkspace(): WorkspaceSnapshot {
  return {
    project: { id: "project-commerce-api", name: "Commerce API" },
    topics: [
      primaryTopic,
      createSecondaryTopic(
        "topic-state-machine",
        "订单状态机重构",
        "discussing",
        "12:18",
        "如何减少状态分支并保证迁移过程中的兼容性？",
      ),
      createSecondaryTopic(
        "topic-sharding",
        "对账任务分片策略",
        "synthesis",
        "昨天 18:47",
        "任务分片应以租户、时间还是数据范围为边界？",
      ),
      createSecondaryTopic(
        "topic-event-bus",
        "事件总线选型",
        "decided",
        "昨天 11:03",
        "当前规模下应继续使用数据库事件表还是引入独立消息系统？",
      ),
      createSecondaryTopic(
        "topic-risk-control",
        "风控策略执行引擎",
        "discussing",
        "周三",
        "如何隔离规则发布、执行和回滚，降低错误策略的影响？",
      ),
    ],
    activeTopicId: primaryTopic.id,
    participants,
    sync: { status: "connected", label: "Mock 原型 · API 待接入" },
  };
}
