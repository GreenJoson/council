/**
 * @input  依赖：议题摘要/详情（可选 question 字段）、用户搜索文本与状态筛选
 * @output 导出：TopicStatusFilter、filterTopics（按标题或问题描述匹配）；
 *         extractMermaidBlocks（提取 Markdown 中的顶层 mermaid 围栏代码块）；
 *         computeAdrNumberAssignments、buildArchitectureTimeline、aggregateConstraints、
 *         collectArchitectureDiagrams（架构档案视图的聚合纯函数）
 * @pos    议题导航搜索与架构档案视图共用的可测试查询/聚合逻辑，不发起任何请求
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { AgentId, CouncilDecision, TopicDetail, TopicSummary } from "../types/council";

export type TopicStatusFilter = "all" | "active" | "decided";

/**
 * 文本匹配同时命中标题和问题描述：
 * TopicSummary 本身没有 question 字段，轻量议题（question 缺省）自然只能靠标题匹配；
 * TopicDetail 等携带完整 question 的类型可以额外命中问题描述，签名保持向后兼容。
 */
export function filterTopics<T extends TopicSummary & { question?: string }>(
  topics: T[],
  query: string,
  statusFilter: TopicStatusFilter = "all",
): T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return topics.filter((topic) => {
    if (statusFilter === "decided" && topic.status !== "decided") {
      return false;
    }
    if (statusFilter === "active" && topic.status === "decided") {
      return false;
    }
    if (!normalizedQuery) {
      return true;
    }
    const titleMatches = topic.title.toLocaleLowerCase().includes(normalizedQuery);
    const questionMatches = (topic.question ?? "").toLocaleLowerCase().includes(normalizedQuery);
    return titleMatches || questionMatches;
  });
}

/**
 * 提取 Markdown 文本里所有顶层 ```mermaid 围栏代码块的原始源码（不含围栏本身）。
 *
 * 用逐行扫描 + 单层围栏状态机而不是正则一把梭：CommonMark 的围栏代码块不支持嵌套——
 * 一个更长/不同类型的外层围栏（例如非 mermaid 的 ````text```` 包住一段示例文本，
 * 示例文本里恰好写了 ```mermaid ... ``` ）里出现的内容永远只是外层围栏的纯文本，
 * 不能被误判成独立的 mermaid 代码块。闭合围栏要求同字符、长度 >= 起始围栏长度，
 * 且这一行只能是围栏标记加空白，这与 CommonMark 规范一致。
 */
export function extractMermaidBlocks(markdown: string): string[] {
  const lines = markdown.split(/\r\n|\r|\n/);
  const blocks: string[] = [];

  const fenceStartPattern = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;

  let openFenceChar: "`" | "~" | null = null;
  let openFenceLength = 0;
  let isMermaidFence = false;
  let currentLines: string[] = [];

  for (const line of lines) {
    if (openFenceChar === null) {
      const match = fenceStartPattern.exec(line);
      if (match) {
        const marker = match[1] ?? "";
        openFenceChar = marker.startsWith("~") ? "~" : "`";
        openFenceLength = marker.length;
        isMermaidFence = (match[2] ?? "").toLowerCase() === "mermaid";
        currentLines = [];
      }
      continue;
    }

    const closePattern = new RegExp(`^ {0,3}(?:\\${openFenceChar}){${String(openFenceLength)},}\\s*$`);
    if (closePattern.test(line)) {
      if (isMermaidFence) {
        blocks.push(currentLines.join("\n"));
      }
      openFenceChar = null;
      openFenceLength = 0;
      isMermaidFence = false;
      currentLines = [];
      continue;
    }

    if (isMermaidFence) {
      currentLines.push(line);
    }
  }

  // 文档结尾前围栏仍未闭合（漏打收尾 ```）：按 CommonMark「围栏可延伸到文档末尾」的
  // 语义继续视为有效代码块，避免因为格式疏漏导致整张图直接消失、用户摸不着头脑。
  if (openFenceChar !== null && isMermaidFence) {
    blocks.push(currentLines.join("\n"));
  }

  return blocks;
}

/** 架构档案时间线的一条条目：已决策的携带稳定 ADR 编号，仍在提案中的没有 */
export interface ArchitectureTimelineEntry {
  topicId: string;
  topicTitle: string;
  decisionTitle: string;
  status: CouncilDecision["status"];
  /** 形如 "ADR-001"；只有 accepted/superseded 且记录了 decidedAt 时才存在 */
  adrNumber?: string;
  /** 直接复用议题的 updatedLabel 展示，不再重新格式化一份时间文案 */
  timeLabel: string;
  supersededByTopicId?: string;
  supersededByAdrNumber?: string;
}

/**
 * 按“最初被接受的时间”升序分配稳定 ADR 编号：只统计带 decidedAt 的 accepted/superseded
 * 决策；一旦分配，编号不会因为决策后续被取代而改变或重排。
 */
export function computeAdrNumberAssignments(topics: readonly TopicDetail[]): Map<string, string> {
  const decidedWithTime = topics
    .filter((topic) => {
      const decision = topic.decision;
      return (
        Boolean(decision?.decidedAt)
        && (decision?.status === "accepted" || decision?.status === "superseded")
      );
    })
    .map((topic) => ({ topic, decidedAtMs: new Date(topic.decision?.decidedAt ?? "").getTime() }))
    .sort((a, b) => a.decidedAtMs - b.decidedAtMs);

  const assignments = new Map<string, string>();
  decidedWithTime.forEach(({ topic }, index) => {
    assignments.set(topic.id, `ADR-${String(index + 1).padStart(3, "0")}`);
  });
  return assignments;
}

/**
 * 架构演进时间线：已决策条目按接受时间升序排在前面（ADR-001、ADR-002…），
 * 仍在提案中的条目（没有 decidedAt）追加在末尾，组内保持传入议题的原始顺序。
 */
export function buildArchitectureTimeline(topics: readonly TopicDetail[]): ArchitectureTimelineEntry[] {
  const adrNumbers = computeAdrNumberAssignments(topics);

  const withDecision = topics.filter((topic): topic is TopicDetail & { decision: CouncilDecision } =>
    Boolean(topic.decision),
  );
  const decided = withDecision.filter((topic) => adrNumbers.has(topic.id));
  decided.sort((a, b) => {
    const left = new Date(a.decision.decidedAt ?? "").getTime();
    const right = new Date(b.decision.decidedAt ?? "").getTime();
    return left - right;
  });
  const stillProposed = withDecision.filter((topic) => !adrNumbers.has(topic.id));

  function toEntry(topic: TopicDetail & { decision: CouncilDecision }): ArchitectureTimelineEntry {
    const decision = topic.decision;
    const supersededByTopicId = decision.supersededByTopicId;
    const supersededByAdrNumber = supersededByTopicId
      ? adrNumbers.get(supersededByTopicId)
      : undefined;
    return {
      topicId: topic.id,
      topicTitle: topic.title,
      decisionTitle: decision.title,
      status: decision.status,
      timeLabel: topic.updatedLabel,
      ...(adrNumbers.has(topic.id) ? { adrNumber: adrNumbers.get(topic.id) } : {}),
      ...(supersededByTopicId ? { supersededByTopicId } : {}),
      ...(supersededByAdrNumber ? { supersededByAdrNumber } : {}),
    };
  }

  return [...decided.map(toEntry), ...stillProposed.map(toEntry)];
}

export interface AggregatedConstraintSource {
  topicId: string;
  topicTitle: string;
  timeLabel: string;
  adrNumber?: string;
}

export interface AggregatedConstraint {
  label: string;
  tone: "positive" | "warning";
  sources: AggregatedConstraintSource[];
}

/**
 * 聚合全部议题的约束条件并按文本去重；同名约束若在不同议题里一次是 positive
 * 一次是 warning，整体呈现为 warning——警示语义不能被后来的 positive 覆盖掉。
 * 每条约束附上全部来源议题，已有已接受/被取代决策的来源附带 ADR 编号。
 */
export function aggregateConstraints(topics: readonly TopicDetail[]): AggregatedConstraint[] {
  const adrNumbers = computeAdrNumberAssignments(topics);
  const byLabel = new Map<string, AggregatedConstraint>();

  for (const topic of topics) {
    for (const constraint of topic.constraints) {
      const source: AggregatedConstraintSource = {
        topicId: topic.id,
        topicTitle: topic.title,
        timeLabel: topic.updatedLabel,
        ...(adrNumbers.has(topic.id) ? { adrNumber: adrNumbers.get(topic.id) } : {}),
      };
      const existing = byLabel.get(constraint.label);
      if (!existing) {
        byLabel.set(constraint.label, { label: constraint.label, tone: constraint.tone, sources: [source] });
        continue;
      }
      if (!existing.sources.some((item) => item.topicId === topic.id)) {
        existing.sources.push(source);
      }
      if (constraint.tone === "warning") {
        existing.tone = "warning";
      }
    }
  }

  return [...byLabel.values()];
}

export type ArchitectureDiagramOrigin =
  | { kind: "decision"; adrNumber?: string }
  | { kind: "message"; author: AgentId; timeLabel: string };

export interface ArchitectureDiagramSource {
  code: string;
  topicId: string;
  topicTitle: string;
  origin: ArchitectureDiagramOrigin;
}

/**
 * 从已接受/被取代决策的 summary + rationale，以及 synthesis 类消息正文里提取全部
 * mermaid 代码块，集中供架构档案图集渲染。只信任「已经代表定论」的文本来源
 * （accepted/superseded 决策、synthesis 综合结论），不从仍在拉锯的 proposal/critique
 * 里提图，避免图集里混入还没达成共识的草稿。
 */
export function collectArchitectureDiagrams(topics: readonly TopicDetail[]): ArchitectureDiagramSource[] {
  const adrNumbers = computeAdrNumberAssignments(topics);
  const diagrams: ArchitectureDiagramSource[] = [];

  for (const topic of topics) {
    const decision = topic.decision;
    if (decision && (decision.status === "accepted" || decision.status === "superseded")) {
      const adrNumber = adrNumbers.get(topic.id);
      for (const text of [decision.summary, decision.rationale]) {
        for (const code of extractMermaidBlocks(text)) {
          diagrams.push({
            code,
            topicId: topic.id,
            topicTitle: topic.title,
            origin: { kind: "decision", ...(adrNumber ? { adrNumber } : {}) },
          });
        }
      }
    }

    for (const message of topic.messages) {
      if (message.kind !== "synthesis") {
        continue;
      }
      for (const code of extractMermaidBlocks(message.content)) {
        diagrams.push({
          code,
          topicId: topic.id,
          topicTitle: topic.title,
          origin: { kind: "message", author: message.author, timeLabel: message.createdLabel },
        });
      }
    }
  }

  return diagrams;
}
