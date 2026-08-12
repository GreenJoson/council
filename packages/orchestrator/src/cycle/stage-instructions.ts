/**
 * @input  依赖：收敛阶段枚举、周期类型与结构化尾块契约
 * @output 导出：四段协议、多仓库 Git 工具调用、工作区审查/commit 互审边界与尾块格式说明
 * @pos    Agent 侧协议契约的唯一正本；改这里就等于改协议，必须同步 verdict.ts 的解析
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { DebateStage } from "./convergence.js";
import type { CycleReviewScope } from "./runtime-capabilities.js";
import type { AgentFixTarget } from "./verdict.js";

export interface StageInstructionInput {
  stage: DebateStage;
  round: number;
  roundBudget: number;
  /** 本阶段的其他参与者，用于说明"谁会复审你"。 */
  reviewers: readonly string[];
  /** 提案人 Agent id；反驳与收敛阶段由它执行。 */
  proposer: string;
  /** 本轮由服务端冻结并授权给只读 Git 工具的 commit 引用。 */
  reviewedCommitTargets?: readonly AgentFixTarget[];
  /** 决定本轮审的是方案、可变工作区还是冻结 commit。 */
  reviewScope?: CycleReviewScope;
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

/**
 * 只读主审的引用传递格式。代码修改和提交必须先由交互式开发任务完成；
 * Council 只验证并传递不可变 commit，不在 headless Runtime 里写文件。
 */
const FIX_SPEC = [
  "## 这是一次只读 bug 修复互审",
  "",
  "本轮不负责修改代码。先通读议题标题、问题、约束和公开记录，从中找到每个本地仓库",
  "及其 commit 引用；逐一验证仓库路径、对象存在性、真实 diff 和必要上下文。不要修改文件、",
  "运行写操作、创建提交、推送或部署。正文之后必须结构化传递全部被审目标：",
  "",
  "```council-fix",
  '{"targets":[{"repository":".","commit":"<sha>"},{"repository":"../sibling-repo","commit":"<sha>"}],"summary":"这些改动解决了什么"}',
  "```",
  "",
  "repository 使用相对议题项目目录的路径，当前仓库写 `.`；commit 必须是对应仓库中",
  "已经存在的对象名（7 位以上十六进制），不能填分支名或 tag。找不到明确引用、对象",
  "不存在或任一仓库无法读取时，不要猜；标记 `blocking`，并通过 `council-question` 补证据。",
].join("\n");

const WORKSPACE_SPEC = [
  "## 这是一次当前工作区只读互审",
  "",
  "本轮审查议题项目目录中的当前文件，包括未提交改动。先读取真实代码；Runtime 支持时",
  "同时检查 `git status --short`、暂存与未暂存 diff。不要修改文件、创建提交、推送或部署。",
  "",
  "工作区不是冻结证据：结论只对本轮读取到的可变快照负责。若审查期间文件发生变化，",
  "必须明确标记 `blocking` 并要求重新开局，不能把前后两个状态拼成同一份结论。",
].join("\n");

function commitTargetBody(input: StageInstructionInput): readonly string[] {
  if (input.reviewedCommitTargets?.length) {
    const commands = input.reviewedCommitTargets.map(
      (target) => `- \`council_git_diff(${JSON.stringify({
        repository: target.repository,
        commit: target.commit,
      })})\``,
    );
    return [
      "",
      "本轮已授权读取的冻结改动（按原样调用只读工具）：",
      ...commands,
      "",
      "逐一读完真实 diff 和必要的上下文文件再下判断。",
      "关联仓库的上下文文件同样使用上述 repository 标签调用 read/list/search 工具；",
      "不要把 ../仓库名塞进当前项目路径后再误判为项目外目录。",
      "不要凭提交说明或对方的描述判断改动是否正确。",
      "",
      "你是只读复审：不要修改任何文件、不要提交、不要部署。",
      "发现问题就写清楚在哪一行、什么输入会触发、期望行为是什么，交回给修复者。",
    ];
  }
  return [];
}

function reviewerList(reviewers: readonly string[]): string {
  return reviewers.length > 0 ? reviewers.join("、") : "（无其他参与者）";
}

function stageBody(input: StageInstructionInput): readonly string[] {
  const reviewScope = input.reviewScope ?? "discussion";
  switch (input.stage) {
    case "proposal":
      if (reviewScope === "commit") {
        return [
          "你是本次修复的只读主审。修复已由交互式开发任务完成；你只审查已有 commit/diff，",
          "不修改文件、不运行写操作、不创建提交。",
          "",
          `随后 ${reviewerList(input.reviewers)} 会独立复审你的判断并可以否决它，`,
          "所以结论必须引用真实 diff，写清修复是否命中根因、边界风险和验证证据。",
        ];
      }
      if (reviewScope === "workspace") {
        return [
          "你是当前工作区的只读主审。不要先写方案摘要；先检查真实代码和当前改动，",
          "再判断实现是否命中根因、是否引入边界回归，以及验证证据是否充分。",
          "",
          `随后 ${reviewerList(input.reviewers)} 会独立复审你的代码判断并可以否决它，`,
          "所以每个结论必须指向具体文件、机制、触发输入和可执行验证。",
        ];
      }
      return [
        "你是本议题的提案人。基于公开的问题、约束与证据给出一个可执行方案。",
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
        "",
        ...(reviewScope === "commit"
          ? [
              "这是已提交修复互审。永远不要放行你验证不了的改动：缺少",
              "`council-fix` 尾块里的仓库/commit 目标时，直接判 `blocking` 并要求补上。",
            ]
          : reviewScope === "workspace"
            ? [
                "这是当前工作区互审。不要只复述主审描述；请独立读取当前文件、",
                "可用的工作区 diff 与必要上下文，并明确说明结论针对可变快照。",
              ]
            : []),
      ];
    case "rebuttal":
      if (reviewScope === "commit") {
        return [
          "评审对被审 commit 提出了阻塞级异议。基于同一份真实 diff 逐条回应，",
          "接受问题或用代码证据反驳；不要修改文件或另建提交。",
          "",
          `回应之后 ${reviewerList(input.reviewers)} 会再看一轮——`,
          "分歧是否解决由评审判定，不由你宣布。",
        ];
      }
      if (reviewScope === "workspace") {
        return [
          "评审对当前工作区提出了阻塞级异议。重新读取相关文件，逐条用当前代码证据回应；",
          "不要假设工作区仍与上一轮相同，也不要修改文件。",
          "",
          `回应之后 ${reviewerList(input.reviewers)} 会再看一轮——`,
          "分歧是否解决由评审判定，不由你宣布。",
        ];
      }
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
  const reviewScope = input.reviewScope ?? "discussion";
  // 主审在 proposal/rebuttal 中传递同一 immutable commit；critique 只消费该引用。
  const wantsFixSpec = reviewScope === "commit"
    && (input.stage === "proposal" || input.stage === "rebuttal");
  const wantsWorkspaceSpec = reviewScope === "workspace";
  return [
    `# 当前阶段：${input.stage}（第 ${String(input.round)}/${String(input.roundBudget)} 轮）`,
    "",
    ...stageBody(input),
    ...(reviewScope === "commit" ? commitTargetBody(input) : []),
    "",
    ...(wantsWorkspaceSpec ? [WORKSPACE_SPEC, ""] : []),
    ...(wantsFixSpec ? [FIX_SPEC, ""] : []),
    TRAILER_SPEC,
  ].join("\n");
}
