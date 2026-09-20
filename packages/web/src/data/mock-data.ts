/**
 * @input  依赖：Council Web 领域类型
 * @output 导出：带行级 Actor 快照的脱敏示例工作区；含一组可验证的架构档案样例——
 *         一个被取代的旧决策（topic-transport-legacy，superseded）+ 取代它的新决策
 *         （topic-transport-grpc，accepted，rationale 内嵌 ```mermaid 架构图）+ 一条
 *         一个同时含两条 proposed 与一条 rejected 的决策包 + 一条含 ```mermaid 架构图的
 *         synthesis 消息（topic-sharding），让决策批量交互与架构档案视图的
 *         时间线/不变量/图集三个区块都有真实内容可看
 * @pos    视觉验收阶段的唯一 mock 数据源
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type {
  AgentId,
  ActorSnapshot,
  CouncilDecision,
  CouncilMessage,
  Participant,
  TopicDetail,
  TopicStatus,
  WorkspaceSnapshot,
} from "../types/council";

const participants: Participant[] = [
  { id: "claude", slug: "claude", name: "Claude", shortName: "CL", role: "方案顾问" },
  { id: "codex", slug: "codex", name: "Codex", shortName: "CX", role: "代码审查" },
  { id: "human", slug: "human", name: "User", shortName: "U", role: "决策者" },
  { id: "council", slug: "council", name: "Council", shortName: "CO", role: "综合协调" },
  { id: "deepseek", slug: "deepseek", name: "DeepSeek", shortName: "DS", role: "模型顾问" },
  { id: "kimi", slug: "kimi", name: "Kimi", shortName: "KI", role: "模型顾问" },
];

export function mockActorSnapshot(actorId: AgentId): ActorSnapshot {
  const participant = participants.find((candidate) => candidate.id === actorId);
  if (!participant) {
    throw new Error(`Mock Actor ${actorId} 未注册。`);
  }
  return {
    schemaVersion: 1,
    actorId: participant.id,
    slug: participant.slug,
    displayName: participant.name,
    shortName: participant.shortName,
    role: participant.role,
  };
}

const defaultDecision: CouncilDecision = {
  id: "decision-idempotency-primary",
  title: "组合式幂等处理",
  summary: "采用业务幂等键、结果缓存与状态机校验的组合方案。",
  rationale: "兼顾回调重试、并发写入和可观测性，同时保留清晰回滚路径。",
  status: "proposed",
  proposedBy: "claude",
  proposedBySnapshot: mockActorSnapshot("claude"),
  createdAt: "2026-08-30T02:26:00.000Z",
};

function createMessage(
  id: string,
  author: AgentId,
  kind: CouncilMessage["kind"],
  title: string,
  content: string,
  createdLabel: string,
): CouncilMessage {
  return {
    id,
    author,
    actorSnapshot: mockActorSnapshot(author),
    kind,
    title,
    content,
    createdLabel,
  };
}

/**
 * 内嵌的最小 data URI SVG 图标（一枚圆角方块 + 对勾），仅用于验证 Markdown 图片缩略图/Lightbox。
 * 不引外网资源，符合桌面端 CSP 与视觉验收要求。
 */
const SAMPLE_INLINE_SVG =
  "data:image/svg+xml;base64," +
  "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA4MCA4MCI+PHJlY3QgeD0iNCIgeT0iNCIgd2lkdGg9IjcyIiBoZWlnaHQ9IjcyIiByeD0iMTQiIGZpbGw9IiMxNzY5ZDYiLz48cGF0aCBkPSJNMjIgNDJsMTIgMTIgMjQtMjgiIHN0cm9rZT0iI2ZmZmZmZiIgc3Ryb2tlLXdpZHRoPSI3IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiIGZpbGw9Im5vbmUiLz48L3N2Zz4=";

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
    owner: "human",
    ownerSnapshot: mockActorSnapshot("human"),
    participants: ["claude", "codex", "human"],
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
    workItems: [],
    decisions: [{
      ...defaultDecision,
      id: `${id}-decision`,
      title: "等待更多证据",
      summary: "先完成失败路径验证，再决定是否进入实现。",
    }],
  };
}

/**
 * 架构演进样例：旧的 REST 回调 + 轮询同步方案（曾被接受，现已被 gRPC 双向流方案取代）。
 * decidedAt 保留"最初被接受"的时间，不随取代动作改写——ADR 编号排序依赖这一点稳定。
 */
const transportLegacyTopic: TopicDetail = {
  id: "topic-transport-legacy",
  title: "服务间同步：REST 回调 + 轮询对账",
  status: "decided",
  updatedLabel: "两周前",
  question: "订单服务与库存服务之间应该用什么方式同步库存扣减结果？",
  createdLabel: "两周前",
  owner: "human",
  ownerSnapshot: mockActorSnapshot("human"),
  participants: ["claude", "codex", "human"],
  messages: [
    createMessage(
      "transport-legacy-proposal",
      "codex",
      "proposal",
      "REST 回调 + 定时轮询兜底",
      "库存服务扣减完成后通过 REST 回调通知订单服务；为防止回调丢失，订单服务每 5 分钟轮询一次做兜底对账。实现成本低，不引入新中间件。",
      "两周前",
    ),
    createMessage(
      "transport-legacy-critique",
      "claude",
      "critique",
      "轮询兜底的时延上限需要量化",
      "大促期间回调丢失率上升时，5 分钟轮询周期会把端到端时延推到分钟级，需要明确这是否在业务可接受范围内。",
      "两周前",
    ),
  ],
  constraints: [
    { id: "transport-legacy-c1", label: "扣减结果需在可预期时间内对账收敛", tone: "positive" },
    { id: "transport-legacy-c2", label: "不引入新的消息中间件依赖", tone: "positive" },
  ],
  evidence: [
    { id: "transport-legacy-e1", label: "历史回调丢失率统计", meta: "监控看板" },
  ],
  alternatives: [
    { id: "transport-legacy-a1", title: "引入消息队列做事件驱动同步", author: "claude", createdLabel: "两周前" },
  ],
  workItems: [],
  decisions: [{
    id: "decision-transport-legacy",
    title: "REST 回调 + 定时对账轮询",
    summary: "库存服务通过 REST 回调通知订单服务扣减结果，订单服务每 5 分钟轮询一次做兜底对账。",
    rationale: "短期内实现成本最低，不需要新增消息中间件；已知代价是回调丢失时依赖轮询兜底，时延可能达到分钟级。",
    status: "superseded",
    proposedBy: "codex",
    proposedBySnapshot: mockActorSnapshot("codex"),
    createdAt: "2026-07-10T02:00:00.000Z",
    decidedAt: "2026-07-10T02:15:00.000Z",
    supersededByTopicId: "topic-transport-grpc",
  }],
};

/**
 * 架构演进样例：取代上面 topic-transport-legacy 的新方案，decision.rationale 里内嵌
 * ```mermaid 架构图——架构档案图集从"已接受/被取代决策的 summary/rationale"提取的样例。
 */
const transportGrpcTopic: TopicDetail = {
  id: "topic-transport-grpc",
  title: "服务间同步：gRPC 双向流",
  status: "decided",
  updatedLabel: "今天",
  question: "REST 回调 + 轮询方案在扣减量上升后时延明显，如何把端到端同步时延降到亚秒级？",
  createdLabel: "3 天前",
  owner: "human",
  ownerSnapshot: mockActorSnapshot("human"),
  participants: ["claude", "codex", "human"],
  messages: [
    createMessage(
      "transport-grpc-proposal",
      "claude",
      "proposal",
      "迁移到 gRPC 双向流",
      "订单服务与库存服务之间建立 gRPC 双向流连接，扣减结果实时推送，废弃轮询兜底，同时保留流水表用于事后审计。",
      "3 天前",
    ),
    createMessage(
      "transport-grpc-critique",
      "codex",
      "critique",
      "需要明确连接断线后的重连与补偿策略",
      "双向流连接中断期间的扣减结果如何补偿式重放，需要在方案里说明，否则会退化回轮询期间同样的丢失问题。",
      "2 天前",
    ),
    createMessage(
      "transport-grpc-rebuttal",
      "claude",
      "rebuttal",
      "补充断线重连与流水表补偿方案",
      "客户端断线后按流水表最后确认位点重放未确认记录，重连成功前短暂降级为轮询兜底，恢复后自动切回流式推送。",
      "昨天",
    ),
  ],
  constraints: [
    { id: "transport-grpc-c1", label: "扣减结果需在可预期时间内对账收敛", tone: "positive" },
    { id: "transport-grpc-c2", label: "断线期间不得丢失扣减结果", tone: "warning" },
  ],
  evidence: [
    { id: "transport-grpc-e1", label: "gRPC 双向流延迟压测报告", meta: "压测数据" },
  ],
  alternatives: [
    { id: "transport-grpc-a1", title: "继续沿用 REST 回调，缩短轮询周期", author: "codex", createdLabel: "3 天前" },
  ],
  workItems: [],
  decisions: [{
    id: "decision-transport-grpc",
    title: "迁移到 gRPC 双向流同步",
    summary: "订单服务与库存服务之间改用 gRPC 双向流实时推送扣减结果，废弃轮询兜底。",
    rationale: `旧方案在大促期间轮询延迟已经达到分钟级，双向流把端到端时延压到亚秒级，同时用连接保活替代轮询开销。

### 新架构

\`\`\`mermaid
graph LR
  Order[订单服务] -- gRPC 双向流 --> Inventory[库存服务]
  Inventory -- 扣减结果推送 --> Order
  Inventory --> Ledger[(扣减流水表)]
  Order --> Notify[通知中心]
\`\`\`

该方案已取代 REST 回调 + 轮询对账的旧方案。`,
    status: "accepted",
    proposedBy: "claude",
    proposedBySnapshot: mockActorSnapshot("claude"),
    createdAt: "2026-07-19T07:20:00.000Z",
    decidedAt: "2026-07-19T07:40:00.000Z",
  }],
};

const primaryTopic: TopicDetail = {
  id: "topic-idempotency",
  title: "支付回调幂等方案",
  status: "proposed",
  updatedLabel: "14:32",
  question: "如何在重复、乱序和并发回调下保证业务只生效一次，并保留清晰审计轨迹？",
  createdLabel: "今天 10:21",
  owner: "human",
  ownerSnapshot: mockActorSnapshot("human"),
  participants: ["claude", "codex", "human"],
  messages: [
    createMessage(
      "message-proposal",
      "claude",
      "proposal",
      "基于业务幂等键与状态机的组合方案",
      `使用稳定业务标识构建唯一幂等键，在事务内写入处理状态与结果快照。回调先检查终态，再通过状态转换约束重复执行，避免依赖第三方回调顺序。

### 关键设计点

- **幂等键**：业务标识、渠道事件与动作类型组成的复合键
- **状态机**：\`pending → processing → done | failed\`，只允许单向迁移
- **结果缓存**：命中终态直接返回缓存结果，不重复执行副作用

### 状态迁移参考实现

\`\`\`ts
function transition(current: State, next: State): State {
  if (!ALLOWED[current]?.includes(next)) {
    throw new Error(\`非法迁移：\${current} -> \${next}\`);
  }
  return next;
}
\`\`\`

### 三种回调场景对比

| 场景 | 现状风险 | 本方案处理 |
| --- | --- | --- |
| 重复回调 | 可能重复扣款 | 幂等键命中，直接返回缓存结果 |
| 乱序回调 | 状态被旧事件覆盖 | 状态机拒绝非法迁移 |
| 并发回调 | 竞态写入 | 事务内唯一索引保证互斥 |

> 验收标准：状态机通过全部重复/乱序/并发用例后即可进入实现阶段。

![方案已通过内部校验](${SAMPLE_INLINE_SVG})`,
      "10:26",
    ),
    createMessage(
      "message-critique",
      "codex",
      "critique",
      "幂等键粒度与存储成本仍需说明",
      "仅使用单一订单标识可能遗漏渠道事件差异。需要补充复合键边界、唯一索引冲突处理、结果缓存期限，以及分区策略对审计查询的影响。",
      "11:02",
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
  workItems: [],
  decisions: [
    defaultDecision,
    {
      id: "decision-idempotency-transactional-inbox",
      title: "事务收件箱作为并发写入边界",
      summary: "把原始回调先写入事务收件箱，再由单向状态迁移执行实际副作用。",
      rationale: "该方案把接收、去重和执行业务副作用拆成可审计的两个阶段，故障恢复边界更清晰。",
      status: "proposed",
      proposedBy: "codex",
      proposedBySnapshot: mockActorSnapshot("codex"),
      createdAt: "2026-08-30T03:02:00.000Z",
    },
    {
      id: "decision-idempotency-distributed-lock",
      title: "仅依赖短期分布式锁",
      summary: "用业务标识加短期锁串行化所有回调。",
      rationale: "锁过期与业务事务无法原子提交，故障窗口内仍可能重复执行，因此不作为最终方案。",
      status: "rejected",
      proposedBy: "claude",
      proposedBySnapshot: mockActorSnapshot("claude"),
      createdAt: "2026-08-30T03:16:00.000Z",
    },
  ],
};

export function createMockWorkspace(): WorkspaceSnapshot {
  const shardingTopic = createSecondaryTopic(
    "topic-sharding",
    "对账任务分片策略",
    "synthesis",
    "昨天 18:47",
    "任务分片应以租户、时间还是数据范围为边界？",
  );
  // 架构图集样例二：从 synthesis 类消息正文里提取 mermaid 图（区别于决策 summary/rationale 来源）
  shardingTopic.messages.push(
    createMessage(
      "topic-sharding-synthesis",
      "council",
      "synthesis",
      "综合结论：按租户主分片，时间维度做二级分区",
      `汇总各方意见后收敛为"租户主分片 + 时间二级分区"的组合方案，兼顾租户间隔离性与历史数据裁剪效率。

\`\`\`mermaid
flowchart TD
  Task[对账任务] --> Shard{按租户分片}
  Shard --> T1[租户分片 1]
  Shard --> T2[租户分片 2]
  Shard --> Tn[租户分片 N]
  T1 --> P1[按月二级分区]
  T2 --> P2[按月二级分区]
  Tn --> Pn[按月二级分区]
\`\`\`

后续如需按数据范围二次拆分，可在租户分片内部继续细分，不影响外层路由规则。`,
      "18:47",
    ),
  );

  const eventBusTopic = createSecondaryTopic(
    "topic-event-bus",
    "事件总线选型",
    "decided",
    "昨天 11:03",
    "当前规模下应继续使用数据库事件表还是引入独立消息系统？",
  );
  // 覆盖默认的 proposed 拟议决策：这是唯一未被架构演进样例覆盖的"普通已接受决策"，
  // 用于验证时间线里非取代关系的常规 ADR 条目也能正确编号。
  eventBusTopic.decisions = [{
    id: "decision-event-bus-database-table",
    title: "继续使用数据库事件表，暂缓引入独立消息系统",
    summary: "当前吞吐量下数据库事件表配合轮询仍在延迟预算内，暂不引入 Kafka/RabbitMQ 等独立组件。",
    rationale: "引入独立消息系统会带来新的运维面（部署、监控、灾备），现阶段收益不足以覆盖成本；吞吐量翻倍时重新评估。",
    status: "accepted",
    proposedBy: "codex",
    proposedBySnapshot: mockActorSnapshot("codex"),
    createdAt: "2026-07-14T02:45:00.000Z",
    decidedAt: "2026-07-14T03:03:00.000Z",
  }];

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
      shardingTopic,
      eventBusTopic,
      createSecondaryTopic(
        "topic-risk-control",
        "风控策略执行引擎",
        "discussing",
        "周三",
        "如何隔离规则发布、执行和回滚，降低错误策略的影响？",
      ),
      transportLegacyTopic,
      transportGrpcTopic,
    ],
    activeTopicId: primaryTopic.id,
    participants,
    sync: { status: "connected", label: "Mock 原型 · API 待接入" },
  };
}
