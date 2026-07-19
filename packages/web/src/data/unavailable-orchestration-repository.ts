/**
 * @input  依赖：OrchestrationRepository 协议
 * @output 导出：桌面 V1 的显式不可用编排仓储
 * @pos    Rust Runtime 未接通前防止桌面端伪装自动轮次成功
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type {
  ApproveOrchestrationRunInput,
  CreateOrchestrationRunInput,
  OrchestrationRun,
  OrchestrationSnapshot,
} from "../types/orchestration";
import type {
  OrchestrationListener,
  OrchestrationRepository,
} from "./orchestration-repository";

const LIMITATION = "桌面 V1 尚未接入 Rust Agent Runtime；内容协作可正常使用。";

const SNAPSHOT: OrchestrationSnapshot = {
  capabilities: {
    adapters: [{
      id: "desktop-runtime",
      publicAuthor: "claude",
      label: "桌面 Agent Runtime",
      available: false,
      limitation: LIMITATION,
    }],
    defaultPolicy: {
      maxRounds: 1,
      agentTimeoutMs: 1,
      maxAttemptsPerRound: 1,
      maxManualRecoveries: 0,
      confirmation: { beforeRounds: [], beforeCompletion: true },
    },
  },
  runs: [],
  sync: { status: "offline", label: "桌面自动轮次未接入" },
};

function unavailable(): never {
  throw new Error(LIMITATION);
}

export class UnavailableOrchestrationRepository implements OrchestrationRepository {
  async loadCapabilities(): Promise<OrchestrationSnapshot> {
    return structuredClone(SNAPSHOT);
  }

  async selectTopic(topicId: string): Promise<OrchestrationSnapshot> {
    return { ...structuredClone(SNAPSHOT), activeTopicId: topicId };
  }

  async getRun(_runId: string): Promise<OrchestrationRun> { return unavailable(); }
  async createRun(_input: CreateOrchestrationRunInput): Promise<OrchestrationRun> { return unavailable(); }
  async startRun(_runId: string): Promise<OrchestrationSnapshot> { return unavailable(); }
  async approveRun(_input: ApproveOrchestrationRunInput): Promise<OrchestrationSnapshot> { return unavailable(); }
  async cancelRun(_runId: string): Promise<OrchestrationSnapshot> { return unavailable(); }
  async recoverRun(_runId: string): Promise<OrchestrationSnapshot> { return unavailable(); }
  subscribe(_listener: OrchestrationListener): () => void { return () => undefined; }
}
