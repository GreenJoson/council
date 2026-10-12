/**
 * @input  依赖：DesktopBridge 的设置与本地 Agent 服务配置/健康命令、HttpPipelineRepository、离线指引 buildOfflineLimitation
 * @output 导出：DesktopPipelineRepository、其桥接子接口与构造参数类型
 * @pos    桌面模式流水线仓储：Tauri 没有流水线命令（契约约定不新增），读写全部经本地 Agent 服务 HTTP。
 *         服务离线时：列表返回 {items: [], limitation}，详情与写操作抛出与编排面板一致的诚实指引
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { DesktopBridge, DesktopSettings } from "../desktop-bridge";
import { buildOfflineLimitation } from "../desktop-orchestration-repository";
import { readProjectPathConfig } from "../project-path";
import { HttpPipelineRepository } from "./http-pipeline-repository";
import type { PipelineRepository } from "./pipeline-repository";
import type {
  CreatePipelineInput,
  PipelineDetail,
  PipelineDispatchResult,
  PipelineListResult,
} from "../../types/pipelines";

/** 仅暴露流水线仓储需要的桥接命令，方便注入替身。 */
export type DesktopPipelineBridge = Pick<
  DesktopBridge,
  "getSettings" | "getOrchestrationConfig" | "checkOrchestrationService"
>;

export interface DesktopPipelineRepositoryOptions {
  bridge: DesktopPipelineBridge;
  /** 本地服务可达时按 (服务地址, 当前项目路径) 构造 HTTP 实现；默认 HttpPipelineRepository。 */
  createHttpDelegate?: (baseUrl: string, projectPath: string) => PipelineRepository;
}

export class DesktopPipelineRepository implements PipelineRepository {
  readonly #bridge: DesktopPipelineBridge;
  readonly #createHttpDelegate: (baseUrl: string, projectPath: string) => PipelineRepository;
  /** 服务地址来自 Rust 设置层且运行期不变，读一次即可；失败时下次再读。 */
  #baseUrl: string | undefined;

  constructor(options: DesktopPipelineRepositoryOptions) {
    this.#bridge = options.bridge;
    this.#createHttpDelegate = options.createHttpDelegate
      ?? ((baseUrl, projectPath) => new HttpPipelineRepository({ baseUrl, projectPath }));
  }

  /** 列表离线时不抛出：返回空列表 + 诚实提示，由视图展示而不是整页报错。 */
  async listPipelines(): Promise<PipelineListResult> {
    let delegate: PipelineRepository | undefined;
    try {
      delegate = await this.#tryLive();
    } catch (error: unknown) {
      if (error instanceof ProjectNotConfiguredError) return { items: [], limitation: error.message };
      delegate = undefined;
    }
    if (!delegate) return { items: [], limitation: buildOfflineLimitation(this.#baseUrl) };
    return delegate.listPipelines();
  }

  async getPipeline(pipelineId: string): Promise<PipelineDetail> {
    return (await this.#requireLive()).getPipeline(pipelineId);
  }

  async createPipeline(input: CreatePipelineInput): Promise<PipelineDetail> {
    return (await this.#requireLive()).createPipeline(input);
  }

  async dispatchPipeline(topicId: string, messageId: string): Promise<PipelineDispatchResult> {
    return (await this.#requireLive()).dispatchPipeline(topicId, messageId);
  }

  async confirmBrief(pipelineId: string, brief: Record<string, unknown>, expectedVersion: number): Promise<PipelineDetail> {
    return (await this.#requireLive()).confirmBrief(pipelineId, brief, expectedVersion);
  }

  async selectFinal(pipelineId: string, assetIds: string[], expectedVersion: number): Promise<PipelineDetail> {
    return (await this.#requireLive()).selectFinal(pipelineId, assetIds, expectedVersion);
  }

  async resumePipeline(pipelineId: string, expectedVersion: number): Promise<PipelineDetail> {
    return (await this.#requireLive()).resumePipeline(pipelineId, expectedVersion);
  }

  async cancelPipeline(pipelineId: string, expectedVersion: number): Promise<PipelineDetail> {
    return (await this.#requireLive()).cancelPipeline(pipelineId, expectedVersion);
  }

  /** 详情与写操作必须在服务可达时执行；离线时抛出与编排面板一致的诚实指引。 */
  async #requireLive(): Promise<PipelineRepository> {
    let delegate: PipelineRepository | undefined;
    try {
      delegate = await this.#tryLive();
    } catch (error: unknown) {
      // 设置未就绪（未选项目）是用户可处理的错误，原样抛出；其余桥接异常归为离线。
      if (error instanceof ProjectNotConfiguredError) throw error;
      delegate = undefined;
    }
    if (!delegate) throw new Error(buildOfflineLimitation(this.#baseUrl));
    return delegate;
  }

  /** 与 DesktopTaskRepository 相同的探测方式：Rust 设置给地址、Rust 侧做健康检查。 */
  async #tryLive(): Promise<PipelineRepository | undefined> {
    if (this.#baseUrl === undefined) {
      this.#baseUrl = (await this.#bridge.getOrchestrationConfig()).baseUrl;
    }
    const health = await this.#bridge.checkOrchestrationService();
    if (!health.reachable) return undefined;
    const projectPath = requireProjectPath(await this.#bridge.getSettings());
    return this.#createHttpDelegate(this.#baseUrl, projectPath);
  }
}

class ProjectNotConfiguredError extends Error {}

function requireProjectPath(settings: DesktopSettings): string {
  if (!settings.logLibrary || !settings.currentProjectPath) {
    throw new ProjectNotConfiguredError("请先设置日志库并选择项目目录");
  }
  return readProjectPathConfig(settings.currentProjectPath);
}
