/**
 * @input  依赖：SQLiteCouncilStore 收敛入口、编排 Run 生命周期与阶段指令契约
 * @output 导出：开局、按状态机自动交接下一位 Agent、终态结算的圆桌驱动器
 * @pos    把「谁下一个说话」从用户手里接过来的唯一处；自身不召唤 Agent，只创建并启动 Run
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import {
  buildStageInstruction,
  type DiscussionCycleView,
  type SQLiteCouncilStore,
} from "council-orchestrator";
import { logger } from "../logger.js";

/** 默认轮次预算：够一次提案 + 一轮反驳 + 一轮复核，再多通常是分歧不该由 Agent 解决。 */
export const DEFAULT_ROUND_BUDGET = 3;

export interface StartCycleInput {
  topicId: string;
  /** 首位是提案人；由用户在开局时勾选并冻结。 */
  participants: readonly string[];
  roundBudget?: number;
  /**
   * 这是一次 bug 修复互审：修复者必须先提交并附上 commit 引用，复审者只读 diff。
   *
   * 不落库是有意的——它只影响提案阶段的指令，而指令在创建 Run 时就冻结进了
   * 计划里；之后的阶段改从 turns 里已声明的 commit 引用推断，重启也不会丢。
   */
  requiresCommitRef?: boolean;
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
    const opened = this.#store.startDiscussionCycle({
      topicId: input.topicId,
      participants: input.participants,
      roundBudget: input.roundBudget ?? DEFAULT_ROUND_BUDGET,
      now: this.#now(),
    });
    await this.advance(input.topicId, input.requiresCommitRef ?? false);
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
  async advance(
    topicId: string,
    requiresCommitRef = false,
  ): Promise<DiscussionCycleView | undefined> {
    const pending = this.#inFlight.get(topicId);
    if (pending) {
      return await pending;
    }
    const running = this.#advanceOnce(topicId, requiresCommitRef).finally(() => {
      this.#inFlight.delete(topicId);
    });
    this.#inFlight.set(topicId, running);
    return await running;
  }

  async #advanceOnce(
    topicId: string,
    requiresCommitRef: boolean,
  ): Promise<DiscussionCycleView | undefined> {
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
        // 一旦有人声明过 commit 引用，这个 cycle 就是 diff 互审，重启后也认得出来。
        const isFixCycle = requiresCommitRef
          || cycle.turns.some((turn) => turn.commitRef !== undefined);
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
            ...(isFixCycle ? { requiresCommitRef: true } : {}),
            ...(reviewed?.commitRef ? { reviewedCommitRef: reviewed.commitRef } : {}),
          }),
        }]);
        await this.#runner.startRun(run.id);
        return this.#store.readActiveDiscussionCycle(topicId);
      }
      case "await_user":
        // 停在这里是刻意的：问题没答之前继续推进，后面每一段都建立在错误前提上。
        return view;
      case "abandon": {
        this.#store.abandonDiscussionCycle({
          cycleId: cycle.id,
          expectedVersion: cycle.stateVersion,
          reason: action.reason,
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
