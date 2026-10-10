/**
 * @input  依赖：http-client 统一请求/URL 构造、pipeline-api 严格解析器
 * @output 导出：HttpPipelineRepository（/api/v1/pipelines 全量 REST 实现）与其构造参数类型
 * @pos    http 模式的流水线仓储；桌面模式也用它承接全部读写（每次按当前项目路径构造）。
 *         响应沿用 {code, message, data, timestamp}，409/400/503 等错误文案原样透出给 getErrorMessage
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { createApiUrl, jsonRequest, requestApiData, type Fetcher } from "../http-client";
import { parsePipelineCreated, parsePipelineDetail, parsePipelineSummaries } from "./pipeline-api";
import type { PipelineRepository } from "./pipeline-repository";
import type {
  CreatePipelineInput,
  PipelineDetail,
  PipelineListResult,
} from "../../types/pipelines";

export interface HttpPipelineRepositoryOptions {
  baseUrl: string;
  /** 绝对项目路径；列表与创建都绑定它，UI 不传。 */
  projectPath: string;
  fetcher?: Fetcher;
}

type PipelineAction = "brief" | "final" | "resume" | "cancel";

export class HttpPipelineRepository implements PipelineRepository {
  readonly #baseUrl: string;
  readonly #projectPath: string;
  readonly #fetcher: Fetcher;

  constructor(options: HttpPipelineRepositoryOptions) {
    const projectPath = options.projectPath.trim();
    if (!projectPath) {
      throw new Error("流水线仓储必须绑定项目路径");
    }
    // 先构造一次以尽早暴露非法地址，而不是等第一次请求才失败。
    createApiUrl(options.baseUrl, "/api/v1/pipelines");
    this.#baseUrl = options.baseUrl;
    this.#projectPath = projectPath;
    this.#fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async listPipelines(): Promise<PipelineListResult> {
    const items = await requestApiData(
      this.#fetcher,
      createApiUrl(this.#baseUrl, "/api/v1/pipelines", { project: this.#projectPath }),
      parsePipelineSummaries,
    );
    return { items };
  }

  async getPipeline(pipelineId: string): Promise<PipelineDetail> {
    return requestApiData(this.#fetcher, this.#pipelineUrl(pipelineId), parsePipelineDetail);
  }

  async createPipeline(input: CreatePipelineInput): Promise<PipelineDetail> {
    return requestApiData(
      this.#fetcher,
      createApiUrl(this.#baseUrl, "/api/v1/pipelines"),
      parsePipelineCreated,
      jsonRequest({
        project: this.#projectPath,
        template: input.template,
        goal: input.goal,
        ...(input.constraints?.length ? { constraints: input.constraints } : {}),
        ...(input.referenceAssetIds?.length ? { referenceAssetIds: input.referenceAssetIds } : {}),
        // 未选择 Agent 时不发送，交给服务端按启用 Agent 选默认值。
        ...(input.agents && Object.keys(input.agents).length > 0 ? { agents: input.agents } : {}),
      }),
    );
  }

  async confirmBrief(pipelineId: string, brief: Record<string, unknown>, expectedVersion: number): Promise<PipelineDetail> {
    return this.#action(pipelineId, "brief", { brief, expectedVersion });
  }

  async selectFinal(pipelineId: string, assetIds: string[], expectedVersion: number): Promise<PipelineDetail> {
    return this.#action(pipelineId, "final", { assetIds, expectedVersion });
  }

  async resumePipeline(pipelineId: string, expectedVersion: number): Promise<PipelineDetail> {
    return this.#action(pipelineId, "resume", { expectedVersion });
  }

  async cancelPipeline(pipelineId: string, expectedVersion: number): Promise<PipelineDetail> {
    return this.#action(pipelineId, "cancel", { expectedVersion });
  }

  async #action(pipelineId: string, action: PipelineAction, body: Record<string, unknown>): Promise<PipelineDetail> {
    return requestApiData(
      this.#fetcher,
      this.#pipelineUrl(pipelineId, `/${action}`),
      parsePipelineDetail,
      jsonRequest(body),
    );
  }

  #pipelineUrl(pipelineId: string, suffix = ""): URL {
    return createApiUrl(this.#baseUrl, `/api/v1/pipelines/${encodeURIComponent(pipelineId)}${suffix}`);
  }
}
