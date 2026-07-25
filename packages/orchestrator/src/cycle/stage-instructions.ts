/**
 * @input  依赖：收敛阶段枚举与结构化尾块契约
 * @output 导出：四段协议下发给 Agent 的阶段指令与尾块格式说明
 * @pos    Agent 侧协议契约的唯一正本；改这里就等于改协议，必须同步 verdict.ts 的解析
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { DebateStage } from "./convergence.js";

export interface StageInstructionInput {
  stage: DebateStage;
  round: number;
  roundBudget: number;
  /** 本阶段的其他参与者，用于说明"谁会复审你"。 */
  reviewers: readonly string[];
  /** 提案人 Agent id；反驳与收敛阶段由它执行。 */
  proposer: string;
}

/**
 * 尾块规格对所有阶段一致。刻意用围栏代码块而不是隐藏字段：
 * 这条消息本身就是公开记录，用户要能一眼看出每个 Agent 到底是放行还是拦截。
 */
const TRAILER_SPEC = [
  "## 回复格式（必须遵守）",
  "",
  "正文用 Markdown 写结论、理由、风险、验证方式。正文之后必须附上立场尾块：",
  "",
  "```council-verdict",
  '{"stance":"agree|non_blocking|blocking","summary":"一句话说明立场"}',
  "```",
  "",
  "- `agree`：没有异议，可以推进",
  "- `non_blocking`：异议记录在案，但不拦截收敛",
  "- `blocking`：必须先解决，否则不能进入结论",
  "",
  "尾块缺失或格式非法会被判定为 `blocking`，讨论会因此多走一轮。",
  "",
  "遇到只有业务方能决定的取舍（产品优先级、定价、合规口径、上线时机等），",
  "不要替用户假设，另外附上提问尾块并停下等待回答：",
  "",
  "```council-question",
  '{"question":"要问什么","rationale":"为什么这个问题会改变技术方案","options":["候选一","候选二"]}',
  "```",
  "",
  "只在答案会实质改变方案时提问；纯技术取舍应当由你自己基于证据判断。",
].join("\n");

function reviewerList(reviewers: readonly string[]): string {
  return reviewers.length > 0 ? reviewers.join("、") : "（无其他参与者）";
}

function stageBody(input: StageInstructionInput): readonly string[] {
  switch (input.stage) {
    case "proposal":
      return [
        "你是本议题的提案人。基于当前项目代码给出一个可执行方案。",
        "",
        `随后 ${reviewerList(input.reviewers)} 会独立复审你的方案并可以否决它，`,
        "所以结论必须可验证、可反驳：写清方案、关键取舍、已知风险和验证方式。",
        "不要罗列备选而不选，请明确给出你推荐的那一个。",
      ];
    case "critique":
      return [
        `你在复审 ${input.proposer} 的方案。默认不同意，直到证据让你同意。`,
        "",
        "对抗性审查：主动找反例、边界条件、失败路径、并发问题、权限绕过、",
        "数据污染、迁移风险和回滚风险。每个问题必须指向具体代码或具体场景，",
        "并给出可执行的修正建议——泛泛挑刺不算复审。",
        "",
        "把「必须先解决」和「记录即可」分清楚：只有会让方案失败或不可回滚的问题",
        "才标 `blocking`。为了显得严谨而滥用 `blocking` 会让讨论永远收敛不了。",
      ];
    case "rebuttal":
      return [
        "评审提出了阻塞级异议。逐条正面回应：接受并说明如何修改，或用证据反驳。",
        "",
        "不要重述原方案，只回应分歧点。",
        `回应之后 ${reviewerList(input.reviewers)} 会再看一轮——`,
        "分歧是否解决由评审判定，不由你宣布。",
      ];
    default:
      return [
        "分歧已经收敛。把讨论结果写成一条可执行的决策。",
        "",
        "必须包含：最终方案、被否决的替代方案及否决理由、已知风险、验证方式。",
        "评审提出的非阻塞异议要如实保留，不要在收敛时悄悄抹掉。",
        "这段正文会作为 proposed 决策的正文，最终是否采纳由用户决定。",
      ];
  }
}

/** 组装某一阶段下发给 Agent 的完整指令。 */
export function buildStageInstruction(input: StageInstructionInput): string {
  return [
    `# 当前阶段：${input.stage}（第 ${String(input.round)}/${String(input.roundBudget)} 轮）`,
    "",
    ...stageBody(input),
    "",
    TRAILER_SPEC,
  ].join("\n");
}
