/**
 * @input  依赖：CouncilOrchestrator、lease/sweeper 配置与进程生命周期
 * @output 导出：后台 claim/drive/renew/release、周期恢复与有界关闭管理器
 * @pos    快速 REST 控制面与长期 Agent 执行面之间的进程级调度器
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { randomUUID } from "node:crypto";
import {
  classifyRestartDisposition,
  CouncilOrchestrator,
  LeaseConflictError,
  LeaseLostError,
  type ApproveGateInput,
  type ApproveGateResult,
  type OrchestrationRun,
  type RunLease,
} from "council-orchestrator";
import { logger } from "../logger.js";

export interface RunExecutionManagerOptions {
  leaseTtlMs: number;
  leaseRenewMs: number;
  sweepIntervalMs: number;
  runPageLimit: number;
  startupScanLimit: number;
  shutdownTimeoutMs: number;
}

type ExecutionMode = "drive" | "interrupt";

function boundedWait(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    promise.then(finish, finish);
  });
}

export class RunExecutionManager {
  readonly #ownerId = `council-runner-${String(process.pid)}-${randomUUID()}`;
  readonly #tasks = new Map<string, Promise<void>>();
  #shuttingDown = false;
  #sweepTimer?: NodeJS.Timeout;
  #sweepPromise?: Promise<void>;

  constructor(
    private readonly orchestrator: CouncilOrchestrator,
    private readonly options: RunExecutionManagerOptions,
  ) {}

  async start(runId: string): Promise<OrchestrationRun> {
    const run = await this.orchestrator.begin(runId);
    if (run.status === "running") {
      this.#schedule(run.id, "drive");
    }
    return run;
  }

  async approve(input: ApproveGateInput): Promise<ApproveGateResult> {
    const result = await this.orchestrator.applyApproval(input);
    if (result.run.status === "running") {
      this.#schedule(result.run.id, "drive");
    }
    return result;
  }

  async recover(runId: string): Promise<OrchestrationRun> {
    const run = await this.orchestrator.prepareRecovery(runId);
    this.#schedule(run.id, "drive");
    return run;
  }

  async cancel(runId: string): Promise<OrchestrationRun> {
    return await this.orchestrator.cancel(runId);
  }

  async recoverOnStartup(): Promise<void> {
    await this.#collectAndSchedule();
    if (!this.#shuttingDown && !this.#sweepTimer) {
      this.#sweepTimer = setInterval(() => this.#runSweep(), this.options.sweepIntervalMs);
      this.#sweepTimer.unref();
    }
  }

  async #collectAndSchedule(): Promise<void> {
    const candidates: OrchestrationRun[] = [];
    let offset = 0;
    while (true) {
      const remaining = this.options.startupScanLimit - candidates.length;
      if (remaining <= 0) {
        throw new Error("启动恢复候选运行超过配置上限，拒绝静默漏恢复。");
      }
      const page = await this.orchestrator.listRestartCandidates({
        limit: Math.min(this.options.runPageLimit, remaining),
        offset,
      });
      candidates.push(...page.runs);
      if (!page.hasMore) {
        break;
      }
      if (candidates.length >= this.options.startupScanLimit) {
        throw new Error("启动恢复候选运行超过配置上限，拒绝静默漏恢复。");
      }
      if (page.runs.length === 0) {
        throw new Error("启动恢复分页没有前进，拒绝继续启动。");
      }
      offset = page.nextOffset ?? offset + page.runs.length;
    }
    for (const run of candidates) {
      const disposition = classifyRestartDisposition(run);
      if (disposition === "resume_running") {
        this.#schedule(run.id, "drive");
      } else if (disposition === "fail_interrupted_agent") {
        this.#schedule(run.id, "interrupt");
      }
    }
  }

  async waitForIdle(timeoutMs = this.options.shutdownTimeoutMs): Promise<void> {
    await boundedWait(Promise.allSettled([...this.#tasks.values()]), timeoutMs);
  }

  async shutdown(): Promise<void> {
    if (this.#shuttingDown) {
      await this.waitForIdle();
      return;
    }
    this.#shuttingDown = true;
    if (this.#sweepTimer) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = undefined;
    }
    const reason = new LeaseLostError("执行进程正在关闭，活动调用将由启动恢复流程处理。");
    for (const runId of this.#tasks.keys()) {
      this.orchestrator.abortActiveInvocation(runId, reason);
    }
    const pending = [
      ...(this.#sweepPromise ? [this.#sweepPromise] : []),
      ...this.#tasks.values(),
    ];
    await boundedWait(Promise.allSettled(pending), this.options.shutdownTimeoutMs);
  }

  #runSweep(): void {
    if (this.#shuttingDown || this.#sweepPromise) {
      return;
    }
    this.#sweepPromise = this.#collectAndSchedule()
      .catch((error: unknown) => {
        logger.error("orchestration", "活动运行周期扫描失败", error);
      })
      .finally(() => {
        this.#sweepPromise = undefined;
      });
  }

  #schedule(runId: string, mode: ExecutionMode): void {
    if (this.#shuttingDown || this.#tasks.has(runId)) {
      return;
    }
    const task = this.#execute(runId, mode)
      .catch((error: unknown) => {
        if (!(error instanceof LeaseConflictError || error instanceof LeaseLostError)) {
          logger.error("orchestration", "后台运行执行失败", error);
        }
      })
      .finally(() => {
        this.#tasks.delete(runId);
      });
    this.#tasks.set(runId, task);
  }

  async #execute(runId: string, mode: ExecutionMode): Promise<void> {
    let lease = await this.orchestrator.claimRunLease({
      runId,
      ownerId: this.#ownerId,
      ttlMs: this.options.leaseTtlMs,
    });
    let renewal: Promise<void> | undefined;
    let renewalFailed = false;
    const renew = (): void => {
      if (renewal || renewalFailed) {
        return;
      }
      renewal = this.orchestrator
        .renewRunLease({ lease, ttlMs: this.options.leaseTtlMs })
        .then((renewed) => {
          lease = renewed;
        })
        .catch(() => {
          renewalFailed = true;
          this.orchestrator.abortActiveInvocation(
            runId,
            new LeaseLostError("执行 lease 续租失败或已被显式取消。"),
          );
        })
        .finally(() => {
          renewal = undefined;
        });
    };
    const timer = setInterval(renew, this.options.leaseRenewMs);
    timer.unref();
    try {
      if (mode === "interrupt") {
        await this.orchestrator.markInterruptedAgent(runId, lease);
      } else {
        await this.orchestrator.drive(runId, lease);
      }
    } finally {
      clearInterval(timer);
      await renewal;
      await this.orchestrator.releaseRunLease(lease).catch(() => false);
    }
  }
}
