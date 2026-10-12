/**
 * @input  依赖：CouncilDatabase（父任务/子任务/资产读写）、pipeline-document（文档解析）、共享常量与领域错误
 * @output 导出：PipelineStateStore（每条流水线的串行锁、父任务+文档读取、带版本核对的文档写入、子任务与产物查询、
 *         出图子任务收尾 completeImageChildren）
 * @pos    流水线驱动器与服务共用的状态读写层：文档写入一律「锁内重读父任务 → 校验 → 用刚读到的版本写」，
 *         因为子任务状态变化会派生父任务状态并让父版本 +1，不能复用调用方早先读到的版本；
 *         出图子任务收尾（被修订轮接手、选定终稿）也在这里，驱动器与服务共用同一套跳过与写入规则
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { MAX_PIPELINE_DOCUMENT_CHARS } from "../constants.js";
import type { CouncilDatabase } from "../database.js";
import { CouncilConflictError, CouncilNotFoundError } from "../errors.js";
import type { Asset, WorkItem } from "../types.js";
import { parsePipelineDocument, PipelineProtocolError, type PipelineDocument } from "./pipeline-document.js";

export interface PipelineSnapshot {
  task: WorkItem;
  document: PipelineDocument;
}

/** 单条流水线最多关联的产物数量（分页上限）；远大于实际轮数×每轮产物。 */
const MAX_OUTPUT_SCAN = 200;

export class PipelineStateStore {
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(readonly database: CouncilDatabase) {}

  /** 同一流水线的状态推进串行执行；不同流水线互不阻塞。fn 内不要再次申请同一把锁。 */
  async withLock<T>(pipelineId: string, fn: () => Promise<T> | T): Promise<T> {
    const previous = this.#locks.get(pipelineId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.#locks.set(pipelineId, tail);
    try {
      return await run;
    } finally {
      if (this.#locks.get(pipelineId) === tail) this.#locks.delete(pipelineId);
    }
  }

  load(pipelineId: string): PipelineSnapshot {
    let task: WorkItem;
    try {
      task = this.database.getWorkItem(pipelineId);
    } catch (error) {
      if (error instanceof CouncilNotFoundError) throw new CouncilNotFoundError("流水线不存在。");
      throw error;
    }
    if (task.kind !== "pipeline" || task.source !== "direct") throw new CouncilNotFoundError("流水线不存在。");
    try {
      return { task, document: parsePipelineDocument(task.brief) };
    } catch (error) {
      if (error instanceof PipelineProtocolError) throw new CouncilConflictError(`流水线文档已损坏：${error.message}`);
      throw error;
    }
  }

  /**
   * 文档写入：重读父任务；给了 expectedVersion（人工写入）就先核对，不符即 409；
   * mutate 返回新文档后严格重新解析、检查体积，再用刚读到的版本条件更新。
   */
  write(
    pipelineId: string,
    mutate: (snapshot: PipelineSnapshot) => PipelineDocument,
    options: { actorId: string; expectedVersion?: number },
  ): PipelineSnapshot {
    const snapshot = this.load(pipelineId);
    if (options.expectedVersion !== undefined && options.expectedVersion !== snapshot.task.version) {
      throw new CouncilConflictError("流水线已被更新，请刷新后重试。");
    }
    let document: PipelineDocument;
    try {
      document = parsePipelineDocument(mutate(snapshot));
    } catch (error) {
      if (error instanceof PipelineProtocolError) throw new CouncilConflictError(error.message);
      throw error;
    }
    if (JSON.stringify(document).length > MAX_PIPELINE_DOCUMENT_CHARS) {
      throw new CouncilConflictError(`流水线文档超过 ${String(MAX_PIPELINE_DOCUMENT_CHARS)} 字符上限。`);
    }
    const task = this.database.updatePipelineDocument({
      workItemId: pipelineId,
      expectedVersion: snapshot.task.version,
      document: document as unknown as Record<string, unknown>,
      actorId: options.actorId,
    });
    return { task, document };
  }

  /** 人工写入前的版本核对（不写文档的操作也要求带版本）。 */
  assertVersion(task: WorkItem, expectedVersion: number): void {
    if (task.version !== expectedVersion) throw new CouncilConflictError("流水线已被更新，请刷新后重试。");
  }

  children(task: WorkItem): WorkItem[] {
    if (!task.projectPath) return [];
    return this.database
      .listTasks({ projectPath: task.projectPath, source: "pipeline" })
      .filter((child) => child.parentId === task.id)
      .sort((left, right) => left.sortOrder - right.sortOrder);
  }

  /** 某个子任务以 output 角色挂着的未删除资产，按入库时间排序。 */
  outputAssets(projectPath: string, workItemId: string): Asset[] {
    return this.database
      .listAssets({ projectPath, target: { kind: "work_item", id: workItemId }, limit: MAX_OUTPUT_SCAN, offset: 0 })
      .items
      .filter((asset) => asset.links.some((link) =>
        link.targetKind === "work_item" && link.targetId === workItemId && link.role === "output"))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  /**
   * 把仍 in_progress 的出图子任务标为 completed，返回收尾条数。图像委派一律 completionPolicy=human，
   * 委派通过后子任务停在 in_progress 等人工验收；被下一轮修订接手或选定终稿后不会再有人去验收，
   * 不收尾父任务会一直被派生为「进行中」。keepWorkItemId 是仍在出图的当前轮，跳过；
   * 人工完成策略要求 actorId 为 human 且带说明。只改子任务状态，产物与资产链接不动。
   */
  completeImageChildren(
    task: WorkItem,
    options: { statusNote: string; actorId: string; keepWorkItemId?: string },
    children = this.children(task),
  ): number {
    let completed = 0;
    for (const child of children) {
      if (child.kind !== "image" || child.id === options.keepWorkItemId) continue;
      const fresh = this.database.getWorkItem(child.id);
      if (fresh.status !== "in_progress") continue;
      this.database.updateWorkItemAsActor({
        workItemId: fresh.id,
        status: "completed",
        expectedVersion: fresh.version,
        statusNote: options.statusNote,
        actorId: options.actorId,
      });
      completed += 1;
    }
    return completed;
  }

  /** 流水线全部图像子任务的 output 资产 id（去重，保持出现顺序）。 */
  pipelineOutputAssetIds(task: WorkItem, children = this.children(task)): string[] {
    if (!task.projectPath) return [];
    const ids: string[] = [];
    for (const child of children) {
      if (child.kind !== "image") continue;
      for (const asset of this.outputAssets(task.projectPath, child.id)) {
        if (!ids.includes(asset.id)) ids.push(asset.id);
      }
    }
    return ids;
  }
}
