/**
 * @input  依赖：SQLiteCouncilStore 收敛入口、编排 Run 生命周期与阶段指令契约
 * @output 导出：复用既有提案、自动交接下一位 Agent、终态结算的圆桌驱动器
 * @pos    把「谁下一个说话」从用户手里接过来的唯一处；自身不召唤 Agent，只创建并启动 Run
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  buildStageInstruction,
  OrchestrationConfigError,
  type DiscussionCycleView,
  type DiscussionCycleKind,
  type FrozenCycleRequirements,
  type RuntimeCapabilitySnapshot,
  type SQLiteCouncilStore,
} from "council-orchestrator";
import { logger } from "../logger.js";

/** 默认轮次预算：够一次提案 + 一轮反驳 + 一轮复核，再多通常是分歧不该由 Agent 解决。 */
export const DEFAULT_ROUND_BUDGET = 3;

export interface StartCycleInput {
  topicId: string;
  /** 首位是提案人；议题发起人入选时由服务端自动置首，否则保留用户勾选顺序。 */
  participants: readonly string[];
  roundBudget?: number;
  /** 开局冻结，后续推进不得再从 commit 或调用参数猜测。 */
  kind: DiscussionCycleKind;
  requirements: FrozenCycleRequirements;
  runtimeCapabilities: readonly RuntimeCapabilitySnapshot[];
}

export interface CycleRunner {
  createRun(
    topicId: string,
    plan: readonly {
      adapterId: string;
      messageKind: "proposal" | "critique" | "rebuttal" | "synthesis";
      instruction: string;
    }[],
  ): Promise<{ id: string }>;
  startRun(runId: string): Promise<unknown>;
}

export interface CycleDecisionWriter {
  /** 用最终 synthesis 正文创建 proposed 决策；是否 accepted 只能由用户决定。 */
  recordProposedDecision(input: {
    topicId: string;
    cycleId: string;
    synthesisMessageId: string;
  }): Promise<{ id: string }>;
}

export interface CycleDriverDependencies {
  store: SQLiteCouncilStore;
  runner: CycleRunner;
  decisions: CycleDecisionWriter;
  now: () => string;
}

export class CycleDriver {
  readonly #store: SQLiteCouncilStore;
  readonly #runner: CycleRunner;
  readonly #decisions: CycleDecisionWriter;
  readonly #now: () => string;
  /** 同一议题串行推进，避免一次提交触发两条并发驱动。 */
  readonly #inFlight = new Map<string, Promise<DiscussionCycleView | undefined>>();

  constructor(dependencies: CycleDriverDependencies) {
    this.#store = dependencies.store;
    this.#runner = dependencies.runner;
    this.#decisions = dependencies.decisions;
    this.#now = dependencies.now;
  }

  async start(input: StartCycleInput): Promise<DiscussionCycleView> {
    const proposerAgentId = input.participants[0];
    const proposerActorId = input.runtimeCapabilities.find(
      (snapshot) => snapshot.adapterId === proposerAgentId,
    )?.actorId;
    if (!proposerAgentId || !proposerActorId) {
      throw new OrchestrationConfigError("圆桌缺少提案人的冻结身份，尚未启动。");
    }
    const reviewScope = input.requirements.reviewScope;
    const topicSeed = this.#store.readTopicProposalSeed(input.topicId);
    // 议题创建者已经公开了问题、约束和修复证据。它入选时直接冻结议题为提案，
    // 首个真实调用从其他评审开始；只有阻塞异议才会再次召回发起人。
    const seedFromTopic = topicSeed?.actorId === proposerActorId;
    // 非发起人的工作区旧提案不能证明它看过当前可变状态，仍需重新召唤主审。
    const reusableCandidate = seedFromTopic || reviewScope === "workspace"
      ? undefined
      : this.#store.findReusableProposalMessage(input.topicId, proposerActorId);
    // Commit 可能已明确写在议题正文而不是旧提案尾块里。此时应召唤主审读取议题并验证，
    // 而不是在任何 Agent 看到上下文前就误判“没有 commit”。
    const reusableProposal = reviewScope === "commit"
      && !reusableCandidate?.commitTargets?.length
      ? undefined
      : reusableCandidate;
    const opened = this.#store.startDiscussionCycle({
      topicId: input.topicId,
      participants: input.participants,
      kind: input.kind,
      requirements: input.requirements,
      runtimeCapabilities: input.runtimeCapabilities,
      roundBudget: input.roundBudget ?? DEFAULT_ROUND_BUDGET,
      ...(seedFromTopic
        ? { seedFromTopic: true }
        : reusableProposal
        ? { seedProposalMessageId: reusableProposal.messageId }
        : {}),
      now: this.#now(),
    });
    await this.advance(input.topicId);
    return this.#store.readActiveDiscussionCycle(input.topicId) ?? opened;
  }

  /** 用户主动放弃圆桌；失败卡住时这是把议题解锁的唯一出口。 */
  abandon(topicId: string): DiscussionCycleView | undefined {
    const view = this.#store.readActiveDiscussionCycle(topicId);
    if (!view) {
      return undefined;
    }
    this.#store.abandonDiscussionCycle({
      cycleId: view.cycle.id,
      expectedVersion: view.cycle.stateVersion,
      reason: "cancelled",
      now: this.#now(),
    });
    return view;
  }

  /**
   * 推进一步：读当前状态，按状态机的判定决定召唤谁或如何结算。
   *
   * 只推进一步，不循环。下一步由 Run 提交后再次调用触发——发言是在提交事务里
   * 记上的，所以「提交完成」本身就是可以继续的信号，驱动器不需要自己轮询。
   */
  async advance(topicId: string): Promise<DiscussionCycleView | undefined> {
    const pending = this.#inFlight.get(topicId);
    if (pending) {
      return await pending;
    }
    const running = this.#advanceOnce(topicId).finally(() => {
      this.#inFlight.delete(topicId);
    });
    this.#inFlight.set(topicId, running);
    return await running;
  }

  async #advanceOnce(topicId: string): Promise<DiscussionCycleView | undefined> {
    const view = this.#store.readActiveDiscussionCycle(topicId);
    if (!view) {
      return undefined;
    }
    const { cycle, action } = view;
    switch (action.kind) {
      case "invoke": {
        if (this.#store.hasActiveOrchestrationRun(topicId)) {
          // 上一个 Run 还没跑完（常见于停在审批门）：它没提交发言，状态机看到的
          // 还是同一位待发言。此时再开一个 Run 会让同一阶段被召唤两次。
          return view;
        }
        const reviewers = cycle.participants.filter(
          (participant) => participant !== action.agentId,
        );
        const proposer = cycle.participants[0] ?? action.agentId;
        const reviewScope = cycle.requirements.reviewScope;
        const reviewed = action.stage === "critique"
          ? [...cycle.turns]
            .reverse()
            .find((turn) => turn.stage === "proposal" || turn.stage === "rebuttal")
          : undefined;
        const run = await this.#runner.createRun(topicId, [{
          adapterId: action.agentId,
          messageKind: action.stage,
          instruction: buildStageInstruction({
            stage: action.stage,
            round: action.round,
            roundBudget: cycle.roundBudget,
            reviewers,
            proposer,
            reviewScope,
            ...(reviewScope === "commit" && reviewed?.commitTargets?.length
              ? { reviewedCommitTargets: reviewed.commitTargets }
              : {}),
          }),
        }]);
        await this.#runner.startRun(run.id);
        return this.#store.readActiveDiscussionCycle(topicId);
      }
      case "await_user":
        // 停在这里是刻意的：问题没答之前继续推进，后面每一段都建立在错误前提上。
        return view;
      case "abandon": {
        const blockingItems = cycle.turns
          .filter(
            (turn) =>
              turn.round === cycle.currentRound
              && turn.stance === "blocking",
          )
          .map((turn) => ({
            agentId: turn.agentId,
            round: turn.round,
            messageId: turn.messageId,
          }));
        this.#store.abandonDiscussionCycle({
          cycleId: cycle.id,
          expectedVersion: cycle.stateVersion,
          reason: action.reason,
          ...(action.reason === "round_budget_exhausted"
            ? {
                outcome: {
                  kind: "blocking_disagreements" as const,
                  items: blockingItems,
                },
              }
            : {}),
          now: this.#now(),
        });
        logger.info(
          "orchestration",
          `圆桌讨论放弃：topic=${topicId} 原因=${action.reason}`,
        );
        return undefined;
      }
      case "done": {
        const synthesis = [...cycle.turns]
          .reverse()
          .find((turn) => turn.stage === "synthesis");
        if (!synthesis) {
          throw new Error("Council 收敛完成但缺少 synthesis 发言。");
        }
        const decision = await this.#decisions.recordProposedDecision({
          topicId,
          cycleId: cycle.id,
          synthesisMessageId: synthesis.messageId,
        });
        this.#store.completeDiscussionCycle({
          cycleId: cycle.id,
          expectedVersion: cycle.stateVersion,
          proposedDecisionId: decision.id,
          now: this.#now(),
        });
        return undefined;
      }
      default:
        // `converge` 只是状态机内部的中转，读取时不会作为持久化状态出现。
        return view;
    }
  }
}
